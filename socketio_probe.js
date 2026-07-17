const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const URL_SECRET = "00ef7115ac13a644fc94d4cfbea3fdb3";
const URL_IV = "3cfea36143992164";
const ENCRYPT_CODE_PATH = path.join(__dirname, "encryptCode.js");
const RAW_WEB_SECRET = "46tNyEi77HTO0sVXfBbKFg==";

function getEncryptCode() {
  global.window = global;
  const mod = require(ENCRYPT_CODE_PATH);
  const Klass = mod.default || mod;
  return new Klass();
}

function decryptConfigValue(value) {
  return getEncryptCode().decryptStr(value, URL_SECRET, URL_IV);
}

function decodeAesOpenSslBase64(ciphertext, passphrase) {
  return getEncryptCode().decodeAES(ciphertext, passphrase);
}

function stringToBytes(binaryString) {
  const bytes = Buffer.alloc(binaryString.length);
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  for (let pos = offset; pos < buffer.length; pos += 1) {
    const byte = buffer[pos];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value, offset: pos + 1 };
    }
    shift += 7;
  }
  throw new Error("bad protobuf varint");
}

function readProtoFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const field = tag.value >>> 3;
    const wireType = tag.value & 7;
    if (wireType === 0) {
      const item = readVarint(buffer, offset);
      offset = item.offset;
      fields.push({ field, wireType, value: item.value });
    } else if (wireType === 2) {
      const len = readVarint(buffer, offset);
      offset = len.offset;
      const value = buffer.subarray(offset, offset + len.value);
      offset += len.value;
      fields.push({ field, wireType, value });
    } else if (wireType === 1) {
      fields.push({ field, wireType, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 5) {
      fields.push({ field, wireType, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
  return fields;
}

function fieldBuffer(fields, field) {
  const item = fields.find((entry) => entry.field === field && entry.wireType === 2);
  return item ? item.value : Buffer.alloc(0);
}

function fieldString(fields, field) {
  return fieldBuffer(fields, field).toString("utf8");
}

function fieldVarint(fields, field) {
  const item = fields.find((entry) => entry.field === field && entry.wireType === 0);
  return item ? item.value : 0;
}

function decodeWebMessage(buffer) {
  const fields = readProtoFields(buffer);
  return {
    msg: fieldString(fields, 0),
    account: fieldString(fields, 1),
  };
}

function decodeRequestMessage(buffer) {
  const fields = readProtoFields(buffer);
  const headFields = readProtoFields(fieldBuffer(fields, 0));
  return {
    session: fieldString(headFields, 0),
    body: fieldBuffer(fields, 1),
  };
}

function decodeAuthRequest(buffer) {
  const fields = readProtoFields(buffer);
  return {
    account: fieldString(fields, 1),
    token: fieldString(fields, 2),
    clientType: fieldVarint(fields, 3),
    version: fieldString(fields, 4),
  };
}

function decodeReplayMessage(buffer) {
  const fields = readProtoFields(buffer);
  const headFields = readProtoFields(fieldBuffer(fields, 0));
  return {
    result: fieldVarint(headFields, 0),
    session: fieldString(headFields, 1),
    body: fieldBuffer(fields, 1),
  };
}

function socketIoPayloadBytes(input) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(String(input).trim(), "base64");
  if (raw.length > 0 && raw[0] === 0x04) {
    return raw.subarray(1);
  }
  return raw;
}

function decodeSocketIoAttachment(input, eventName = "AuthRequest") {
  const webSecret = decryptConfigValue(RAW_WEB_SECRET);
  const webMessage = decodeWebMessage(socketIoPayloadBytes(input));
  const plain = stringToBytes(decodeAesOpenSslBase64(webMessage.msg, webSecret));
  const message = decodeEnvelope(plain, eventName);
  const bodyDecoded = eventName === "AuthRequest" ? decodeAuthRequest(message.body) : decodeGenericProto(message.body);
  return {
    webMessage,
    [message.kind]: {
      result: message.result,
      session: message.session,
      bodySize: message.body.length,
    },
    eventGuess: eventName,
    bodyDecoded,
    decryptedHex: plain.toString("hex"),
  };
}

function decodeEnvelope(buffer, eventName) {
  if (eventName.endsWith("Reply") || eventName.endsWith("Replay")) {
    const replay = decodeReplayMessage(buffer);
    return {
      kind: "replayMessage",
      result: replay.result,
      session: replay.session,
      body: replay.body,
    };
  }
  const request = decodeRequestMessage(buffer);
  return {
    kind: "requestMessage",
    result: undefined,
    session: request.session,
    body: request.body,
  };
}

function decodeGenericProto(buffer) {
  return readProtoFields(buffer).map((item) => {
    if (item.wireType === 2) {
      return {
        field: item.field,
        wireType: item.wireType,
        size: item.value.length,
        text: printableText(item.value),
        hexHead: item.value.subarray(0, 32).toString("hex"),
      };
    }
    return item;
  });
}

function printableText(buffer) {
  const text = buffer.toString("utf8");
  if (/^[\x09\x0a\x0d\x20-\x7e\u4e00-\u9fff]*$/.test(text)) {
    return text;
  }
  return "";
}

function collectStringsFromProto(buffer, out = []) {
  let fields;
  try {
    fields = readProtoFields(buffer);
  } catch (_) {
    return out;
  }
  for (const item of fields) {
    if (item.wireType !== 2) {
      continue;
    }
    const text = printableText(item.value);
    if (text) {
      out.push(text);
    }
    if (item.value.length > 1) {
      collectStringsFromProto(item.value, out);
    }
  }
  return out;
}

function extractVideoUrls(buffer) {
  return [...new Set(collectStringsFromProto(buffer).filter((text) => /^wss?:\/\//.test(text)))];
}

function parseSocketIoText(text) {
  const raw = String(text);
  const jsonStart = raw.indexOf("[");
  if (jsonStart < 0 || !/^\d/.test(raw)) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw.slice(jsonStart));
    return { eventName: Array.isArray(parsed) ? parsed[0] : "", payload: parsed };
  } catch (_) {
    return null;
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function runLive(url, durationMs) {
  if (typeof WebSocket !== "function") {
    throw new Error("当前 Node 未启用 WebSocket，请用 node --experimental-websocket socketio_probe.js ...");
  }
  const pendingEvents = [];
  const started = Date.now();
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => console.log(`[open] ${url}`));
  ws.addEventListener("message", async (event) => {
    const data = event.data;
    if (typeof data === "string") {
      if (data === "2") {
        ws.send("3");
        console.log("[ping] pong sent");
        return;
      }
      const parsed = parseSocketIoText(data);
      if (parsed) {
        pendingEvents.push(parsed.eventName);
        console.log(`[text] event=${parsed.eventName} raw=${data}`);
      } else {
        console.log(`[text] ${data}`);
      }
      return;
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    const pendingEvent = pendingEvents.shift() || "";
    try {
      const decoded = decodeSocketIoAttachment(bytes, pendingEvent);
      const urls = extractVideoUrls(stringToBytes(decodeAesOpenSslBase64(decoded.webMessage.msg, decryptConfigValue(RAW_WEB_SECRET))));
      printJson({
        binaryEvent: pendingEvent,
        account: decoded.webMessage.account,
        envelope: decoded.replayMessage ? "replayMessage" : "requestMessage",
        result: decoded.replayMessage ? decoded.replayMessage.result : decoded.requestMessage.result,
        session: decoded.replayMessage ? decoded.replayMessage.session : decoded.requestMessage.session,
        bodySize: decoded.replayMessage ? decoded.replayMessage.bodySize : decoded.requestMessage.bodySize,
        videoUrls: urls,
      });
    } catch (error) {
      console.log(`[binary] size=${bytes.length} decode_error=${error.message}`);
    }
  });
  ws.addEventListener("close", () => console.log("[close]"));
  ws.addEventListener("error", (error) => console.log(`[error] ${error.message || error.type || error}`));
  while (Date.now() - started < durationMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  ws.close();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--secrets")) {
    printJson({
      DEF_SECRET: decryptConfigValue("iXyWUVyBdI/a8SCOCapFGw=="),
      WEB_SECRET: decryptConfigValue(RAW_WEB_SECRET),
      PAY_SECRET: decryptConfigValue("o3R/lB6AzJHwrtf59K0Gaw=="),
      VIDEO_URL: decryptConfigValue("bvg+guK0U9HuplptwRQhPfupNyznrHDwKqXskJoBBJfxTj2f3mPmgOs752eD9GkX"),
    });
    return;
  }
  const attachmentIndex = args.indexOf("--attachment");
  if (attachmentIndex >= 0) {
    printJson(decodeSocketIoAttachment(args[attachmentIndex + 1], args[args.indexOf("--event") + 1] || "AuthRequest"));
    return;
  }
  const fileIndex = args.indexOf("--file");
  if (fileIndex >= 0) {
    const eventIndex = args.indexOf("--event");
    printJson(decodeSocketIoAttachment(fs.readFileSync(args[fileIndex + 1]), eventIndex >= 0 ? args[eventIndex + 1] : "AuthRequest"));
    return;
  }
  const urlIndex = args.indexOf("--url");
  if (urlIndex >= 0) {
    const secondsIndex = args.indexOf("--seconds");
    const seconds = secondsIndex >= 0 ? Number(args[secondsIndex + 1]) : 120;
    await runLive(args[urlIndex + 1], seconds * 1000);
    return;
  }
  console.log("用法:");
  console.log("  node socketio_probe.js --secrets");
  console.log("  node socketio_probe.js --attachment <base64> --event AuthRequest");
  console.log("  node socketio_probe.js --file <binary.bin> --event AuthRequest");
  console.log("  node socketio_probe.js --url ws://6.zd10086.com/gate1/socket.io/?EIO=3\\&transport=websocket --seconds 120");
}

module.exports = {
  collectStringsFromProto,
  decodeAuthRequest,
  decodeRequestMessage,
  decodeReplayMessage,
  decodeSocketIoAttachment,
  decodeWebMessage,
  decryptConfigValue,
  extractVideoUrls,
  parseSocketIoText,
  readProtoFields,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
