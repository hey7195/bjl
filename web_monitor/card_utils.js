const {
  decodePokerCode,
  decodePokerCodes,
  summarizeBaccaratCards,
  summarizeNiuNiuResult,
} = require("../baccarat_one_monitor");

function parseJsonValue(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function baccaratWinner(bankerPoint, playerPoint) {
  const banker = Number(bankerPoint);
  const player = Number(playerPoint);
  if (!Number.isFinite(banker) || !Number.isFinite(player)) return "";
  if (banker > player) return "庄赢";
  if (banker < player) return "闲赢";
  return "和";
}

function summarizeTableResult(resultCode) {
  const text = String(resultCode || "");
  if (!text || text === "-1") return null;
  const baseResult = Number(text.slice(0, 3));
  if (!Number.isFinite(baseResult) || baseResult < 10 || baseResult >= 40) return null;
  const winnerCode = Math.floor(baseResult / 10);
  const pairCode = baseResult % 10;
  const winner = winnerCode === 1 ? "庄赢" : winnerCode === 2 ? "闲赢" : "和";
  const bankerPair = pairCode === 1 || pairCode === 3;
  const playerPair = pairCode === 2 || pairCode === 3;
  const parts = [winner];
  if (bankerPair) parts.push("庄对");
  if (playerPair) parts.push("闲对");
  return {
    gameType: "百家乐",
    winner,
    resultCode: text,
    baseResult,
    bankerPair,
    playerPair,
    cardsText: `路单结果：${parts.join("，")}`,
  };
}

function summarizeRound(result) {
  const niuniu = summarizeNiuNiuResult(result.field13 || "");
  if (niuniu.length) {
    const cards = parseJsonValue(result.field14, []);
    return {
      gameType: "牛牛",
      winner: niuniu.map((item) => item.type).join(","),
      niuniu,
      rawCards: cards,
      cardsText: Array.isArray(cards) ? JSON.stringify(cards) : "",
    };
  }

  const baccarat = result.baccarat || summarizeBaccaratCards(result.field11, result.field12, result.field9, result.field10);
  if (baccarat.banker.length || baccarat.player.length || result.field9 !== "" || result.field10 !== "") {
    const bankerReadable = baccarat.bankerReadable || decodePokerCodes(baccarat.banker);
    const playerReadable = baccarat.playerReadable || decodePokerCodes(baccarat.player);
    const winner = baccaratWinner(baccarat.bankerPoint, baccarat.playerPoint);
    return {
      gameType: "百家乐",
      winner: winner ? `${winner}(按点数推导)` : "",
      bankerPoint: baccarat.bankerPoint,
      playerPoint: baccarat.playerPoint,
      bankerCards: bankerReadable,
      playerCards: playerReadable,
      bankerRaw: baccarat.banker,
      playerRaw: baccarat.player,
      cardsText: `庄[${bankerReadable.join(",") || "-"}] 闲[${playerReadable.join(",") || "-"}]`,
    };
  }

  return {
    gameType: "未知",
    winner: JSON.stringify({ field9: result.field9, field10: result.field10 }),
    cardsText: "",
  };
}

module.exports = {
  baccaratWinner,
  decodePokerCode,
  decodePokerCodes,
  parseJsonValue,
  summarizeTableResult,
  summarizeRound,
};
