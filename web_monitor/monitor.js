const { EventEmitter } = require("node:events");

const {
  createRawMonitorState,
  handleRawBinaryFrame,
  handleRawTextFrame,
  shouldSendHeartbeat,
} = require("../raw_table_monitor");
const { summarizeGameResult, tableInfoFromRecord } = require("../baccarat_one_monitor");
const { summarizeRound, summarizeTableResult } = require("./card_utils");

const DEFAULT_URL = "ws://6.zd10086.com/gate1/socket.io/?EIO=3&transport=websocket";

function firstField(record, fieldNo) {
  const values = (record.decoded?.bodyDecoded || [])
    .filter((item) => item.field === fieldNo)
    .map((item) => item.text ?? item.value ?? "");
  return values.length ? values[0] : "";
}

class AllVenueMonitor extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.options = {
      url: options.url || DEFAULT_URL,
      heartbeatLeadMs: Number(options.heartbeatLeadMs || 3000),
      reconnectMs: Number(options.reconnectMs || 3000),
    };
    this.videoArchive = options.videoArchive || null;
    this.state = createRawMonitorState({
      targetTable: "",
      heartbeatLeadMs: this.options.heartbeatLeadMs,
    });
    this.ws = null;
    this.running = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.tableByRoundId = new Map();
    this.tableByCode = new Map();
    this.status = {
      running: false,
      connected: false,
      url: this.options.url,
      startedAt: "",
      connectedAt: "",
      lastMessageAt: "",
      reconnects: 0,
      errors: 0,
      decodedTables: 0,
      decodedRounds: 0,
    };
  }

  start() {
    if (this.running) return;
    if (typeof WebSocket !== "function") {
      throw new Error("请使用 node --experimental-websocket server.js");
    }
    this.running = true;
    this.status.running = true;
    this.status.startedAt = new Date().toISOString();
    this.connect();
  }

  stop() {
    this.running = false;
    this.status.running = false;
    this.status.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
    if (this.videoArchive) {
      this.videoArchive.close();
    }
    this.ws = null;
  }

  connect() {
    if (!this.running) return;
    this.ws = new WebSocket(this.options.url);
    this.ws.addEventListener("open", () => this.onOpen());
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    this.ws.addEventListener("close", (event) => this.onClose(`closed:${event.code}:${event.reason || ""}`));
    this.ws.addEventListener("error", () => this.onClose("websocket error"));
  }

  onOpen() {
    this.status.connected = true;
    this.status.connectedAt = new Date().toISOString();
    this.store.saveEvent({ type: "socket_open", message: this.options.url });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeatIfNeeded(), 1000);
    this.emit("status", this.status);
  }

  sendHeartbeatIfNeeded() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (!shouldSendHeartbeat(this.state, now)) return;
    this.ws.send("2");
    this.state.lastHeartbeatAt = now;
    this.state.stats.heartbeatSent += 1;
  }

  async onMessage(event) {
    this.status.lastMessageAt = new Date().toISOString();
    if (typeof event.data === "string") {
      const update = handleRawTextFrame(this.state, event.data, this.status.lastMessageAt);
      if (update.kind === "handshake") {
        this.state.lastHeartbeatAt = Date.now();
      }
      return;
    }
    const arrayBuffer = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
    const payload = Buffer.from(arrayBuffer);
    const update = handleRawBinaryFrame(this.state, { payload, size: payload.length }, this.status.lastMessageAt);
    this.handleDecodedUpdate(update);
  }

  handleDecodedUpdate(update) {
    const record = update.record;
    if (!record?.decoded || record.decodeError) {
      if (record?.decodeError) {
        this.store.saveEvent({ type: "decode_error", message: record.decodeError, eventName: record.eventName });
      }
      return;
    }

    if (record.eventName === "TableInfoReplay") {
      const tableInfo = record.decoded.tableInfo || tableInfoFromRecord(record);
      const saved = this.store.saveTable(tableInfo);
      if (!saved) return;
      this.status.decodedTables += 1;
      this.tableByCode.set(String(saved.tableCode), saved);
      if (this.videoArchive) {
        this.videoArchive.observeTable(saved);
      }
      for (const roundId of saved.roundIds || []) {
        this.tableByRoundId.set(String(roundId), saved);
      }
      for (const round of roundsFromTableResults(saved, record.at)) {
        const existing = this.store.getRound(round.tableCode, round.roundId);
        if (existing && existing.source !== "TableInfoReplay.field8") {
          if (!existing.inningNumber && round.inningNumber) {
            const savedRound = this.store.saveRound({ ...existing, inningNumber: round.inningNumber });
            this.status.decodedRounds += 1;
            this.emit("round", savedRound);
          }
          continue;
        }
        if (existing?.result?.resultCode === round.result.resultCode) continue;
        const savedRound = this.store.saveRound(round);
        this.status.decodedRounds += 1;
        this.emit("round", savedRound);
      }
      this.emit("table", saved);
      return;
    }

    if (record.eventName === "GameInfoReplay") {
      const result = summarizeGameResult(record);
      const tableCode = String(firstField(record, 1) || "");
      const table = this.tableByCode.get(tableCode) || this.tableByRoundId.get(String(result.roundId)) || this.store.getTable(tableCode);
      const roundSummary = summarizeRound(result);
      const inningNumber = table ? inningNumberFromTable(table, result.roundId) : 0;
      const archivedVideo =
        this.videoArchive && table
          ? this.videoArchive.saveRoundVideo(table, {
              roundId: result.roundId,
              inningNumber,
              receivedAt: record.at,
            })
          : null;
      const roundVideo = archivedVideo?.ok && archivedVideo.url ? archivedVideo : null;
      if (archivedVideo && !roundVideo) {
        this.store.saveEvent({
          type: "round_video_failed",
          tableCode: table.tableCode,
          tableName: table.tableName,
          roundId: result.roundId,
          message: archivedVideo.error,
        });
      }
      const saved = this.store.saveRound({
        tableCode: table ? String(table.tableCode) : tableCode,
        tableName: table?.tableName || "",
        tableShortName: table?.tableShortName || "",
        roundId: result.roundId,
        ...(inningNumber ? { inningNumber } : {}),
        receivedAt: record.at,
        size: record.size,
        matchBy: table ? (String(table.tableCode) === tableCode ? "tableCode" : "roundId") : "",
        source: "GameInfoReplay",
        result,
        ...(roundVideo ? { roundVideo } : {}),
        ...roundSummary,
      });
      this.status.decodedRounds += 1;
      this.emit("round", saved);
    }
  }

  onClose(reason) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.status.connected = false;
    if (!this.running) return;
    this.status.errors += 1;
    this.status.reconnects += 1;
    this.store.saveEvent({ type: "socket_close", message: reason });
    this.emit("status", this.status);
    this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectMs);
  }

  getStatus() {
    return {
      ...this.status,
      socketStats: {
        ...this.state.stats,
        events: { ...this.state.stats.events },
      },
    };
  }
}

function roundsFromTableResults(table, receivedAt = new Date().toISOString()) {
  if (!isBaccaratTable(table)) return [];
  const roundIds = table.roundIds || [];
  const resultValues = table.resultValues || [];
  const rounds = [];
  for (let index = 0; index < Math.min(roundIds.length, resultValues.length); index += 1) {
    const roundId = String(roundIds[index] || "");
    const resultCode = String(resultValues[index] || "");
    const summary = summarizeTableResult(resultCode);
    if (!roundId || !summary) continue;
    rounds.push({
      tableCode: String(table.tableCode),
      tableName: table.tableName || "",
      tableShortName: table.tableShortName || "",
      roundId,
      inningNumber: index + 1,
      receivedAt,
      size: 0,
      matchBy: "tableResult",
      source: "TableInfoReplay.field8",
      result: { roundId, tableCode: String(table.tableCode), resultCode },
      ...summary,
    });
  }
  return rounds;
}

function isBaccaratTable(table) {
  return /百家乐|百|Baccarat|Bac/i.test([table.tableName || "", table.tableShortName || "", table.nameJson || ""].join(" "));
}

function inningNumberFromTable(table, roundId) {
  const index = (table.roundIds || []).map(String).indexOf(String(roundId || ""));
  return index >= 0 ? index + 1 : 0;
}

module.exports = {
  AllVenueMonitor,
  DEFAULT_URL,
  roundsFromTableResults,
};
