const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const {
  decodeSocketIoAttachment,
  extractVideoUrls,
  parseSocketIoText,
} = require("./socketio_probe");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function argValueFrom(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function buildCaptureOptions(args = process.argv.slice(2)) {
  return {
    port: Number(argValueFrom(args, "--port", "9222")),
    seconds: Number(argValueFrom(args, "--seconds", "300")),
    targetUrlHint: argValueFrom(args, "--target", "6.zd10086.com"),
    wsUrlHint: argValueFrom(args, "--ws-filter", "gate1/socket.io"),
    outDir: argValueFrom(args, "--out", path.join(__dirname, "recordings", `browser_ws_capture_${timestampForFile()}`)),
    reload: args.includes("--reload"),
  };
}

function timestampForFile() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_` +
    `${pad(now.getMilliseconds(), 3)}`
  );
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

function decodePayload(opcode, payloadData) {
  if (opcode === 2) {
    return Buffer.from(payloadData || "", "base64");
  }
  return Buffer.from(String(payloadData || ""), "utf8");
}

function saveFramePayload(framesDir, frameIndex, direction, opcode, payloadData) {
  const ext = opcode === 2 ? "bin" : "txt";
  const file = path.join(framesDir, `${String(frameIndex).padStart(6, "0")}_${direction}.${ext}`);
  const payload = decodePayload(opcode, payloadData);
  if (opcode === 2) {
    fs.writeFileSync(file, payload);
  } else {
    fs.writeFileSync(file, payload.toString("utf8"), "utf8");
  }
  return { file, payload };
}

function tryDecodeSocketIoBinary(payload, eventName) {
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
    throw new Error("请使用 node --experimental-websocket browser_ws_capture.js ...");
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
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)));
      } else {
        resolve(message.result);
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

async function main() {
  const { port, seconds, targetUrlHint, wsUrlHint, outDir, reload } = buildCaptureOptions();
  const framesDir = path.join(outDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  const targets = await httpJson(`http://127.0.0.1:${port}/json`);
  const page = targets.find((item) => item.type === "page" && String(item.url).includes(targetUrlHint)) || targets.find((item) => item.type === "page");
  if (!page) {
    throw new Error(`没有找到可抓取的 Chrome page target，请先打开目标网站。DevTools: http://127.0.0.1:${port}/json`);
  }

  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  const metaPath = path.join(outDir, "frames.jsonl");
  const summaryPath = path.join(outDir, "summary.json");
  const meta = fs.createWriteStream(metaPath, { encoding: "utf8" });
  const sockets = new Map();
  const pendingEvents = new Map();
  const stats = {
    pageUrl: page.url,
    title: page.title,
    targetId: page.id,
    outDir,
    startedAt: new Date().toISOString(),
    seconds,
    wsUrlHint,
    reload,
    sockets: {},
    frames: 0,
    matchedFrames: 0,
    sentFrames: 0,
    receivedFrames: 0,
    decodedBinaries: 0,
    decodeErrors: 0,
    events: {},
    videoUrls: {},
  };

  function getQueue(requestId, direction) {
    const key = `${requestId}:${direction}`;
    if (!pendingEvents.has(key)) {
      pendingEvents.set(key, []);
    }
    return pendingEvents.get(key);
  }

  function shouldCapture(requestId) {
    const socket = sockets.get(requestId);
    if (!socket) {
      return true;
    }
    return !wsUrlHint || wsUrlHint === "*" || socket.url.includes(wsUrlHint);
  }

  function handleFrame(direction, params) {
    stats.frames += 1;
    const socket = sockets.get(params.requestId) || { url: "(existing websocket, url unknown)" };
    const opcode = params.response.opcode;
    const payloadData = params.response.payloadData || "";
    const matched = shouldCapture(params.requestId);
    if (!matched) {
      return;
    }
    stats.matchedFrames += 1;
    if (direction === "sent") {
      stats.sentFrames += 1;
    } else {
      stats.receivedFrames += 1;
    }
    const { file, payload } = saveFramePayload(framesDir, stats.matchedFrames, direction, opcode, payloadData);
    const record = {
      direction,
      type: opcode === 2 ? "binary" : "text",
      receivedAt: new Date().toISOString(),
      requestId: params.requestId,
      wsUrl: socket.url,
      opcode,
      size: payload.length,
      rawPath: file,
      timestamp: params.timestamp,
    };

    if (opcode === 1) {
      const text = payload.toString("utf8");
      record.raw = text;
      if (text === "2" || text === "3") {
        record.socketIoControl = text === "2" ? "ping" : "pong";
      }
      const parsed = parseSocketIoText(text);
      if (parsed) {
        record.eventName = parsed.eventName;
        getQueue(params.requestId, direction).push(parsed.eventName);
        stats.events[`${direction}:${parsed.eventName}`] = (stats.events[`${direction}:${parsed.eventName}`] || 0) + 1;
      }
    } else if (opcode === 2) {
      const eventName = getQueue(params.requestId, direction).shift() || "";
      record.eventName = eventName;
      record.hexHead = payload.subarray(0, 64).toString("hex");
      try {
        record.decoded = tryDecodeSocketIoBinary(payload, eventName);
        stats.decodedBinaries += 1;
        for (const videoUrl of record.decoded.videoUrls) {
          stats.videoUrls[videoUrl] = (stats.videoUrls[videoUrl] || 0) + 1;
        }
      } catch (error) {
        stats.decodeErrors += 1;
        record.decodeError = error.message;
      }
    }
    writeJsonLine(meta, record);
  }

  cdp.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.method) {
      return;
    }
    const params = message.params || {};
    if (message.method === "Network.webSocketCreated") {
      sockets.set(params.requestId, { url: params.url, createdAt: new Date().toISOString() });
      if (params.url.includes(wsUrlHint)) {
        stats.sockets[params.requestId] = { url: params.url, createdAt: new Date().toISOString() };
        writeJsonLine(meta, { type: "webSocketCreated", receivedAt: new Date().toISOString(), requestId: params.requestId, url: params.url });
      }
    } else if (message.method === "Network.webSocketFrameSent") {
      handleFrame("sent", params);
    } else if (message.method === "Network.webSocketFrameReceived") {
      handleFrame("received", params);
    } else if (message.method === "Network.webSocketClosed") {
      const socket = sockets.get(params.requestId);
      if (socket && socket.url.includes(wsUrlHint)) {
        writeJsonLine(meta, { type: "webSocketClosed", receivedAt: new Date().toISOString(), requestId: params.requestId, url: socket.url, timestamp: params.timestamp });
      }
    }
  });

  await cdp.send("Network.enable");
  if (reload) {
    await cdp.send("Page.enable");
    await cdp.send("Page.reload", { ignoreCache: true });
  }
  console.log(JSON.stringify({ attachedTo: page.url, outDir, metaPath, summaryPath }, null, 2));
  const finish = () => {
    stats.finishedAt = new Date().toISOString();
    fs.writeFileSync(summaryPath, JSON.stringify(stats, null, 2), "utf8");
    meta.end();
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
  if (seconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    finish();
  } else {
    console.log("持续抓包中；关闭窗口或按 Ctrl+C 时会写 summary.json。");
    await new Promise(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCaptureOptions,
};
