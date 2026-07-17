const fs = require("node:fs");
const path = require("node:path");

const {
  decodeSocketIoAttachment,
  decryptConfigValue,
  extractVideoUrls,
  parseSocketIoText,
} = require("./socketio_probe");

const RAW_WEB_SECRET = "46tNyEi77HTO0sVXfBbKFg==";

function timestampForFile() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_` +
    `${pad(now.getMilliseconds(), 3)}`
  );
}

function isoNow() {
  return new Date().toISOString();
}

function writeJsonLine(stream, value) {
  stream.write(JSON.stringify(value, null, 0) + "\n");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const argValue = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  return {
    url: argValue("--url", "ws://6.zd10086.com/gate1/socket.io/?EIO=3&transport=websocket"),
    seconds: Number(argValue("--seconds", "300")),
    outDir: argValue("--out", path.join(__dirname, "recordings", `socketio_dump_${timestampForFile()}`)),
  };
}

function summarizeDecoded(bytes, eventName) {
  const decoded = decodeSocketIoAttachment(bytes, eventName);
  const webSecret = decryptConfigValue(RAW_WEB_SECRET);
  const plainBinary = Buffer.from(decoded.decryptedHex, "hex");
  return {
    account: decoded.webMessage.account,
    envelope: decoded.replayMessage ? "replayMessage" : "requestMessage",
    result: decoded.replayMessage ? decoded.replayMessage.result : decoded.requestMessage.result,
    session: decoded.replayMessage ? decoded.replayMessage.session : decoded.requestMessage.session,
    bodySize: decoded.replayMessage ? decoded.replayMessage.bodySize : decoded.requestMessage.bodySize,
    videoUrls: extractVideoUrls(plainBinary),
    decryptedHexHead: decoded.decryptedHex.slice(0, 160),
    webSecretLength: webSecret.length,
  };
}

async function dataToBuffer(data) {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (data && typeof data.arrayBuffer === "function") {
    return Buffer.from(await data.arrayBuffer());
  }
  return Buffer.from(String(data));
}

async function dumpSocketIo({ url, seconds, outDir }) {
  if (typeof WebSocket !== "function") {
    throw new Error("请使用 node --experimental-websocket socketio_dump.js ...");
  }
  fs.mkdirSync(outDir, { recursive: true });
  const framesDir = path.join(outDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  const metaPath = path.join(outDir, "frames.jsonl");
  const summaryPath = path.join(outDir, "summary.json");
  const meta = fs.createWriteStream(metaPath, { encoding: "utf8" });
  const pendingEvents = [];
  const startedAt = Date.now();
  const stats = {
    url,
    outDir,
    startedAt: new Date(startedAt).toISOString(),
    seconds,
    textFrames: 0,
    binaryFrames: 0,
    controlFrames: 0,
    decodedBinaries: 0,
    decodeErrors: 0,
    events: {},
    videoUrls: {},
  };

  const ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    writeJsonLine(meta, { direction: "in", type: "open", receivedAt: isoNow(), url });
  });
  ws.addEventListener("message", async (event) => {
    const receivedAt = isoNow();
    const data = event.data;
    if (typeof data === "string") {
      stats.textFrames += 1;
      if (data === "2") {
        ws.send("3");
        stats.controlFrames += 1;
        writeJsonLine(meta, { direction: "in", type: "ping", receivedAt, raw: data });
        writeJsonLine(meta, { direction: "out", type: "pong", sentAt: isoNow(), raw: "3" });
        return;
      }
      const parsed = parseSocketIoText(data);
      if (parsed) {
        pendingEvents.push(parsed.eventName);
        stats.events[parsed.eventName] = (stats.events[parsed.eventName] || 0) + 1;
      }
      const framePath = path.join(framesDir, `${String(stats.textFrames).padStart(6, "0")}_text.txt`);
      fs.writeFileSync(framePath, data, "utf8");
      writeJsonLine(meta, {
        direction: "in",
        type: "text",
        receivedAt,
        index: stats.textFrames,
        size: Buffer.byteLength(data),
        eventName: parsed ? parsed.eventName : "",
        rawPath: framePath,
        raw: data,
      });
      return;
    }

    const bytes = await dataToBuffer(data);
    stats.binaryFrames += 1;
    const pendingEvent = pendingEvents.shift() || "";
    const framePath = path.join(framesDir, `${String(stats.binaryFrames).padStart(6, "0")}_binary.bin`);
    fs.writeFileSync(framePath, bytes);
    const record = {
      direction: "in",
      type: "binary",
      receivedAt,
      index: stats.binaryFrames,
      size: bytes.length,
      eventName: pendingEvent,
      rawPath: framePath,
      hexHead: bytes.subarray(0, 64).toString("hex"),
    };
    try {
      record.decoded = summarizeDecoded(bytes, pendingEvent);
      stats.decodedBinaries += 1;
      for (const videoUrl of record.decoded.videoUrls) {
        stats.videoUrls[videoUrl] = (stats.videoUrls[videoUrl] || 0) + 1;
      }
    } catch (error) {
      stats.decodeErrors += 1;
      record.decodeError = error.message;
    }
    writeJsonLine(meta, record);
  });
  ws.addEventListener("close", () => {
    writeJsonLine(meta, { direction: "in", type: "close", receivedAt: isoNow() });
  });
  ws.addEventListener("error", (error) => {
    writeJsonLine(meta, { direction: "in", type: "error", receivedAt: isoNow(), error: error.message || error.type || String(error) });
  });

  while (Date.now() - startedAt < seconds * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  ws.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  stats.finishedAt = isoNow();
  fs.writeFileSync(summaryPath, JSON.stringify(stats, null, 2), "utf8");
  meta.end();
  console.log(JSON.stringify({ outDir, metaPath, summaryPath, stats }, null, 2));
}

if (require.main === module) {
  dumpSocketIo(parseArgs()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
