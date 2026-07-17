const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const {
  decodeSocketIoAttachment,
  extractVideoUrls,
  parseSocketIoText,
} = require("./socketio_probe");

function timestampForFile() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_` +
    `${pad(now.getMilliseconds(), 3)}`
  );
}

function argValueFrom(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function buildOptions(args = process.argv.slice(2)) {
  const label = argValueFrom(args, "--label", "qniuniu1");
  return {
    port: Number(argValueFrom(args, "--port", "9222")),
    seconds: Number(argValueFrom(args, "--seconds", "0")),
    targetUrlHint: argValueFrom(args, "--target", "6.zd10086.com"),
    wsUrlHint: argValueFrom(args, "--ws-filter", "gate1/socket.io"),
    outDir: argValueFrom(args, "--out", path.join(__dirname, "recordings", `${label}_monitor_${timestampForFile()}`)),
    label,
    tableName: argValueFrom(args, "--table-name", "Q牛牛1号"),
    tableShort: argValueFrom(args, "--table-short", "牛1"),
    tableCode: argValueFrom(args, "--table-code", "47"),
    reload: args.includes("--reload"),
  };
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`JSON parse failed from ${url}: ${error.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function writeJsonLine(stream, value) {
  stream.write(JSON.stringify(value) + "\n");
}

function formatBeijingTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (number, size = 2) => String(number).padStart(size, "0");
  return (
    `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ` +
    `${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}.` +
    `${pad(beijing.getUTCMilliseconds(), 3)} 北京时间`
  );
}

function decodePayload(opcode, payloadData) {
  if (opcode === 2) {
    return Buffer.from(payloadData || "", "base64");
  }
  return Buffer.from(String(payloadData || ""), "utf8");
}

function fieldValues(record, fieldNo) {
  return (record.decoded?.bodyDecoded || [])
    .filter((item) => item.field === fieldNo)
    .map((item) => item.text ?? item.value ?? "");
}

function firstField(record, fieldNo) {
  const values = fieldValues(record, fieldNo);
  return values.length > 0 ? values[0] : "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDigitBoundaryText(text, target) {
  if (!target) return false;
  return new RegExp(`(^|[^0-9])${escapeRegExp(target)}([^0-9]|$)`).test(String(text || ""));
}

function buildTargetMatcher(options = {}) {
  const tableName = String(options.tableName || "").trim();
  const tableShort = String(options.tableShort || "").trim();
  const expectedCode = options.tableCode === "" || options.tableCode === undefined || options.tableCode === null ? null : Number(options.tableCode);

  return function matchesTargetTable(tableInfo = {}) {
    const actualCode = Number(tableInfo.tableCode);
    if (expectedCode !== null && Number.isFinite(actualCode) && actualCode === expectedCode) {
      return true;
    }
    if (tableName && String(tableInfo.tableName || "") === tableName) {
      return true;
    }
    if (tableShort && String(tableInfo.tableShortName || "") === tableShort) {
      return true;
    }
    const text = [
      tableInfo.tableName || "",
      tableInfo.tableShortName || "",
      tableInfo.nameJson || "",
    ].join(" ");
    return hasDigitBoundaryText(text, tableName) || hasDigitBoundaryText(text, tableShort);
  };
}

function isBaccaratOneTable(tableInfo = {}) {
  const text = [
    tableInfo.tableName || "",
    tableInfo.tableShortName || "",
    tableInfo.nameJson || "",
  ].join(" ");
  return (
    /(^|[^0-9])百家乐1号([^0-9]|$)/.test(text) ||
    /(^|[^0-9])百\s*1([^0-9]|$)/.test(text) ||
    /(^|[^0-9])Baccarat\s*1([^0-9]|$)/i.test(text) ||
    /(^|[^0-9])Bac\s*1([^0-9]|$)/i.test(text)
  );
}

function tableInfoFromRecord(record) {
  const info = record.decoded?.tableInfo;
  if (info) {
    const resultValues = fieldValues(record, 8).map(String);
    if (info.resultValues || !resultValues.length) return info;
    return { ...info, resultValues };
  }
  return {
    tableName: String(firstField(record, 5) || ""),
    tableShortName: String(firstField(record, 20) || ""),
    tableCode: firstField(record, 2),
    internalIp: String(firstField(record, 15) || ""),
    countdownOrStatus: firstField(record, 19),
    dealerId: firstField(record, 28),
    dealerName: String(firstField(record, 29) || ""),
    dealerImage: String(firstField(record, 34) || ""),
    resultValues: fieldValues(record, 8).map(String),
    roundIds: fieldValues(record, 30).map(String).filter(Boolean),
    limitJson: String(firstField(record, 35) || ""),
    nameJson: String(firstField(record, 36) || ""),
  };
}

function summarizeNiuNiuResult(field13) {
  if (!field13) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(field13);
  } catch {
    return [];
  }
  return Object.entries(parsed)
    .filter(([, value]) => value && typeof value === "object" && value.type)
    .map(([index, value]) => ({
      index,
      type: String(value.type),
      value: value.value,
      win: value.win,
      pokerTypeCode: value.pokerTypeCode,
    }));
}

function parseCardArray(text) {
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((item) => String(item || "")).filter(Boolean);
  } catch {
    return [];
  }
}

const POKER_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function decodePokerCode(code) {
  const text = String(code || "");
  if (text.length !== 1) {
    return text;
  }
  const ascii = text.charCodeAt(0);
  if (ascii >= 65 && ascii <= 77) {
    return `黑桃${POKER_RANKS[ascii - 65]}`;
  }
  if (ascii >= 78 && ascii <= 90) {
    return `红桃${POKER_RANKS[ascii - 78]}`;
  }
  if (ascii >= 97 && ascii <= 109) {
    return `梅花${POKER_RANKS[ascii - 97]}`;
  }
  if (ascii >= 110 && ascii <= 122) {
    return `方块${POKER_RANKS[ascii - 110]}`;
  }
  return text;
}

function decodePokerCodes(codes) {
  return (codes || []).map(decodePokerCode);
}

function summarizeBaccaratCards(field11, field12, field9 = "", field10 = "") {
  const banker = parseCardArray(field11);
  const player = parseCardArray(field12);
  return {
    banker,
    player,
    bankerReadable: decodePokerCodes(banker),
    playerReadable: decodePokerCodes(player),
    bankerPoint: field9,
    playerPoint: field10,
  };
}

function summarizeGameResult(record) {
  const field13 = String(firstField(record, 13) || "");
  const field9 = firstField(record, 9);
  const field10 = firstField(record, 10);
  const field11 = String(firstField(record, 11) || "");
  const field12 = String(firstField(record, 12) || "");
  return {
    roundId: String(firstField(record, 0) || ""),
    tableCode: firstField(record, 1),
    field9,
    field10,
    field11,
    field12,
    field13,
    field14: String(firstField(record, 14) || ""),
    niuniu: summarizeNiuNiuResult(field13),
    baccarat: summarizeBaccaratCards(field11, field12, field9, field10),
  };
}

function createTargetState(tableCodes = []) {
  const codeSet = new Set();
  for (const code of tableCodes) {
    if (code === "" || code === undefined || code === null) {
      continue;
    }
    const numeric = Number(code);
    if (Number.isFinite(numeric)) {
      codeSet.add(numeric);
    }
  }
  return {
    roundIds: new Set(),
    lastTableInfo: null,
    tableCodes: codeSet,
    matchedTables: 0,
    matchedResults: 0,
  };
}

function createBaccaratOneState() {
  return createTargetState();
}

function updateTargetState(state, record, matchesTargetTable) {
  if (record.eventName === "TableInfoReplay" && record.decoded) {
    const tableInfo = tableInfoFromRecord(record);
    if (!matchesTargetTable(tableInfo)) {
      return { matched: false };
    }
    for (const roundId of tableInfo.roundIds || []) {
      state.roundIds.add(roundId);
    }
    if (tableInfo.tableCode !== "" && tableInfo.tableCode !== undefined && tableInfo.tableCode !== null) {
      state.tableCodes.add(Number(tableInfo.tableCode));
    }
    state.lastTableInfo = tableInfo;
    state.matchedTables += 1;
    return {
      matched: true,
      kind: "tableInfo",
      tableInfo,
      videoUrls: record.decoded.videoUrls || [],
    };
  }

  if (record.eventName === "GameInfoReplay" && record.decoded) {
    const result = summarizeGameResult(record);
    const gameTableCode = Number(firstField(record, 1));
    const matchByRoundId = result.roundId && state.roundIds.has(result.roundId);
    const matchByTableCode = Number.isFinite(gameTableCode) && state.tableCodes.has(gameTableCode);
    if (!matchByRoundId && !matchByTableCode) {
      return { matched: false };
    }
    state.matchedResults += 1;
    return {
      matched: true,
      kind: "gameResult",
      matchBy: matchByRoundId ? "roundId" : "tableCode",
      roundId: result.roundId,
      result,
      tableInfo: state.lastTableInfo,
    };
  }

  return { matched: false };
}

function updateBaccaratOneState(state, record) {
  return updateTargetState(state, record, isBaccaratOneTable);
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
    videoUrls: extractVideoUrls(decrypted),
    decryptedHexHead: decoded.decryptedHex.slice(0, 160),
  };
}

async function connectCdp(webSocketDebuggerUrl) {
  if (typeof WebSocket !== "function") {
    throw new Error("请使用 node --experimental-websocket baccarat_one_monitor.js ...");
  }
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        task.reject(new Error(JSON.stringify(message.error)));
      } else {
        task.resolve(message.result);
      }
    }
  });
  return {
    ws,
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
  };
}

async function runMonitor(options = buildOptions()) {
  fs.mkdirSync(options.outDir, { recursive: true });
  const allPath = path.join(options.outDir, "all_sent_received.jsonl");
  const matchedPath = path.join(options.outDir, `${options.label}_messages.jsonl`);
  const unmatchedGamePath = path.join(options.outDir, "unmatched_gameinfo.jsonl");
  const logPath = path.join(options.outDir, `${options.label}_readable.log`);
  const summaryPath = path.join(options.outDir, "summary.json");
  const all = fs.createWriteStream(allPath, { encoding: "utf8" });
  fs.writeFileSync(matchedPath, "", "utf8");
  fs.writeFileSync(unmatchedGamePath, "", "utf8");
  fs.writeFileSync(logPath, "", "utf8");
  const targets = await httpJson(`http://127.0.0.1:${options.port}/json`);
  const page = targets.find((item) => item.type === "page" && String(item.url).includes(options.targetUrlHint)) || targets.find((item) => item.type === "page");
  if (!page) {
    throw new Error(`没有找到 Chrome 页面，请先打开 http://6.zd10086.com/，DevTools: http://127.0.0.1:${options.port}/json`);
  }

  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  const sockets = new Map();
  const pendingEvents = new Map();
  const pendingTextRecords = new Map();
  const targetMatcher = buildTargetMatcher(options);
  const state = createTargetState([options.tableCode]);
  const tableByRoundId = new Map();
  const tableByCode = new Map();
  const stats = {
    startedAt: new Date().toISOString(),
    pageUrl: page.url,
    outDir: options.outDir,
    allPath,
    matchedPath,
    unmatchedGamePath,
    logPath,
    sent: 0,
    received: 0,
    matched: 0,
    matchedTables: 0,
    matchedResults: 0,
    unmatchedGameInfoReplay: 0,
    decodeErrors: 0,
    events: {},
  };

  function queueKey(requestId, direction) {
    return `${requestId}:${direction}`;
  }

  function eventQueue(requestId, direction) {
    const key = queueKey(requestId, direction);
    if (!pendingEvents.has(key)) {
      pendingEvents.set(key, []);
    }
    return pendingEvents.get(key);
  }

  function textQueue(requestId, direction) {
    const key = queueKey(requestId, direction);
    if (!pendingTextRecords.has(key)) {
      pendingTextRecords.set(key, []);
    }
    return pendingTextRecords.get(key);
  }

  function shouldCapture(requestId) {
    const socket = sockets.get(requestId);
    return !socket || socket.url.includes(options.wsUrlHint);
  }

  function emitMatched(record, reason, detail = {}) {
    stats.matched += 1;
    const output = { ...record, matchReason: reason, matchDetail: detail };
    fs.appendFileSync(matchedPath, JSON.stringify(output) + "\n", "utf8");
    const line = formatReadable(output);
    fs.appendFileSync(logPath, line + "\n", "utf8");
    console.log(line);
  }

  function emitUnmatchedGameInfo(record) {
    const result = summarizeGameResult(record);
    if (!result.roundId) {
      return;
    }
    const tableCode = Number(firstField(record, 1));
    const owner = tableByRoundId.get(result.roundId) || tableByCode.get(tableCode) || null;
    stats.unmatchedGameInfoReplay += 1;
    const output = {
      at: record.at,
      eventName: record.eventName,
      roundId: result.roundId,
      tableCode,
      owner,
      result,
      reason: "roundId/tableCode not matched target table",
    };
    fs.appendFileSync(unmatchedGamePath, JSON.stringify(output) + "\n", "utf8");
  }

  function rememberTableOwner(record) {
    if (record.eventName !== "TableInfoReplay" || !record.decoded) {
      return;
    }
    const info = tableInfoFromRecord(record);
    const owner = {
      tableName: info.tableName,
      tableShortName: info.tableShortName,
      tableCode: info.tableCode,
      internalIp: info.internalIp,
    };
    if (info.tableCode !== "" && info.tableCode !== undefined && info.tableCode !== null) {
      tableByCode.set(Number(info.tableCode), owner);
    }
    for (const roundId of info.roundIds || []) {
      tableByRoundId.set(roundId, owner);
    }
  }

  function handleFrame(direction, params) {
    if (!shouldCapture(params.requestId)) {
      return;
    }
    const socket = sockets.get(params.requestId) || { url: "(existing websocket, url unknown)" };
    const opcode = params.response.opcode;
    const payload = decodePayload(opcode, params.response.payloadData || "");
    const record = {
      direction,
      type: opcode === 2 ? "binary" : "text",
      at: new Date().toISOString(),
      requestId: params.requestId,
      wsUrl: socket.url,
      eventName: "",
      size: payload.length,
    };

    if (direction === "sent") stats.sent += 1;
    if (direction === "received") stats.received += 1;

    if (opcode === 1) {
      record.raw = payload.toString("utf8");
      const parsed = parseSocketIoText(record.raw);
      if (parsed) {
        record.eventName = parsed.eventName;
        eventQueue(params.requestId, direction).push(parsed.eventName);
        textQueue(params.requestId, direction).push(record);
        stats.events[`${direction}:${record.eventName}`] = (stats.events[`${direction}:${record.eventName}`] || 0) + 1;
      }
    } else {
      record.eventName = eventQueue(params.requestId, direction).shift() || "";
      record.hexHead = payload.subarray(0, 48).toString("hex");
      try {
        record.decoded = decodeSocketIoBinary(payload, record.eventName);
      } catch (error) {
        stats.decodeErrors += 1;
        record.decodeError = error.message;
      }
    }

    writeJsonLine(all, record);
    rememberTableOwner(record);

    if (direction === "sent") {
      return;
    }

    const update = updateTargetState(state, record, targetMatcher);
    if (update.matched) {
      if (update.kind === "tableInfo") stats.matchedTables += 1;
      if (update.kind === "gameResult") stats.matchedResults += 1;
      const textRecord = textQueue(params.requestId, direction).shift();
      if (textRecord && textRecord.eventName === record.eventName) {
        emitMatched(textRecord, `${update.kind}:eventText`);
      }
      emitMatched(record, update.kind, update);
    } else if (record.eventName === "GameInfoReplay" && record.decoded) {
      emitUnmatchedGameInfo(record);
    }
  }

  cdp.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.method) return;
    const params = message.params || {};
    if (message.method === "Network.webSocketCreated") {
      sockets.set(params.requestId, { url: params.url });
      if (params.url.includes(options.wsUrlHint)) {
        writeJsonLine(all, { type: "webSocketCreated", at: new Date().toISOString(), requestId: params.requestId, url: params.url });
      }
    } else if (message.method === "Network.webSocketFrameSent") {
      handleFrame("sent", params);
    } else if (message.method === "Network.webSocketFrameReceived") {
      handleFrame("received", params);
    } else if (message.method === "Network.webSocketClosed") {
      const socket = sockets.get(params.requestId);
      if (socket && socket.url.includes(options.wsUrlHint)) {
        writeJsonLine(all, { type: "webSocketClosed", at: new Date().toISOString(), requestId: params.requestId, url: socket.url });
      }
    }
  });

  await cdp.send("Network.enable");
  if (options.reload) {
    await cdp.send("Page.enable");
    await cdp.send("Page.reload", { ignoreCache: true });
  }
  console.log(JSON.stringify({ attachedTo: page.url, outDir: options.outDir, allPath, matchedPath, unmatchedGamePath, logPath }, null, 2));

  const finish = () => {
    stats.finishedAt = new Date().toISOString();
    stats.knownRoundIds = [...state.roundIds];
    stats.knownTableCodes = [...state.tableCodes];
    fs.writeFileSync(summaryPath, JSON.stringify(stats, null, 2), "utf8");
    all.end();
    cdp.ws.close();
    console.log(JSON.stringify({ done: true, summaryPath, stats }, null, 2));
  };

  process.on("SIGINT", () => {
    finish();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    finish();
    process.exit(0);
  });
  if (options.seconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.seconds * 1000));
    finish();
  } else {
    console.log(`正在监听${options.tableName}/${options.tableShort}；按 Ctrl+C 停止并写入 summary.json。`);
    await new Promise(() => {});
  }
}

function formatReadable(record) {
  const dir = record.direction === "sent" ? "发送" : "接收";
  const parts = [`[${formatBeijingTime(record.at)}] ${dir} ${record.eventName || record.type} size=${record.size}`];
  if (record.matchReason) parts.push(`原因=${record.matchReason}`);
  if (record.raw && record.direction !== "sent") parts.push(`文本=${record.raw}`);
  if (record.matchDetail?.tableInfo) {
    const t = record.matchDetail.tableInfo;
    parts.push(`桌台=${t.tableName || ""}/${t.tableShortName || ""}`);
    if (t.tableCode !== "" && t.tableCode !== undefined && t.tableCode !== null) {
      parts.push(`桌台编号=${t.tableCode}`);
    }
    parts.push(`局数=${(t.roundIds || []).length}`);
  }
  if (record.matchDetail?.result) {
    const r = record.matchDetail.result;
    const baccarat = r.baccarat || summarizeBaccaratCards(r.field11, r.field12, r.field9, r.field10);
    if (record.matchDetail.matchBy) {
      parts.push(`匹配=${record.matchDetail.matchBy}`);
    }
    parts.push(`局号=${r.roundId}`);
    if (r.niuniu?.length) {
      parts.push(`结果=${r.niuniu.map((item) => item.type).join(",")}`);
      parts.push(`详情=${r.niuniu.map((item) => `座位${item.index}:value=${item.value},win=${item.win},pokerTypeCode=${item.pokerTypeCode}`).join(";")}`);
    } else if (baccarat && (baccarat.banker.length || baccarat.player.length)) {
      const bankerReadable = baccarat.bankerReadable || decodePokerCodes(baccarat.banker);
      const playerReadable = baccarat.playerReadable || decodePokerCodes(baccarat.player);
      parts.push(`百家乐`);
      parts.push(`庄点=${baccarat.bankerPoint}`);
      parts.push(`闲点=${baccarat.playerPoint}`);
      parts.push(`庄牌=${bankerReadable.join(",") || "-"}`);
      parts.push(`闲牌=${playerReadable.join(",") || "-"}`);
      parts.push(`原始牌=庄[${baccarat.banker.join(",")}],闲[${baccarat.player.join(",")}]`);
      parts.push(`原始字段=${JSON.stringify({ field9: r.field9, field10: r.field10 })}`);
    } else {
      parts.push(`结果=${JSON.stringify({ field9: r.field9, field10: r.field10 })}`);
    }
    if (r.field14 && r.field14 !== "[[],[],[],[],[]]") {
      parts.push(`牌=${r.field14}`);
    }
  }
  if (record.decoded?.videoUrls?.length) {
    parts.push(`视频=${record.decoded.videoUrls.join(",")}`);
  }
  if (record.decodeError) parts.push(`解码失败=${record.decodeError}`);
  return parts.join(" | ");
}

function formatUnmatchedGameInfo(output) {
  const owner = output.owner;
  const ownerText = owner ? `${owner.tableName || ""}/${owner.tableShortName || ""}/编号${owner.tableCode}` : "未知桌台";
  return [
    `[${output.at}] 接收 GameInfoReplay`,
    `非百家乐1号`,
    `归属=${ownerText}`,
    `局号=${output.roundId}`,
    `结果字段=${JSON.stringify({
      field9: output.result.field9,
      field10: output.result.field10,
      field11: output.result.field11,
      field12: output.result.field12,
      field13: output.result.field13,
      field14: output.result.field14,
    })}`,
  ].join(" | ");
}

if (require.main === module) {
  runMonitor().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildOptions,
  buildTargetMatcher,
  createBaccaratOneState,
  createTargetState,
  decodePokerCode,
  decodePokerCodes,
  formatBeijingTime,
  formatReadable,
  isBaccaratOneTable,
  summarizeBaccaratCards,
  summarizeGameResult,
  summarizeNiuNiuResult,
  tableInfoFromRecord,
  updateBaccaratOneState,
  updateTargetState,
};
