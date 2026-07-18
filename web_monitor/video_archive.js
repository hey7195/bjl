const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_PRE_MS = 75 * 1000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

function isFastBaccaratTable(table) {
  const text = [table?.tableName || "", table?.tableShortName || "", table?.nameJson || ""].join(" ");
  return /极速/.test(text) && /百家乐|百|Baccarat|Bac/i.test(text);
}

function sanitizeName(value) {
  return String(value || "未知桌台")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function beijingDate(value) {
  const date = value ? new Date(value) : new Date();
  const time = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  return new Date(time + 8 * 60 * 60 * 1000);
}

function pad(value, size = 2) {
  return String(value).padStart(size, "0");
}

function formatBeijingHour(value) {
  const date = beijingDate(value);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}`;
}

function formatBeijingTimestamp(value) {
  const date = beijingDate(value);
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function roundVideoRelativePath(round) {
  const tableName = sanitizeName(round.tableName || round.tableShortName || round.tableCode);
  const inning = round.inningNumber || "-";
  const timestamp = formatBeijingTimestamp(round.receivedAt);
  const hour = formatBeijingHour(round.receivedAt);
  const roundId = sanitizeName(round.roundId || "unknown");
  return path.join(tableName, hour, `${tableName} 第${inning}局 ${timestamp} ${roundId}.mp4`).replaceAll("\\", "/");
}

function roundVideoUrl(relativePath) {
  return `/round-videos/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

class FfmpegH264Writer {
  constructor(filePath, ffmpegPath = "ffmpeg", fps = 25) {
    this.filePath = filePath;
    this.ffmpegPath = ffmpegPath;
    this.fps = fps;
    this.chunks = [];
  }

  write(payload) {
    this.chunks.push(Buffer.from(payload));
  }

  close() {
    const result = spawnSync(
      this.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "h264",
        "-r",
        String(this.fps),
        "-i",
        "pipe:0",
        "-c:v",
        "copy",
        "-f",
        "mp4",
        "-movflags",
        "+faststart",
        this.filePath,
      ],
      {
        input: Buffer.concat(this.chunks),
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      }
    );
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const detail = result.stderr ? result.stderr.toString("utf8", 0, 200).trim() : "";
      throw new Error(detail || `ffmpeg exited with ${result.status}`);
    }
  }
}

class FastBaccaratVideoArchive {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(__dirname, "data", "round_videos");
    this.preMs = Number(options.preMs || DEFAULT_PRE_MS);
    this.retentionMs = Number(options.retentionMs || DEFAULT_RETENTION_MS);
    this.reconnectMs = Number(options.reconnectMs || 3000);
    this.ffmpegPath = options.ffmpegPath || findDefaultFfmpegPath(path.resolve(__dirname, ".."));
    this.now = options.now || Date.now;
    this.WebSocketClass = options.WebSocketClass || globalThis.WebSocket;
    this.writerFactory = options.writerFactory || ((filePath) => new FfmpegH264Writer(filePath, this.ffmpegPath));
    this.buffers = new Map();
    this.lastCleanupAt = 0;
    this.closed = false;
  }

  observeTable(table) {
    if (!isFastBaccaratTable(table)) return;
    const videoUrl = firstExternalVideoUrl(table.videoUrls || []);
    if (!videoUrl) return;
    const buffer = this._ensureBuffer(table, videoUrl);
    this._connectBuffer(table, buffer);
  }

  observeFrame(table, payload, receivedAtMs = this.now()) {
    if (!isFastBaccaratTable(table)) return;
    const videoUrl = firstExternalVideoUrl(table.videoUrls || []);
    if (!videoUrl) return;
    const buffer = this._ensureBuffer(table, videoUrl);
    const frame = { at: receivedAtMs, payload: Buffer.from(payload) };
    this._rememberCodecConfig(buffer, frame);
    buffer.frames.push(frame);
    this._trimBuffer(buffer, receivedAtMs);
  }

  saveRoundVideo(table, round) {
    if (!isFastBaccaratTable(table)) return null;
    const videoUrl = firstExternalVideoUrl(table.videoUrls || []);
    if (!videoUrl) return null;
    const buffer = this.buffers.get(String(table.tableCode));
    if (!buffer || !buffer.frames.length) return null;
    if (buffer.lastSavedRoundId === String(round.roundId || "")) return null;
    const relativePath = roundVideoRelativePath({ ...round, tableName: table.tableName, tableShortName: table.tableShortName, tableCode: table.tableCode });
    const filePath = path.join(this.rootDir, relativePath);
    const roundAt = timestampMs(round.receivedAt, buffer.frames[buffer.frames.length - 1].at);
    let rawFrames = buffer.frames.filter((frame) => frame.at >= roundAt - this.preMs && frame.at <= roundAt);
    if (!rawFrames.length) {
      const latestFrameAt = buffer.frames[buffer.frames.length - 1].at;
      rawFrames = buffer.frames.filter((frame) => frame.at >= latestFrameAt - this.preMs && frame.at <= latestFrameAt);
    }
    const frames = withCodecConfig(buffer, selectPlayableFrames(rawFrames));
    if (!frames.length) return null;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.tmp`;
      const writer = this.writerFactory(tempPath);
      for (const frame of frames) {
        writer.write(frame.payload);
      }
      writer.close();
      const tempSize = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0;
      if (tempSize <= 0) {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        throw new Error("empty video output");
      }
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      const tempPath = `${filePath}.tmp`;
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (fs.existsSync(filePath) && fs.statSync(filePath).size === 0) fs.unlinkSync(filePath);
      return {
        ok: false,
        error: error.message,
        path: filePath,
        relativePath,
        url: "",
        videoUrl,
        frames: 0,
        bytes: 0,
      };
    }
    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (fileSize <= 0) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return {
        ok: false,
        error: "empty video output",
        path: filePath,
        relativePath,
        url: "",
        videoUrl,
        frames: 0,
        bytes: 0,
      };
    }
    const saved = {
      ok: true,
      path: filePath,
      relativePath,
      url: roundVideoUrl(relativePath),
      videoUrl,
      frames: frames.length,
      bytes: fileSize,
    };
    buffer.lastSavedRoundId = String(round.roundId || "");
    this.cleanupExpired();
    return saved;
  }

  close() {
    this.closed = true;
    for (const buffer of this.buffers.values()) {
      if (buffer.reconnectTimer) clearTimeout(buffer.reconnectTimer);
      buffer.reconnectTimer = null;
      if (buffer.ws) {
        try {
          buffer.ws.close();
        } catch {}
      }
      buffer.ws = null;
    }
  }

  cleanupExpired() {
    const now = this.now();
    if (now - this.lastCleanupAt < 60 * 1000) return;
    this.lastCleanupAt = now;
    removeExpiredFiles(this.rootDir, now - this.retentionMs);
  }

  _ensureBuffer(table, videoUrl) {
    const tableCode = String(table.tableCode);
    if (!this.buffers.has(tableCode)) {
      this.buffers.set(tableCode, {
        tableCode,
        videoUrl,
        frames: [],
        ws: null,
        reconnectTimer: null,
        lastSavedRoundId: "",
        spsFrame: null,
        ppsFrame: null,
      });
    }
    const buffer = this.buffers.get(tableCode);
    buffer.videoUrl = videoUrl;
    return buffer;
  }

  _connectBuffer(table, buffer) {
    if (this.closed || !this.WebSocketClass || buffer.ws) return;
    const ws = new this.WebSocketClass(buffer.videoUrl);
    buffer.ws = ws;
    ws.addEventListener("message", async (event) => {
      if (typeof event.data === "string") return;
      const data = event.data instanceof Blob ? Buffer.from(await event.data.arrayBuffer()) : Buffer.from(event.data);
      this.observeFrame(table, data, this.now());
    });
    ws.addEventListener("close", () => {
      buffer.ws = null;
      if (buffer.reconnectTimer) clearTimeout(buffer.reconnectTimer);
      if (this.closed) return;
      buffer.reconnectTimer = setTimeout(() => this._connectBuffer(table, buffer), this.reconnectMs);
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {}
    });
  }

  _trimBuffer(buffer, now) {
    while (buffer.frames.length && now - buffer.frames[0].at > this.preMs) {
      buffer.frames.shift();
    }
  }

  _rememberCodecConfig(buffer, frame) {
    const types = h264NalTypes(frame.payload);
    if (types.includes(7)) buffer.spsFrame = frame;
    if (types.includes(8)) buffer.ppsFrame = frame;
  }
}

function firstExternalVideoUrl(urls) {
  return (urls || []).find((url) => /^wss?:\/\//i.test(String(url)) && !/\/\/10\./.test(String(url))) || "";
}

function findDefaultFfmpegPath(projectRoot) {
  const binaryDir = path.join(projectRoot, ".venv", "lib", "site-packages", "imageio_ffmpeg", "binaries");
  if (fs.existsSync(binaryDir)) {
    const match = fs
      .readdirSync(binaryDir)
      .find((name) => /^ffmpeg.*\.exe$/i.test(name) || name === "ffmpeg");
    if (match) return path.join(binaryDir, match);
  }
  return "ffmpeg";
}

function timestampMs(value, fallback) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}

function selectPlayableFrames(frames) {
  return frames;
}

function withCodecConfig(buffer, frames) {
  if (!frames.length) return frames;
  const hasSps = frames.some(hasH264NalType(7));
  const hasPps = frames.some(hasH264NalType(8));
  const prefix = [];
  if (!hasSps && buffer.spsFrame) prefix.push(buffer.spsFrame);
  if (!hasPps && buffer.ppsFrame) prefix.push(buffer.ppsFrame);
  return [...prefix, ...frames];
}

function hasH264NalType(...types) {
  return (frame) => h264NalTypes(frame.payload).some((type) => types.includes(type));
}

function h264NalTypes(payload) {
  const types = [];
  for (let index = 0; index < payload.length - 4; index += 1) {
    let start = 0;
    if (payload[index] === 0 && payload[index + 1] === 0 && payload[index + 2] === 1) {
      start = index + 3;
    } else if (payload[index] === 0 && payload[index + 1] === 0 && payload[index + 2] === 0 && payload[index + 3] === 1) {
      start = index + 4;
    }
    if (start > 0 && start < payload.length) {
      types.push(payload[start] & 0x1f);
      index = start;
    }
  }
  return types;
}

function removeExpiredFiles(rootDir, cutoffMs) {
  if (!fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      removeExpiredFiles(fullPath, cutoffMs);
      if (fs.readdirSync(fullPath).length === 0) fs.rmdirSync(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoffMs) fs.unlinkSync(fullPath);
    }
  }
}

module.exports = {
  DEFAULT_PRE_MS,
  DEFAULT_RETENTION_MS,
  FastBaccaratVideoArchive,
  FfmpegH264Writer,
  findDefaultFfmpegPath,
  firstExternalVideoUrl,
  h264NalTypes,
  isFastBaccaratTable,
  roundVideoRelativePath,
  roundVideoUrl,
  selectPlayableFrames,
};
