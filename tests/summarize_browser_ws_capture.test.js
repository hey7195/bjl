const assert = require("node:assert/strict");
const { summarizeRecords } = require("../summarize_browser_ws_capture");

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

test("summarizes browser websocket records", () => {
  const summary = summarizeRecords([
    { direction: "sent", type: "text", eventName: "GetGameRequest", receivedAt: "2026-07-13T13:00:00.000Z" },
    { direction: "sent", type: "binary", eventName: "GetGameRequest", receivedAt: "2026-07-13T13:00:00.100Z" },
    {
      direction: "received",
      type: "binary",
      eventName: "TableInfoReplay",
      receivedAt: "2026-07-13T13:00:01.000Z",
      decoded: { videoUrls: ["wss://dt.shipin1hao.com:9999/9009"] },
    },
    { direction: "received", type: "text", eventName: "GameInfoReplay", receivedAt: "2026-07-13T13:00:02.000Z" },
  ]);

  assert.equal(summary.socketIoEvents["sent:GetGameRequest"], 1);
  assert.equal(summary.frameEvents["sent:GetGameRequest"], 2);
  assert.equal(summary.frameEvents["received:TableInfoReplay"], 1);
  assert.equal(summary.videoUrls["wss://dt.shipin1hao.com:9999/9009"], 1);
  assert.equal(summary.timeline.length, 4);
  assert.equal(summary.videoTimeline[0].eventName, "TableInfoReplay");
});
