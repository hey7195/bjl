const assert = require("node:assert/strict");
const { buildCaptureOptions } = require("../browser_ws_capture");

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

test("parses reload capture options", () => {
  const options = buildCaptureOptions([
    "--seconds",
    "30",
    "--target",
    "6.zd10086.com",
    "--ws-filter",
    "socket.io",
    "--reload",
  ]);

  assert.equal(options.seconds, 30);
  assert.equal(options.targetUrlHint, "6.zd10086.com");
  assert.equal(options.wsUrlHint, "socket.io");
  assert.equal(options.reload, true);
});
