const { spawnSync } = require("node:child_process");

const url = "ws://6.zd10086.com/gate1/socket.io/?EIO=3&transport=websocket";
const endAt = Date.now() + 300000;
let round = 0;

while (Date.now() < endAt) {
  round += 1;
  const remainSeconds = Math.max(1, Math.min(15, Math.ceil((endAt - Date.now()) / 1000)));
  console.log(`[watch] round=${round} seconds=${remainSeconds}`);
  const result = spawnSync(
    process.execPath,
    ["--experimental-websocket", "socketio_probe.js", "--url", url, "--seconds", String(remainSeconds)],
    { cwd: __dirname, encoding: "utf8" }
  );
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

console.log("[watch] done");
