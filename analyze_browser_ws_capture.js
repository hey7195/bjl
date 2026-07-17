const fs = require("node:fs");
const path = require("node:path");

function latestCaptureDir(root) {
  const recordings = path.join(root, "recordings");
  const dirs = fs
    .readdirSync(recordings, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => {
      const fullPath = path.join(recordings, item.name);
      return { name: item.name, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .filter((item) => fs.existsSync(path.join(item.fullPath, "frames.jsonl")))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (dirs.length === 0) {
    throw new Error(`No capture dir with frames.jsonl found under ${recordings}`);
  }
  return dirs[0].fullPath;
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function loadJsonLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: "parseError", line: index + 1, error: error.message, raw: line };
      }
    });
}

function addCount(map, key) {
  const name = key || "(empty)";
  map[name] = (map[name] || 0) + 1;
}

function distinct(values) {
  return [...new Set(values.filter(Boolean))];
}

function textFields(decoded) {
  if (!decoded || !Array.isArray(decoded.bodyDecoded)) {
    return [];
  }
  return decoded.bodyDecoded
    .filter((field) => typeof field.text === "string" && field.text.length > 0)
    .map((field) => ({ field: field.field, text: field.text, size: field.size }));
}

function topFieldValues(decoded, fieldNo) {
  if (!decoded || !Array.isArray(decoded.bodyDecoded)) {
    return [];
  }
  return decoded.bodyDecoded.filter((field) => field.field === fieldNo).map((field) => field.text ?? field.value ?? "");
}

function tableInfo(decoded) {
  if (!decoded || !Array.isArray(decoded.bodyDecoded)) {
    return {};
  }
  return {
    tableName: topFieldValues(decoded, 5)[0] || "",
    tableShortName: topFieldValues(decoded, 20)[0] || "",
    internalIp: topFieldValues(decoded, 15)[0] || "",
    timerOrLimit: topFieldValues(decoded, 16)[0] || "",
    countdownOrStatus: topFieldValues(decoded, 19)[0] || "",
    dealerId: topFieldValues(decoded, 28)[0] || "",
    dealerName: topFieldValues(decoded, 29)[0] || "",
    dealerImage: topFieldValues(decoded, 34)[0] || "",
    roundIds: distinct(topFieldValues(decoded, 30).map(String)),
    limitJson: topFieldValues(decoded, 35)[0] || "",
    nameJson: topFieldValues(decoded, 36)[0] || "",
  };
}

function compactRecord(record, index) {
  const decoded = record.decoded || null;
  const item = {
    index,
    time: record.receivedAt || "",
    direction: record.direction || "",
    type: record.type || record.type,
    requestId: record.requestId || "",
    wsUrl: record.wsUrl || record.url || "",
    size: record.size || 0,
    eventName: record.eventName || "",
    raw: record.raw || "",
    socketIoControl: record.socketIoControl || "",
    decodeError: record.decodeError || "",
  };
  if (decoded) {
    item.decoded = {
      event: decoded.eventGuess || record.eventName || "",
      account: decoded.account || "",
      envelope: decoded.envelope || "",
      result: decoded.result,
      session: decoded.session || "",
      bodySize: decoded.bodySize || 0,
      videoUrls: decoded.videoUrls || [],
      textFields: textFields(decoded),
      tableInfo: record.eventName === "TableInfoReplay" ? tableInfo(decoded) : undefined,
      bodyDecoded: decoded.bodyDecoded || [],
    };
  }
  return item;
}

function formatMessage(item) {
  const lines = [];
  const dir = item.direction === "sent" ? "发送" : item.direction === "received" ? "接收" : "系统";
  lines.push(`[#${String(item.index).padStart(6, "0")}] ${item.time} ${dir} ${item.type || item.rawType || ""} size=${item.size || 0}`);
  if (item.wsUrl) {
    lines.push(`连接: ${item.wsUrl}`);
  }
  if (item.eventName) {
    lines.push(`事件: ${item.eventName}`);
  }
  if (item.socketIoControl) {
    lines.push(`Socket.IO控制: ${item.socketIoControl}`);
  }
  if (item.raw) {
    lines.push(`文本: ${item.raw}`);
  }
  if (item.decodeError) {
    lines.push(`解码失败: ${item.decodeError}`);
  }
  if (item.decoded) {
    lines.push(`解码: envelope=${item.decoded.envelope} result=${item.decoded.result ?? ""} account=${item.decoded.account} bodySize=${item.decoded.bodySize}`);
    if (item.decoded.session) {
      lines.push(`session: ${item.decoded.session}`);
    }
    if (item.decoded.videoUrls.length > 0) {
      lines.push("视频地址:");
      for (const url of item.decoded.videoUrls) {
        lines.push(`  - ${url}`);
      }
    }
    if (item.decoded.tableInfo) {
      const info = item.decoded.tableInfo;
      lines.push("桌台信息:");
      lines.push(`  tableName=${info.tableName}`);
      lines.push(`  shortName=${info.tableShortName}`);
      lines.push(`  internalIp=${info.internalIp}`);
      lines.push(`  countdownOrStatus=${info.countdownOrStatus}`);
      lines.push(`  dealerId=${info.dealerId}`);
      lines.push(`  dealerName=${info.dealerName}`);
      lines.push(`  dealerImage=${info.dealerImage}`);
      if (info.roundIds.length > 0) {
        lines.push(`  roundIds=${info.roundIds.join(", ")}`);
      }
      if (info.limitJson) {
        lines.push(`  limitJson=${info.limitJson}`);
      }
      if (info.nameJson) {
        lines.push(`  nameJson=${info.nameJson}`);
      }
    }
    if (item.decoded.textFields.length > 0) {
      lines.push("可读字段:");
      for (const field of item.decoded.textFields) {
        lines.push(`  field ${field.field}: ${field.text}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const root = __dirname;
  const captureDir = path.resolve(argValue("--dir", latestCaptureDir(root)));
  const framesPath = path.join(captureDir, "frames.jsonl");
  const records = loadJsonLines(framesPath);
  const outDir = path.join(captureDir, "analysis");
  fs.mkdirSync(outDir, { recursive: true });

  const compact = [];
  const summary = {
    captureDir,
    framesPath,
    analyzedAt: new Date().toISOString(),
    totalLines: records.length,
    gateSocketLines: 0,
    unknownSocketLines: 0,
    systemLines: 0,
    sent: { total: 0, text: 0, binary: 0 },
    received: { total: 0, text: 0, binary: 0 },
    events: {},
    sentEvents: {},
    receivedEvents: {},
    decodedBinaries: 0,
    decodeErrors: 0,
    videoUrls: {},
    tableNames: {},
    dealerIds: {},
    roundIds: {},
    socketUrls: {},
  };

  records.forEach((record, idx) => {
    const item = compactRecord(record, idx + 1);
    compact.push(item);
    if (item.wsUrl) {
      addCount(summary.socketUrls, item.wsUrl);
      if (item.wsUrl.includes("gate1/socket.io")) {
        summary.gateSocketLines += 1;
      } else if (item.wsUrl.includes("existing websocket")) {
        summary.unknownSocketLines += 1;
      }
    } else {
      summary.systemLines += 1;
    }
    if (item.direction === "sent" || item.direction === "received") {
      summary[item.direction].total += 1;
      if (item.type === "text") summary[item.direction].text += 1;
      if (item.type === "binary") summary[item.direction].binary += 1;
    }
    if (item.eventName) {
      addCount(summary.events, item.eventName);
      if (item.direction === "sent") addCount(summary.sentEvents, item.eventName);
      if (item.direction === "received") addCount(summary.receivedEvents, item.eventName);
    }
    if (item.decoded) {
      summary.decodedBinaries += 1;
      for (const url of item.decoded.videoUrls) {
        addCount(summary.videoUrls, url);
      }
      if (item.decoded.tableInfo) {
        const info = item.decoded.tableInfo;
        addCount(summary.tableNames, info.tableName);
        addCount(summary.dealerIds, String(info.dealerId || ""));
        for (const roundId of info.roundIds) {
          addCount(summary.roundIds, roundId);
        }
      }
    }
    if (item.decodeError) {
      summary.decodeErrors += 1;
    }
  });

  const decodedJsonl = compact.map((item) => JSON.stringify(item)).join("\n") + "\n";
  const readable = compact.map(formatMessage).join("\n");
  fs.writeFileSync(path.join(outDir, "messages_decoded.jsonl"), decodedJsonl, "utf8");
  fs.writeFileSync(path.join(outDir, "messages_readable.txt"), readable, "utf8");
  fs.writeFileSync(path.join(outDir, "analysis_summary.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log(JSON.stringify({
    outDir,
    totalLines: summary.totalLines,
    gateSocketLines: summary.gateSocketLines,
    sent: summary.sent,
    received: summary.received,
    decodedBinaries: summary.decodedBinaries,
    decodeErrors: summary.decodeErrors,
    eventCount: Object.keys(summary.events).length,
    videoUrlCount: Object.keys(summary.videoUrls).length,
  }, null, 2));
}

main();
