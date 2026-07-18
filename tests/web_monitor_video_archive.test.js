const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  FastBaccaratVideoArchive,
  findDefaultFfmpegPath,
  isFastBaccaratTable,
  roundVideoRelativePath,
} = require("../web_monitor/video_archive");
const { MonitorStore } = require("../web_monitor/store");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "web-monitor-video-archive-"));
}

test("round video path uses table, hour, inning, time, and round id", () => {
  const relative = roundVideoRelativePath({
    tableName: "Q极速百28号",
    inningNumber: 54,
    receivedAt: "2026-07-18T05:02:46.000Z",
    roundId: "260718w2907190059054",
  });

  assert.equal(
    relative,
    "Q极速百28号/20260718_13/Q极速百28号 第54局 20260718_130246 260718w2907190059054.mp4"
  );
});

test("ffmpeg lookup prefers imageio-ffmpeg binary under project venv", () => {
  const dir = tempDir();
  const expected = path.join(dir, ".venv", "lib", "site-packages", "imageio_ffmpeg", "binaries", "ffmpeg-win-x86_64-v7.1.exe");
  fs.mkdirSync(path.dirname(expected), { recursive: true });
  fs.writeFileSync(expected, "");

  assert.equal(findDefaultFfmpegPath(dir), expected);
});

test("fast baccarat detection only includes Q fast baccarat tables", () => {
  assert.equal(isFastBaccaratTable({ tableName: "Q极速百28号", tableShortName: "百28" }), true);
  assert.equal(isFastBaccaratTable({ tableName: "百家乐2号", tableShortName: "百2" }), false);
  assert.equal(isFastBaccaratTable({ tableName: "Q极速龙12号", tableShortName: "龙12" }), false);
});

test("archive keeps saved round videos in table and hour folders", () => {
  const dir = tempDir();
  const calls = [];
  const archive = new FastBaccaratVideoArchive({
    rootDir: dir,
    ffmpegPath: "ffmpeg",
    now: () => new Date("2026-07-18T05:03:00.000Z").getTime(),
    writerFactory: (filePath) => {
      calls.push(filePath);
      return {
        write(payload) {
          fs.appendFileSync(filePath, payload);
        },
        close() {},
      };
    },
  });
  const table = {
    tableCode: "71",
    tableName: "Q极速百28号",
    tableShortName: "百28",
    videoUrls: ["wss://example.com/9213"],
  };
  archive.observeFrame(table, Buffer.from("abc"), new Date("2026-07-18T05:02:40.000Z").getTime());
  const saved = archive.saveRoundVideo(table, {
    roundId: "260718w2907190059054",
    inningNumber: 54,
    receivedAt: "2026-07-18T05:02:46.000Z",
  });

  assert.equal(saved.relativePath, "Q极速百28号/20260718_13/Q极速百28号 第54局 20260718_130246 260718w2907190059054.mp4");
  assert.equal(saved.url, "/round-videos/Q%E6%9E%81%E9%80%9F%E7%99%BE28%E5%8F%B7/20260718_13/Q%E6%9E%81%E9%80%9F%E7%99%BE28%E5%8F%B7%20%E7%AC%AC54%E5%B1%80%2020260718_130246%20260718w2907190059054.mp4");
  assert.equal(fs.readFileSync(path.join(dir, saved.relativePath), "utf8"), "abc");
  assert.equal(calls.length, 1);
});

test("archive connects one external stream for fast baccarat tables", () => {
  const opened = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = {};
      opened.push(this);
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    close() {}
  }
  FakeWebSocket.OPEN = 1;
  const archive = new FastBaccaratVideoArchive({
    rootDir: tempDir(),
    WebSocketClass: FakeWebSocket,
    reconnectMs: 1,
  });

  archive.observeTable({
    tableCode: "71",
    tableName: "Q极速百28号",
    tableShortName: "百28",
    videoUrls: ["ws://10.216.0.18:9213", "wss://wt.shipin3hao.com:9999/9213"],
  });
  archive.observeTable({
    tableCode: "64",
    tableName: "Q极速龙10号",
    tableShortName: "龙10",
    videoUrls: ["wss://wt.shipin3hao.com:9999/9220"],
  });

  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, "wss://wt.shipin3hao.com:9999/9213");
});

test("archive stores binary frames received from the table stream", () => {
  const opened = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      opened.push(this);
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    close() {}
  }
  const archive = new FastBaccaratVideoArchive({
    rootDir: tempDir(),
    WebSocketClass: FakeWebSocket,
  });
  const table = {
    tableCode: "71",
    tableName: "Q极速百28号",
    tableShortName: "百28",
    videoUrls: ["wss://wt.shipin3hao.com:9999/9213"],
  };

  archive.observeTable(table);
  opened[0].listeners.message({ data: Buffer.from("frame") });

  assert.equal(archive.buffers.get("71").frames.length, 1);
  assert.equal(archive.buffers.get("71").frames[0].payload.toString(), "frame");
});

test("archive saves only frames after the previous saved round", () => {
  const dir = tempDir();
  let current = new Date("2026-07-18T05:00:00.000Z").getTime();
  const archive = new FastBaccaratVideoArchive({
    rootDir: dir,
    now: () => current,
    writerFactory: (filePath) => ({
      write(payload) {
        fs.appendFileSync(filePath, payload);
      },
      close() {},
    }),
  });
  const table = {
    tableCode: "71",
    tableName: "Q极速百28号",
    tableShortName: "百28",
    videoUrls: ["wss://wt.shipin3hao.com:9999/9213"],
  };

  archive.observeFrame(table, Buffer.from("first"), current);
  archive.saveRoundVideo(table, { roundId: "round-1", inningNumber: 1, receivedAt: "2026-07-18T05:00:01.000Z" });
  current += 1000;
  archive.observeFrame(table, Buffer.from("second"), current);
  const saved = archive.saveRoundVideo(table, { roundId: "round-2", inningNumber: 2, receivedAt: "2026-07-18T05:00:02.000Z" });

  assert.equal(fs.readFileSync(path.join(dir, saved.relativePath), "utf8"), "second");
});

test("archive starts saved video from the latest keyframe when available", () => {
  const dir = tempDir();
  let current = new Date("2026-07-18T05:00:00.000Z").getTime();
  const archive = new FastBaccaratVideoArchive({
    rootDir: dir,
    now: () => current,
    writerFactory: (filePath) => ({
      write(payload) {
        fs.appendFileSync(filePath, payload);
      },
      close() {},
    }),
  });
  const table = {
    tableCode: "71",
    tableName: "Q极速百28号",
    tableShortName: "百28",
    videoUrls: ["wss://wt.shipin3hao.com:9999/9213"],
  };

  archive.observeFrame(table, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x61, 0x01]), current);
  current += 1000;
  archive.observeFrame(table, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x02]), current);
  current += 1000;
  archive.observeFrame(table, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x03]), current);
  current += 1000;
  archive.observeFrame(table, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x61, 0x04]), current);
  const saved = archive.saveRoundVideo(table, { roundId: "round-1", inningNumber: 1, receivedAt: "2026-07-18T05:00:04.000Z" });

  assert.deepEqual([...fs.readFileSync(path.join(dir, saved.relativePath))], [
    0x00, 0x00, 0x00, 0x01, 0x67, 0x02, 0x00, 0x00, 0x00, 0x01, 0x65, 0x03, 0x00, 0x00, 0x00, 0x01, 0x61, 0x04,
  ]);
});

test("archive prefixes cached sps and pps when round frames do not include them", () => {
  const dir = tempDir();
  let current = new Date("2026-07-18T05:00:00.000Z").getTime();
  const archive = new FastBaccaratVideoArchive({
    rootDir: dir,
    now: () => current,
    writerFactory: (filePath) => ({
      write(payload) {
        fs.appendFileSync(filePath, payload);
      },
      close() {},
    }),
  });
  const table = {
    tableCode: "71",
    tableName: "Q极速百28号",
    tableShortName: "百28",
    videoUrls: ["wss://wt.shipin3hao.com:9999/9213"],
  };
  const sps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x02]);
  const pps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x68, 0x03]);
  const idr = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x04]);
  archive.observeFrame(table, sps, current);
  archive.observeFrame(table, pps, current);
  archive.saveRoundVideo(table, { roundId: "round-1", inningNumber: 1, receivedAt: "2026-07-18T05:00:01.000Z" });
  current += 1000;
  archive.observeFrame(table, idr, current);
  const saved = archive.saveRoundVideo(table, { roundId: "round-2", inningNumber: 2, receivedAt: "2026-07-18T05:00:02.000Z" });

  assert.deepEqual([...fs.readFileSync(path.join(dir, saved.relativePath))], [...sps, ...pps, ...idr]);
});

test("archive does not save the same round twice", () => {
  const dir = tempDir();
  const archive = new FastBaccaratVideoArchive({
    rootDir: dir,
    writerFactory: (filePath) => ({
      write(payload) {
        fs.appendFileSync(filePath, payload);
      },
      close() {},
    }),
  });
  const table = {
    tableCode: "71",
    tableName: "Q极速百28号",
    tableShortName: "百28",
    videoUrls: ["wss://wt.shipin3hao.com:9999/9213"],
  };
  const round = { roundId: "round-1", inningNumber: 1, receivedAt: "2026-07-18T05:00:01.000Z" };
  archive.observeFrame(table, Buffer.from("first"));

  assert.notEqual(archive.saveRoundVideo(table, round), null);
  assert.equal(archive.saveRoundVideo(table, round), null);
});

test("archive returns failure metadata when writer cannot start", () => {
  const archive = new FastBaccaratVideoArchive({
    rootDir: tempDir(),
    writerFactory: () => {
      throw new Error("spawn ffmpeg ENOENT");
    },
  });
  const table = {
    tableCode: "71",
    tableName: "Q极速百28号",
    tableShortName: "百28",
    videoUrls: ["wss://wt.shipin3hao.com:9999/9213"],
  };
  archive.observeFrame(table, Buffer.from("first"));

  const saved = archive.saveRoundVideo(table, { roundId: "round-1", inningNumber: 1, receivedAt: "2026-07-18T05:00:01.000Z" });

  assert.equal(saved.ok, false);
  assert.match(saved.error, /ffmpeg/);
});

test("archive treats empty writer output as a failed save", () => {
  const dir = tempDir();
  const archive = new FastBaccaratVideoArchive({
    rootDir: dir,
    writerFactory: () => ({
      write() {},
      close() {},
    }),
  });
  const table = {
    tableCode: "71",
    tableName: "Q极速百28号",
    tableShortName: "百28",
    videoUrls: ["wss://wt.shipin3hao.com:9999/9213"],
  };
  archive.observeFrame(table, Buffer.from("first"));

  const saved = archive.saveRoundVideo(table, { roundId: "round-1", inningNumber: 1, receivedAt: "2026-07-18T05:00:01.000Z" });

  assert.equal(saved.ok, false);
  assert.match(saved.error, /empty/);
  assert.equal(fs.existsSync(saved.path), false);
  assert.equal(fs.existsSync(`${saved.path}.tmp`), false);
});

test("archive removes videos older than 24 hours", () => {
  const dir = tempDir();
  const archive = new FastBaccaratVideoArchive({
    rootDir: dir,
    now: () => new Date("2026-07-18T13:00:00.000Z").getTime(),
    writerFactory: (filePath) => ({
      write(payload) {
        fs.appendFileSync(filePath, payload);
      },
      close() {},
    }),
  });
  const oldPath = path.join(dir, "Q极速百28号", "20260717_12", "old.mp4");
  const newPath = path.join(dir, "Q极速百28号", "20260718_12", "new.mp4");
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(oldPath, "old");
  fs.writeFileSync(newPath, "new");
  fs.utimesSync(oldPath, new Date("2026-07-17T04:59:00.000Z"), new Date("2026-07-17T04:59:00.000Z"));
  fs.utimesSync(newPath, new Date("2026-07-18T04:59:00.000Z"), new Date("2026-07-18T04:59:00.000Z"));

  archive.cleanupExpired();

  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(newPath), true);
});

test("same-card stats include archived round video urls", () => {
  const store = new MonitorStore(tempDir());
  store.saveRound({
    tableCode: "71",
    tableName: "Q极速百28号",
    roundId: "round-1",
    gameType: "百家乐",
    source: "GameInfoReplay",
    bankerRaw: ["O"],
    playerRaw: ["D"],
    bankerCards: ["黑桃4"],
    playerCards: ["红桃A"],
    roundVideo: { url: "/round-videos/a.mp4" },
  });
  store.saveRound({
    tableCode: "45",
    tableName: "Q极速百16号",
    roundId: "round-2",
    gameType: "百家乐",
    source: "GameInfoReplay",
    bankerRaw: ["O"],
    playerRaw: ["D"],
    bankerCards: ["黑桃4"],
    playerCards: ["红桃A"],
    roundVideo: { url: "/round-videos/b.mp4" },
  });

  const stats = store.sameCardStats({ minCount: 2 });

  assert.deepEqual(
    stats.fastBaccarat[0].rounds.map((round) => round.roundVideo.url),
    ["/round-videos/a.mp4", "/round-videos/b.mp4"]
  );
});
