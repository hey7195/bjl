const assert = require("node:assert/strict");

const { tableInfoFromRecord } = require("../baccarat_one_monitor");
const { summarizeTableResult } = require("../web_monitor/card_utils");
const { AllVenueMonitor, roundsFromTableResults } = require("../web_monitor/monitor");

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

test("table info keeps field8 result values alongside round ids", () => {
  const table = tableInfoFromRecord({
    decoded: {
      bodyDecoded: [
        { field: 2, value: 1 },
        { field: 5, text: "百家乐1号" },
        { field: 8, text: "010000000000" },
        { field: 8, text: "021000000000" },
        { field: 8, text: "-1" },
        { field: 20, text: "百1" },
        { field: 30, text: "round-1" },
        { field: 30, text: "round-2" },
        { field: 30, text: "round-3" },
      ],
    },
  });

  assert.deepEqual(table.resultValues, ["010000000000", "021000000000", "-1"]);
  assert.deepEqual(table.roundIds, ["round-1", "round-2", "round-3"]);
});

test("table info backfills field8 values when decoded tableInfo came from an old capture", () => {
  const table = tableInfoFromRecord({
    decoded: {
      tableInfo: {
        tableName: "百家乐1号",
        tableShortName: "百1",
        tableCode: 1,
        roundIds: ["round-1", "round-2"],
      },
      bodyDecoded: [
        { field: 8, text: "010000000000" },
        { field: 8, text: "020000000000" },
      ],
    },
  });

  assert.deepEqual(table.resultValues, ["010000000000", "020000000000"]);
});

test("summarizes baccarat table result code without pretending to know cards", () => {
  assert.deepEqual(summarizeTableResult("013082101100"), {
    gameType: "百家乐",
    winner: "庄赢",
    resultCode: "013082101100",
    baseResult: 13,
    bankerPair: true,
    playerPair: true,
    cardsText: "路单结果：庄赢，庄对，闲对",
  });
});

test("table replay results become rounds and skip unfinished entries", () => {
  const table = {
    tableCode: "1",
    tableName: "百家乐1号",
    tableShortName: "百1",
    roundIds: ["round-1", "round-2", "round-3", "round-4"],
    resultValues: ["010000000000", "020000000000", "030000000000", "-1"],
  };

  const rounds = roundsFromTableResults(table, "2026-07-17T00:00:00.000Z");

  assert.deepEqual(
    rounds.map((round) => [round.roundId, round.inningNumber, round.winner, round.cardsText, round.source]),
    [
      ["round-1", 1, "庄赢", "路单结果：庄赢", "TableInfoReplay.field8"],
      ["round-2", 2, "闲赢", "路单结果：闲赢", "TableInfoReplay.field8"],
      ["round-3", 3, "和", "路单结果：和", "TableInfoReplay.field8"],
    ]
  );
});

test("table replay result derivation ignores non baccarat tables", () => {
  const rounds = roundsFromTableResults({
    tableCode: "57",
    tableName: "Q龙虎8号",
    tableShortName: "龙 8",
    roundIds: ["round-1"],
    resultValues: ["020000000000"],
  });

  assert.deepEqual(rounds, []);
});

test("table replay backfills inning number without replacing card result", () => {
  const savedRounds = [];
  const existing = {
    tableCode: "70",
    tableName: "Q极速百27号",
    roundId: "round-2",
    source: "GameInfoReplay",
    gameType: "百家乐",
    winner: "庄赢(按点数推导)",
    bankerCards: ["红桃2", "梅花J"],
    playerCards: ["黑桃4", "红桃6"],
  };
  const store = {
    saveEvent() {},
    saveTable(table) {
      return { ...table, tableCode: String(table.tableCode) };
    },
    getRound(tableCode, roundId) {
      return roundId === "round-2" ? existing : null;
    },
    saveRound(round) {
      savedRounds.push(round);
      return round;
    },
  };
  const monitor = new AllVenueMonitor(store, {});

  monitor.handleDecodedUpdate({
    record: {
      eventName: "TableInfoReplay",
      at: "2026-07-17T00:00:00.000Z",
      decoded: {
        tableInfo: {
          tableCode: "70",
          tableName: "Q极速百27号",
          tableShortName: "百27",
          roundIds: ["round-1", "round-2"],
          resultValues: ["010000000000", "020000000000"],
        },
      },
    },
  });

  assert.equal(savedRounds.length, 2);
  const backfilled = savedRounds.find((round) => round.roundId === "round-2");
  assert.equal(backfilled.source, "GameInfoReplay");
  assert.equal(backfilled.inningNumber, 2);
  assert.deepEqual(backfilled.bankerCards, ["红桃2", "梅花J"]);
});
