const assert = require("node:assert/strict");
const {
  buildTargetMatcher,
  createTargetState,
  decodePokerCode,
  decodePokerCodes,
  formatBeijingTime,
  formatReadable,
  summarizeGameResult,
  summarizeBaccaratCards,
  summarizeNiuNiuResult,
  updateTargetState,
} = require("../baccarat_one_monitor");

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

test("matches Q niuniu table 1 without matching table 10", () => {
  const matcher = buildTargetMatcher({
    tableName: "Q牛牛1号",
    tableShort: "牛1",
    tableCode: "47",
  });

  assert.equal(matcher({ tableName: "Q牛牛1号", tableShortName: "牛1", nameJson: "", tableCode: 47 }), true);
  assert.equal(matcher({ tableName: "Q牛牛10号", tableShortName: "牛10", nameJson: "", tableCode: 410 }), false);
  assert.equal(matcher({ tableName: "", tableShortName: "牛1", nameJson: "", tableCode: 47 }), true);
  assert.equal(matcher({ tableName: "百家乐1号", tableShortName: "百1", nameJson: "", tableCode: 1 }), false);
});

test("tracks target table code and matches Q niuniu result by table code", () => {
  const matcher = buildTargetMatcher({
    tableName: "Q牛牛1号",
    tableShort: "牛1",
    tableCode: "47",
  });
  const state = createTargetState();

  const tableRecord = {
    direction: "received",
    type: "binary",
    eventName: "TableInfoReplay",
    decoded: {
      videoUrls: ["wss://dt.shipin1hao.com:9999/9009"],
      tableInfo: {
        tableName: "Q牛牛1号",
        tableShortName: "牛1",
        tableCode: 47,
        internalIp: "10.216.1.47",
        roundIds: ["old-round"],
      },
    },
  };
  const gameRecord = {
    direction: "received",
    type: "binary",
    eventName: "GameInfoReplay",
    decoded: {
      bodyDecoded: [
        { field: 0, text: "260713w2904790079022" },
        { field: 1, value: 47 },
        { field: 9, value: 0 },
        { field: 10, value: 0 },
        { field: 13, text: '{"0":{"type":"牛4","value":34123,"win":0,"pokerTypeCode":"05"},"1":{},"2":{},"3":{}}' },
        { field: 14, text: '[["v","x","g","Y","c","D"],["x","g","Y","c","D"],[],[],[]]' },
      ],
    },
  };

  assert.equal(updateTargetState(state, tableRecord, matcher).matched, true);
  const result = updateTargetState(state, gameRecord, matcher);

  assert.equal(result.matched, true);
  assert.equal(result.kind, "gameResult");
  assert.equal(result.matchBy, "tableCode");
  assert.equal(result.roundId, "260713w2904790079022");
  assert.equal(result.result.niuniu[0].type, "牛4");
  assert.equal(result.result.niuniu[0].value, 34123);
});

test("matches target by table name first then tracks replay by discovered table code", () => {
  const matcher = buildTargetMatcher({
    tableName: "Q极速百27号",
    tableShort: "",
    tableCode: "",
  });
  const state = createTargetState();

  const tableUpdate = updateTargetState(
    state,
    {
      direction: "received",
      type: "binary",
      eventName: "TableInfoReplay",
      decoded: {
        tableInfo: {
          tableName: "Q极速百27号",
          tableShortName: "百27",
          tableCode: 927,
          roundIds: ["round-before"],
        },
      },
    },
    matcher
  );

  const resultUpdate = updateTargetState(
    state,
    {
      direction: "received",
      type: "binary",
      eventName: "GameInfoReplay",
      decoded: {
        bodyDecoded: [
          { field: 0, text: "round-after" },
          { field: 1, value: 927 },
          { field: 9, value: 1 },
          { field: 10, value: 4 },
        ],
      },
    },
    matcher
  );

  assert.equal(tableUpdate.matched, true);
  assert.equal(resultUpdate.matched, true);
  assert.equal(resultUpdate.matchBy, "tableCode");
  assert.equal(resultUpdate.roundId, "round-after");
});

test("summarizes Q niuniu result from field13", () => {
  assert.deepEqual(
    summarizeNiuNiuResult('{"0":{"type":"牛4","value":34123,"win":0,"pokerTypeCode":"05"},"1":{},"2":{},"3":{}}'),
    [{ index: "0", type: "牛4", value: 34123, win: 0, pokerTypeCode: "05" }]
  );
});

test("summarizes game result fields with niuniu details", () => {
  assert.deepEqual(
    summarizeGameResult({
      decoded: {
        bodyDecoded: [
          { field: 0, text: "round-x" },
          { field: 13, text: '{"0":{"type":"牛4","value":34123,"win":0,"pokerTypeCode":"05"}}' },
          { field: 14, text: "[[],[],[],[],[]]" },
        ],
      },
    }),
    {
      roundId: "round-x",
      tableCode: "",
      field9: "",
      field10: "",
      field11: "",
      field12: "",
      field13: '{"0":{"type":"牛4","value":34123,"win":0,"pokerTypeCode":"05"}}',
      field14: "[[],[],[],[],[]]",
      niuniu: [{ index: "0", type: "牛4", value: 34123, win: 0, pokerTypeCode: "05" }],
      baccarat: { banker: [], player: [], bankerReadable: [], playerReadable: [], bankerPoint: "", playerPoint: "" },
    }
  );
});

test("readable target result shows niuniu result and hides raw field dump", () => {
  const line = formatReadable({
    direction: "received",
    type: "binary",
    at: "2026-07-13T14:03:42.955Z",
    eventName: "GameInfoReplay",
    size: 304,
    matchReason: "gameResult",
    matchDetail: {
      matchBy: "tableCode",
      tableInfo: { tableName: "Q牛牛1号", tableShortName: "牛1", tableCode: 47, roundIds: [] },
      result: {
        roundId: "260713w2904790079022",
        tableCode: 47,
        niuniu: [{ index: "0", type: "牛4", value: 34123, win: 0, pokerTypeCode: "05" }],
        field14: '[["v","x","g","Y","c","D"],["x","g","Y","c","D"],[],[],[]]',
      },
    },
  });

  assert.match(line, /结果=牛4/);
  assert.match(line, /value=34123/);
  assert.doesNotMatch(line, /结果字段/);
});

test("formats readable timestamp as Beijing time", () => {
  assert.equal(formatBeijingTime("2026-07-15T02:33:37.941Z"), "2026-07-15 10:33:37.941 北京时间");
  const line = formatReadable({
    direction: "received",
    type: "text",
    at: "2026-07-15T02:33:37.941Z",
    eventName: "GameInfoReplay",
    size: 1,
  });

  assert.match(line, /^\[2026-07-15 10:33:37\.941 北京时间\]/);
});

test("summarizes baccarat cards from field11 and field12", () => {
  assert.deepEqual(summarizeBaccaratCards('["D","i",""]', '["X","N","v"]', 3, 0), {
    banker: ["D", "i"],
    player: ["X", "N", "v"],
    bankerReadable: ["黑桃4", "梅花9"],
    playerReadable: ["红桃J", "红桃A", "方块9"],
    bankerPoint: 3,
    playerPoint: 0,
  });
});

test("decodes poker sprite letters to Chinese card names", () => {
  assert.equal(decodePokerCode("D"), "黑桃4");
  assert.equal(decodePokerCode("i"), "梅花9");
  assert.deepEqual(decodePokerCodes(["X", "N", "v"]), ["红桃J", "红桃A", "方块9"]);
});

test("readable baccarat result shows banker and player cards", () => {
  const line = formatReadable({
    direction: "received",
    type: "binary",
    at: "2026-07-15T02:11:28.058Z",
    eventName: "GameInfoReplay",
    size: 176,
    matchReason: "gameResult",
    matchDetail: {
      matchBy: "roundId",
      tableInfo: { tableName: "Q极速百27号", tableShortName: "百27", tableCode: 70, roundIds: ["round-4"] },
      result: {
        roundId: "260715w2907090039004",
        tableCode: 70,
        field9: 3,
        field10: 0,
        field11: '["D","i",""]',
        field12: '["X","N","v"]',
        field13: "{}",
        field14: "[[],[],[],[],[]]",
        niuniu: [],
        baccarat: {
          banker: ["D", "i"],
          player: ["X", "N", "v"],
          bankerReadable: ["黑桃4", "梅花9"],
          playerReadable: ["红桃J", "红桃A", "方块9"],
          bankerPoint: 3,
          playerPoint: 0,
        },
      },
    },
  });

  assert.match(line, /百家乐/);
  assert.match(line, /庄牌=黑桃4,梅花9/);
  assert.match(line, /闲牌=红桃J,红桃A,方块9/);
  assert.match(line, /原始牌=庄\[D,i\],闲\[X,N,v\]/);
  assert.match(line, /庄点=3/);
  assert.match(line, /闲点=0/);
  assert.doesNotMatch(line, /牌=\\[\\[\\]/);
});
