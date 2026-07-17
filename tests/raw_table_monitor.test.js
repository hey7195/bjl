const assert = require("node:assert/strict");
const {
  createRawMonitorState,
  handleRawTextFrame,
  handleRawBinaryFrame,
  parseEngineHandshake,
  shouldSendHeartbeat,
} = require("../raw_table_monitor");

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

test("parses Engine.IO handshake heartbeat settings", () => {
  assert.deepEqual(parseEngineHandshake('0{"sid":"abc","pingInterval":25000,"pingTimeout":5000}'), {
    sid: "abc",
    pingInterval: 25000,
    pingTimeout: 5000,
  });
  assert.equal(parseEngineHandshake("40"), null);
});

test("sends heartbeat before server timeout", () => {
  const state = createRawMonitorState({ targetTable: "Q极速百27号" });
  state.pingIntervalMs = 25000;
  state.lastHeartbeatAt = 1000;
  assert.equal(shouldSendHeartbeat(state, 20000), false);
  assert.equal(shouldSendHeartbeat(state, 23000), true);
});

test("pairs raw text event with following binary frame and matches target result", () => {
  const state = createRawMonitorState({ targetTable: "Q极速百27号" });

  const tableText = handleRawTextFrame(state, '451-["TableInfoReplay",{"_placeholder":true,"num":0}]', "2026-07-15T00:00:00.000Z");
  assert.equal(tableText.kind, "eventText");
  assert.equal(tableText.eventName, "TableInfoReplay");

  const tableBinary = handleRawBinaryFrame(
    state,
    {
      eventName: "TableInfoReplay",
      decoded: {
        tableInfo: {
          tableName: "Q极速百27号",
          tableShortName: "百27",
          tableCode: 927,
          roundIds: ["round-1"],
        },
      },
    },
    "2026-07-15T00:00:00.100Z"
  );
  assert.equal(tableBinary.matched, true);
  assert.equal(state.tableCodes.has(927), true);

  handleRawTextFrame(state, '451-["GameInfoReplay",{"_placeholder":true,"num":0}]', "2026-07-15T00:00:01.000Z");
  const resultBinary = handleRawBinaryFrame(
    state,
    {
      eventName: "GameInfoReplay",
      decoded: {
        bodyDecoded: [
          { field: 0, text: "round-2" },
          { field: 1, value: 927 },
          { field: 13, text: '{"0":{"type":"庄赢","value":123,"win":1}}' },
        ],
      },
    },
    "2026-07-15T00:00:01.100Z"
  );

  assert.equal(resultBinary.matched, true);
  assert.equal(resultBinary.kind, "gameResult");
  assert.equal(resultBinary.roundId, "round-2");
});
