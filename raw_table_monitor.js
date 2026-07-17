const fs = require("node:fs");
const path = require("node:path");

const {
  buildTargetMatcher,
  createTargetState,
  formatReadable,
  summarizeGameResult,
  tableInfoFromRecord,
  updateTargetState,
} = require("./baccarat_one_monitor");
const { decodeSocketIoAttachment, extractVideoUrls, parseSocketIoText } = require("./socketio_probe");

const DEFAULT_URL = "ws://6.zd10086.com/gate1/socket.io/?EIO=3&transport=websocket";

function timestampForFile() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function argValueFrom(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function buildOptions(args = process.argv.slice(2)) {
  const targetTable = argValueFrom(args, "--table", args[0] || "Q牛牛1号");
  const label = argValueFrom(args, "--label", safeLabel(targetTable));
  return {
    url: argValueFrom(args, "--url", DEFAULT_URL),
    targetTable,
    tableShort: argValueFrom(args, "--table-short", ""),
    tableCode: argValueFrom(args, "--table-code", ""),
    seconds: Number(argValueFrom(args, "--seconds", "0")),
    heartbeatLeadMs: Number(argValueFrom(args, "--heartbeat-lead-ms", "3000")),
    outDir: argValueFrom(args, "--out", path.join(__dirname, "recordings", `${label}_raw_monitor_${timestampForFile()}`)),
    label,
  };
}

function safeLabel(value) {
  const label = String(value || "target_table").replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, "_").replace(/^_+|_+$/g, "");
  return label || "target_table";
}

function parseEngineHandshake(text) {
  if (!String(text || "").startsWith("0")) {
    return null;
  }
  try {
    const payload = JSON.parse(String(text).slice(1));
    return {
      sid: String(payload.sid || ""),
      pingInterval: Number(payload.pingInterval || 25000),
      pingTimeout: Number(payload.pingTimeout || 5000),
    };
  } catch {
    return null;
  }
}

function createRawMonitorState(options = {}) {
  const targetState = createTargetState([options.tableCode || ""]);
  return {
    targetTable: options.targetTable || "Q牛牛1号",
    pendingEvents: [],
    pingIntervalMs: 25000,
    pingTimeoutMs: 5000,
    heartbeatLeadMs: Number(options.heartbeatLeadMs || 3000),
    lastHeartbeatAt: 0,
    targetMatcher: buildTargetMatcher({
      tableName: options.targetTable || "Q牛牛1号",
      tableShort: options.tableShort || "",
      tableCode: options.tableCode || "",
    }),
    targetState,
    roundIds: targetState.roundIds,
    tableCodes: targetState.tableCodes,
    stats: {
      text: 0,
      binary: 0,
      heartbeatSent: 0,
      heartbeatReceived: 0,
      matchedTables: 0,
      matchedResults: 0,
      decodeErrors: 0,
      events: {},
    },
  };
}

function shouldSendHeartbeat(state, nowMs = Date.now()) {
  const interval = Math.max(1000, Number(state.pingIntervalMs || 25000) - Number(state.heartbeatLeadMs || 3000));
  return nowMs - Number(state.lastHeartbeatAt || 0) >= interval;
}

function decodeSocketIoBinary(payload, eventName) {
  const decoded = decodeSocketIoAttachment(payload, eventName);
  const decrypted = Buffer.from(decoded.decryptedHex, "hex");
  return {
    eventGuess: eventName,
    account: decoded.webMessage.account,
    envelope: decoded.replayMessage ? "replayMessage" : "requestMessage",
    result: decoded.replayMessage ? decoded.replayMessage.result : decoded.requestMessage.result,
    session: decoded.replayMessage ? decoded.replayMessage.session : decoded.requestMessage.session,
    bodySize: decoded.replayMessage ? decoded.replayMessage.bodySize : decoded.requestMessage.bodySize,
    bodyDecoded: decoded.bodyDecoded,
    tableInfo: eventName === "TableInfoReplay" ? tableInfoFromDecoded(decoded.bodyDecoded, extractVideoUrls(decrypted)) : undefined,
    videoUrls: extractVideoUrls(decrypted),
    decryptedHexHead: decoded.decryptedHex.slice(0, 160),
  };
}

function tableInfoFromDecoded(bodyDecoded, videoUrls = []) {
  const fakeRecord = { decoded: { bodyDecoded } };
  const tableInfo = tableInfoFromRecord(fakeRecord);
  tableInfo.videoUrls = videoUrls;
  return tableInfo;
}

function handleRawTextFrame(state, text, at = new Date().toISOString()) {
  state.stats.text += 1;
  const handshake = parseEngineHandshake(text);
  if (handshake) {
    state.pingIntervalMs = handshake.pingInterval;
    state.pingTimeoutMs = handshake.pingTimeout;
    return { kind: "handshake", at, handshake };
  }
  if (text === "3") {
    state.stats.heartbeatReceived += 1;
    return { kind: "heartbeatPong", at };
  }
  if (text === "40") {
    return { kind: "socketOpen", at };
  }
  const parsed = parseSocketIoText(text);
  if (!parsed) {
    return { kind: "text", at, text };
  }
  state.pendingEvents.push(parsed.eventName);
  state.stats.events[parsed.eventName] = (state.stats.events[parsed.eventName] || 0) + 1;
  return { kind: "eventText", at, eventName: parsed.eventName, raw: text };
}

function handleRawBinaryFrame(state, input, at = new Date().toISOString()) {
  state.stats.binary += 1;
  const eventName = input.eventName || state.pendingEvents.shift() || "";
  const record = {
    direction: "received",
    type: "binary",
    at,
    eventName,
    size: input.payload ? input.payload.length : input.size || 0,
  };
  try {
    record.decoded = input.decoded || decodeSocketIoBinary(input.payload, eventName);
  } catch (error) {
    state.stats.decodeErrors += 1;
    record.decodeError = error.message;
    return { matched: false, kind: "decodeError", record };
  }

  const update = updateTargetState(state.targetState, record, state.targetMatcher);
  if (update.matched) {
    if (update.kind === "tableInfo") state.stats.matchedTables += 1;
    if (update.kind === "gameResult") state.stats.matchedResults += 1;
    return { ...update, roundId: update.roundId, record };
  }
  if (eventName === "GameInfoReplay") {
    return { matched: false, kind: "otherGameResult", result: summarizeGameResult(record), record };
  }
  return { matched: false, kind: eventName || "binary", record };
}

function writeJsonLine(stream, value) {
  stream.write(JSON.stringify(value) + "\n");
}

async function runRawMonitor(options = buildOptions()) {
  if (typeof WebSocket !== "function") {
    throw new Error("请使用 node --experimental-websocket raw_table_monitor.js ...");
  }
  fs.mkdirSync(options.outDir, { recursive: true });
  const allPath = path.join(options.outDir, "all_raw_socketio.jsonl");
  const matchedPath = path.join(options.outDir, `${options.label}_raw_matched.jsonl`);
  const logPath = path.join(options.outDir, `${options.label}_raw_readable.log`);
  const summaryPath = path.join(options.outDir, "summary.json");
  const all = fs.createWriteStream(allPath, { encoding: "utf8" });
  fs.writeFileSync(matchedPath, "", "utf8");
  fs.writeFileSync(logPath, "", "utf8");

  const state = createRawMonitorState(options);
  const ws = new WebSocket(options.url);
  let heartbeatTimer = null;
  let finishTimer = null;
  let finished = false;

  function emitMatched(update, record) {
    const output = { ...record, matchReason: update.kind, matchDetail: update };
    fs.appendFileSync(matchedPath, JSON.stringify(output) + "\n", "utf8");
    const line = formatReadable(output);
    fs.appendFileSync(logPath, line + "\n", "utf8");
    console.log(line);
  }

  function finish(reason = "finished") {
    if (finished) return;
    finished = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (finishTimer) clearTimeout(finishTimer);
    const summary = {
      reason,
      url: options.url,
      targetTable: options.targetTable,
      outDir: options.outDir,
      allPath,
      matchedPath,
      logPath,
      knownRoundIds: [...state.targetState.roundIds],
      knownTableCodes: [...state.targetState.tableCodes],
      stats: state.stats,
      finishedAt: new Date().toISOString(),
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    all.end();
    try {
      ws.close();
    } catch {}
    console.log(JSON.stringify({ done: true, summaryPath, stats: state.stats }, null, 2));
  }

  ws.addEventListener("open", () => {
    console.log(JSON.stringify({ connected: options.url, targetTable: options.targetTable, outDir: options.outDir, allPath, matchedPath, logPath }, null, 2));
    heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (!shouldSendHeartbeat(state, now)) return;
      ws.send("2");
      state.lastHeartbeatAt = now;
      state.stats.heartbeatSent += 1;
      writeJsonLine(all, { direction: "sent", type: "text", at: new Date().toISOString(), raw: "2", socketIoControl: "ping" });
    }, 1000);
  });

  ws.addEventListener("message", async (event) => {
    const at = new Date().toISOString();
    if (typeof event.data === "string") {
      const result = handleRawTextFrame(state, event.data, at);
      writeJsonLine(all, { direction: "received", type: "text", at, raw: event.data, ...result });
      if (result.kind === "handshake") {
        state.lastHeartbeatAt = Date.now();
      }
      return;
    }
    const arrayBuffer = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
    const payload = Buffer.from(arrayBuffer);
    const update = handleRawBinaryFrame(state, { payload, size: payload.length }, at);
    writeJsonLine(all, {
      direction: "received",
      type: "binary",
      at,
      eventName: update.record?.eventName || "",
      size: payload.length,
      hexHead: payload.subarray(0, 48).toString("hex"),
      decoded: update.record?.decoded,
      decodeError: update.record?.decodeError,
      match: { matched: update.matched, kind: update.kind, matchBy: update.matchBy, roundId: update.roundId },
    });
    if (update.matched) {
      emitMatched(update, update.record);
    }
  });

  ws.addEventListener("close", (event) => {
    writeJsonLine(all, { type: "close", at: new Date().toISOString(), code: event.code, reason: event.reason });
    finish(`closed:${event.code}`);
  });

  ws.addEventListener("error", (event) => {
    writeJsonLine(all, { type: "error", at: new Date().toISOString(), message: String(event.message || "websocket error") });
    finish("error");
  });

  process.on("SIGINT", () => {
    finish("SIGINT");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    finish("SIGTERM");
    process.exit(0);
  });
  if (options.seconds > 0) {
    finishTimer = setTimeout(() => finish("seconds"), options.seconds * 1000);
  }
}

if (require.main === module) {
  runRawMonitor().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildOptions,
  createRawMonitorState,
  handleRawBinaryFrame,
  handleRawTextFrame,
  parseEngineHandshake,
  runRawMonitor,
  shouldSendHeartbeat,
};
