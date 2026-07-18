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

test("store loads jsonl files without whole-file utf8 reads", () => {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error("whole-file read should not be used");
  };
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-monitor-stream-load-"));
    fs.writeFileSync(path.join(dir, "tables.jsonl"), JSON.stringify({ tableCode: "2", tableName: "百家乐2号" }) + "\n");
    fs.writeFileSync(path.join(dir, "rounds.jsonl"), JSON.stringify({ tableCode: "2", roundId: "r1" }) + "\n");
    fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ type: "socket_open" }) + "\n");

    const store = new MonitorStore(dir);

    assert.equal(store.listTables()[0].tableCode, "2");
    assert.equal(store.listRounds("2").rounds[0].roundId, "r1");
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});
