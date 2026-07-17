const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

function tempStore() {
  return new MonitorStore(fs.mkdtempSync(path.join(os.tmpdir(), "web-monitor-same-cards-")));
}

function saveBaccaratRound(store, overrides) {
  store.saveRound({
    tableCode: "70",
    tableName: "Q极速百27号",
    tableShortName: "百27",
    roundId: "round-1",
    gameType: "百家乐",
    source: "GameInfoReplay",
    bankerRaw: ["O", "k"],
    playerRaw: ["D", "S", "y"],
    bankerCards: ["红桃2", "梅花J"],
    playerCards: ["黑桃4", "红桃6", "方块Q"],
    bankerPoint: 2,
    playerPoint: 0,
    ...overrides,
  });
}

test("same-card stats group baccarat rounds by venue type and exact cards", () => {
  const store = tempStore();
  saveBaccaratRound(store, { tableCode: "70", tableName: "Q极速百27号", roundId: "fast-1" });
  saveBaccaratRound(store, { tableCode: "44", tableName: "Q极速百15号", roundId: "fast-2" });
  saveBaccaratRound(store, { tableCode: "2", tableName: "百家乐2号", tableShortName: "百2", roundId: "normal-1" });
  saveBaccaratRound(store, { tableCode: "57", tableName: "Q龙虎8号", gameType: "龙虎", roundId: "ignored-game" });
  saveBaccaratRound(store, { tableCode: "3", tableName: "百家乐3号", roundId: "ignored-table-result", source: "TableInfoReplay.field8", bankerCards: [], playerCards: [] });

  const stats = store.sameCardStats({ minCount: 2 });

  assert.equal(stats.fastBaccarat.length, 1);
  assert.equal(stats.baccarat.length, 0);
  assert.equal(stats.fastBaccarat[0].count, 2);
  assert.deepEqual(stats.fastBaccarat[0].bankerCards, ["红桃2", "梅花J"]);
  assert.deepEqual(stats.fastBaccarat[0].playerCards, ["黑桃4", "红桃6", "方块Q"]);
  assert.deepEqual(
    stats.fastBaccarat[0].rounds.map((round) => [round.tableName, round.roundId]),
    [
      ["Q极速百27号", "fast-1"],
      ["Q极速百15号", "fast-2"],
    ]
  );
});

test("same-card stats can show single normal baccarat matches when requested", () => {
  const store = tempStore();
  saveBaccaratRound(store, { tableCode: "2", tableName: "百家乐2号", tableShortName: "百2", roundId: "normal-1" });

  const stats = store.sameCardStats({ minCount: 1 });

  assert.equal(stats.fastBaccarat.length, 0);
  assert.equal(stats.baccarat.length, 1);
  assert.equal(stats.baccarat[0].category, "baccarat");
});

test("same-card stats require exact suit and rank, not just display text", () => {
  const store = tempStore();
  saveBaccaratRound(store, { tableCode: "2", tableName: "百家乐2号", tableShortName: "百2", roundId: "normal-1" });
  saveBaccaratRound(store, {
    tableCode: "3",
    tableName: "百家乐3号",
    tableShortName: "百3",
    roundId: "normal-2",
    bankerRaw: ["P", "k"],
    playerRaw: ["D", "S", "y"],
    bankerCards: ["红桃2", "梅花J"],
    playerCards: ["黑桃4", "红桃6", "方块Q"],
  });

  const stats = store.sameCardStats({ minCount: 2 });

  assert.equal(stats.baccarat.length, 0);
});
