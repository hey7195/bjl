const fs = require("node:fs");
const path = require("node:path");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function resolveFramesPath(input) {
  if (!input) {
    throw new Error("请传入抓包目录或 frames.jsonl 路径");
  }
  const stat = fs.statSync(input);
  return stat.isDirectory() ? path.join(input, "frames.jsonl") : input;
}

function readJsonLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function summarizeRecords(records) {
  const summary = {
    totalRecords: records.length,
    sentFrames: 0,
    receivedFrames: 0,
    socketIoEvents: {},
    frameEvents: {},
    videoUrls: {},
    timeline: [],
    videoTimeline: [],
    requests: [],
  };

  for (const record of records) {
    if (record.direction === "sent") {
      summary.sentFrames += 1;
    } else if (record.direction === "received") {
      summary.receivedFrames += 1;
    }

    if (record.eventName) {
      increment(summary.frameEvents, `${record.direction}:${record.eventName}`);
      if (record.type === "text") {
        increment(summary.socketIoEvents, `${record.direction}:${record.eventName}`);
      }
      const item = {
        at: record.receivedAt,
        direction: record.direction,
        eventName: record.eventName,
        size: record.size,
        rawPath: record.rawPath,
      };
      summary.timeline.push(item);
      if (record.direction === "sent") {
        summary.requests.push({
          ...item,
          bodyDecoded: record.decoded ? record.decoded.bodyDecoded : undefined,
        });
      }
    }

    const videoUrls = record.decoded && Array.isArray(record.decoded.videoUrls) ? record.decoded.videoUrls : [];
    if (videoUrls.length > 0) {
      for (const videoUrl of videoUrls) {
        increment(summary.videoUrls, videoUrl);
      }
      summary.videoTimeline.push({
        at: record.receivedAt,
        direction: record.direction,
        eventName: record.eventName,
        rawPath: record.rawPath,
        videoUrls,
      });
    }
  }

  return summary;
}

function topEntries(map, limit = 20) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function main() {
  const input = argValue("--input", process.argv[2]);
  const framesPath = resolveFramesPath(input);
  const records = readJsonLines(framesPath);
  const summary = summarizeRecords(records);
  const outPath = argValue("--out", path.join(path.dirname(framesPath), "analysis_summary.json"));
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(JSON.stringify({
    framesPath,
    outPath,
    totalRecords: summary.totalRecords,
    sentFrames: summary.sentFrames,
    receivedFrames: summary.receivedFrames,
    topSocketIoEvents: topEntries(summary.socketIoEvents, 30),
    topFrameEvents: topEntries(summary.frameEvents, 30),
    topVideoUrls: topEntries(summary.videoUrls, 30),
    videoTimelineCount: summary.videoTimeline.length,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  summarizeRecords,
};
