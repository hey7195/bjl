const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const { AllVenueMonitor, DEFAULT_URL } = require("./monitor");
const { MonitorStore } = require("./store");
const { FastBaccaratVideoArchive } = require("./video_archive");

const ROOT = __dirname;
const PROJECT_ROOT = path.resolve(ROOT, "..");
const DATA_DIR = path.join(ROOT, "data");
const ROUND_VIDEO_DIR = path.join(DATA_DIR, "round_videos");
const PUBLIC_DIR = path.join(ROOT, "public");
const PLAYER_ASSETS = new Map([
  ["/player/WSAvcPlayer.js", path.join(PROJECT_ROOT, "WSAvcPlayer.js")],
  ["/player/Decoder.js", path.join(PROJECT_ROOT, "Decoder.js")],
]);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const options = {
  port: Number(argValue("--port", "9333")),
  url: argValue("--url", DEFAULT_URL),
  noMonitor: process.argv.includes("--no-monitor"),
  noVideoArchive: process.argv.includes("--no-video-archive"),
};

const store = new MonitorStore(DATA_DIR);
const videoArchive = options.noVideoArchive ? null : new FastBaccaratVideoArchive({ rootDir: ROUND_VIDEO_DIR });
const monitor = new AllVenueMonitor(store, { url: options.url, videoArchive });

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, text, status = 200, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

function serveStatic(res, pathname) {
  if (pathname.startsWith("/round-videos/")) {
    serveRoundVideo(res, pathname);
    return;
  }
  if (PLAYER_ASSETS.has(pathname)) {
    const assetPath = PLAYER_ASSETS.get(pathname);
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    fs.createReadStream(assetPath).pipe(res);
    return;
  }
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, "Not found", 404);
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
  };
  res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function serveRoundVideo(res, pathname) {
  const relative = decodeURIComponent(pathname.replace(/^\/round-videos\//, ""));
  const filePath = path.normalize(path.join(ROUND_VIDEO_DIR, relative));
  const root = path.resolve(ROUND_VIDEO_DIR);
  const target = path.resolve(filePath);
  if ((target !== root && !target.startsWith(root + path.sep)) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    sendText(res, "Not found", 404);
    return;
  }
  res.writeHead(200, {
    "content-type": "video/mp4",
    "cache-control": "no-store",
  });
  fs.createReadStream(target).pipe(res);
}

function handleApi(req, res, url) {
  if (url.pathname === "/api/status") {
    sendJson(res, { monitor: monitor.getStatus(), store: store.stats() });
    return;
  }
  if (url.pathname === "/api/tables") {
    sendJson(res, { tables: store.listTables(url.searchParams.get("q") || "") });
    return;
  }
  if (url.pathname === "/api/same-cards") {
    sendJson(res, {
      stats: store.sameCardStats({
        minCount: url.searchParams.get("minCount") || 2,
        limit: url.searchParams.get("limit") || 50,
      }),
    });
    return;
  }
  const tableMatch = url.pathname.match(/^\/api\/tables\/([^/]+)$/);
  if (tableMatch) {
    const table = store.getTable(decodeURIComponent(tableMatch[1]));
    if (!table) {
      sendJson(res, { error: "table not found" }, 404);
      return;
    }
    const page = store.listRounds(table.tableCode, {
      page: url.searchParams.get("page") || 1,
      pageSize: url.searchParams.get("pageSize") || url.searchParams.get("limit") || 50,
    });
    sendJson(res, { table, ...page });
    return;
  }
  const roundsMatch = url.pathname.match(/^\/api\/tables\/([^/]+)\/rounds$/);
  if (roundsMatch) {
    sendJson(
      res,
      store.listRounds(decodeURIComponent(roundsMatch[1]), {
        page: url.searchParams.get("page") || 1,
        pageSize: url.searchParams.get("pageSize") || url.searchParams.get("limit") || 50,
        limit: url.searchParams.get("limit") || 200,
        q: url.searchParams.get("q") || "",
      })
    );
    return;
  }
  const roundMatch = url.pathname.match(/^\/api\/tables\/([^/]+)\/rounds\/([^/]+)$/);
  if (roundMatch) {
    const round = store.getRound(decodeURIComponent(roundMatch[1]), decodeURIComponent(roundMatch[2]));
    if (!round) {
      sendJson(res, { error: "round not found" }, 404);
      return;
    }
    sendJson(res, { round });
    return;
  }
  sendJson(res, { error: "not found" }, 404);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(options.port, "127.0.0.1", () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${options.port}`, socket: options.url, dataDir: DATA_DIR }, null, 2));
  if (!options.noMonitor) {
    monitor.start();
  }
});

process.on("SIGINT", () => {
  monitor.stop();
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  monitor.stop();
  server.close(() => process.exit(0));
});
