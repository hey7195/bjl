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
  return new MonitorStore(fs.mkdtempSync(path.join(os.tmpdir(), "web-monitor-pagination-")));
}

test("listRounds returns requested page and pagination metadata", () => {
  const store = tempStore();
  for (let i = 1; i <= 25; i += 1) {
    store.saveRound({
      tableCode: "2",
      roundId: `round-${String(i).padStart(2, "0")}`,
      gameType: "百家乐",
      winner: "庄赢",
    });
  }

  const result = store.listRounds("2", { page: 2, pageSize: 10 });

  assert.equal(result.pagination.page, 2);
  assert.equal(result.pagination.pageSize, 10);
  assert.equal(result.pagination.total, 25);
  assert.equal(result.pagination.totalPages, 3);
  assert.deepEqual(result.rounds.map((round) => round.roundId), [
    "round-15",
    "round-14",
    "round-13",
    "round-12",
    "round-11",
    "round-10",
    "round-09",
    "round-08",
    "round-07",
    "round-06",
  ]);
});

test("listRounds clamps page into valid range", () => {
  const store = tempStore();
  store.saveRound({ tableCode: "2", roundId: "round-1" });

  const result = store.listRounds("2", { page: 99, pageSize: 20 });

  assert.equal(result.pagination.page, 1);
  assert.equal(result.rounds.length, 1);
});
