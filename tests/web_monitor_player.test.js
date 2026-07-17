const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

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

test("web monitor page declares an embedded h264 player", () => {
  const html = read("web_monitor/public/index.html");
  assert.match(html, /\/player\/WSAvcPlayer\.js/);
  assert.match(html, /\/player\/Decoder\.js/);
  assert.match(html, /id="videoPlayerMount"/);
  assert.match(html, /id="videoPlayerStatus"/);
  assert.match(html, /id="stopVideoBtn"/);
});

test("web monitor app can start and stop the selected stream player", () => {
  const js = read("web_monitor/public/app.js");
  assert.match(js, /new WSAvcPlayer\["default"\]/);
  assert.match(js, /workerFile:\s*"\/player\/Decoder\.js"/);
  assert.match(js, /\.connect\(url\)/);
  assert.match(js, /\.disconnect\(\)/);
});

test("web monitor server exposes player assets from the project root", () => {
  const js = read("web_monitor/server.js");
  assert.match(js, /PLAYER_ASSETS/);
  assert.match(js, /\/player\/WSAvcPlayer\.js/);
  assert.match(js, /\/player\/Decoder\.js/);
});

test("web monitor page exposes inning number and same-card stats tab", () => {
  const html = read("web_monitor/public/index.html");
  const js = read("web_monitor/public/app.js");

  assert.match(html, /id="tabRounds"/);
  assert.match(html, /id="tabSameCards"/);
  assert.match(html, /id="roundsPanel"/);
  assert.match(html, /id="sameCardsPanel"/);
  assert.match(html, /id="sameCards"/);
  assert.match(html, /<th>局数<\/th>/);
  assert.match(js, /\/api\/same-cards/);
  assert.match(js, /switchTab/);
  assert.match(js, /round\.inningNumber/);
});

test("web monitor rounds table exposes pagination controls", () => {
  const html = read("web_monitor/public/index.html");
  const js = read("web_monitor/public/app.js");

  assert.match(html, /id="pageSize"/);
  assert.match(html, /id="prevPageBtn"/);
  assert.match(html, /id="nextPageBtn"/);
  assert.match(html, /id="pageInput"/);
  assert.match(html, /id="paginationStatus"/);
  assert.match(js, /state\.roundPage/);
  assert.match(js, /pageSize=/);
  assert.match(js, /page=/);
});
