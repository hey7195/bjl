const fs = require("node:fs");
const path = require("node:path");

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

class MonitorStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.tablesPath = path.join(dataDir, "tables.jsonl");
    this.roundsPath = path.join(dataDir, "rounds.jsonl");
    this.eventsPath = path.join(dataDir, "events.jsonl");
    this.tables = new Map();
    this.rounds = new Map();
    this.roundsByTable = new Map();
    this.events = [];
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  load() {
    for (const table of readJsonLines(this.tablesPath)) {
      this.tables.set(String(table.tableCode), table);
    }
    for (const round of readJsonLines(this.roundsPath)) {
      this._putRound(round);
    }
    this.events = readJsonLines(this.eventsPath).slice(-1000);
  }

  appendJsonLine(filePath, value) {
    fs.appendFileSync(filePath, JSON.stringify(value) + "\n", "utf8");
  }

  saveEvent(event) {
    const record = { at: new Date().toISOString(), ...event };
    this.events.push(record);
    if (this.events.length > 1000) this.events.shift();
    this.appendJsonLine(this.eventsPath, record);
  }

  saveTable(tableInfo) {
    if (tableInfo.tableCode === "" || tableInfo.tableCode === undefined || tableInfo.tableCode === null) {
      return null;
    }
    const tableCode = String(tableInfo.tableCode);
    const previous = this.tables.get(tableCode) || {};
    const record = {
      ...previous,
      ...tableInfo,
      tableCode,
      updatedAt: new Date().toISOString(),
      roundCount: Array.isArray(tableInfo.roundIds) ? tableInfo.roundIds.length : previous.roundCount || 0,
    };
    this.tables.set(tableCode, record);
    this.appendJsonLine(this.tablesPath, record);
    return record;
  }

  saveRound(round) {
    const key = `${round.tableCode || ""}:${round.roundId}`;
    const previous = this.rounds.get(key) || {};
    const record = {
      ...previous,
      ...round,
      key,
      updatedAt: new Date().toISOString(),
      updateCount: Number(previous.updateCount || 0) + 1,
    };
    this._putRound(record);
    this.appendJsonLine(this.roundsPath, record);
    return record;
  }

  _putRound(round) {
    const key = round.key || `${round.tableCode || ""}:${round.roundId}`;
    const record = { ...round, key };
    this.rounds.set(key, record);
    const tableKey = String(record.tableCode || "");
    if (!this.roundsByTable.has(tableKey)) {
      this.roundsByTable.set(tableKey, new Map());
    }
    this.roundsByTable.get(tableKey).set(String(record.roundId), record);
  }

  listTables(query = "") {
    const q = String(query || "").trim().toLowerCase();
    return [...this.tables.values()]
      .filter((table) => {
        if (!q) return true;
        return [table.tableName, table.tableShortName, table.tableCode, table.internalIp]
          .map((value) => String(value || "").toLowerCase())
          .some((text) => text.includes(q));
      })
      .sort((a, b) => Number(a.tableCode) - Number(b.tableCode));
  }

  getTable(tableCode) {
    return this.tables.get(String(tableCode)) || null;
  }

  listRounds(tableCode, options = {}) {
    const pageSize = Math.max(1, Math.min(Number(options.pageSize || options.limit || 50), 500));
    const requestedPage = Math.max(1, Number(options.page || 1));
    const q = String(options.q || "").trim();
    const rounds = tableCode
      ? [...(this.roundsByTable.get(String(tableCode)) || new Map()).values()]
      : [...this.rounds.values()];
    const filtered = rounds
      .filter((round) => !q || String(round.roundId || "").includes(q))
      .sort((a, b) => String(b.roundId || "").localeCompare(String(a.roundId || "")));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const start = (page - 1) * pageSize;
    return {
      rounds: filtered.slice(start, start + pageSize),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    };
  }

  getRound(tableCode, roundId) {
    return this.rounds.get(`${tableCode}:${roundId}`) || null;
  }

  sameCardStats(options = {}) {
    const minCount = Math.max(1, Number(options.minCount || 2));
    const limit = Math.max(1, Math.min(Number(options.limit || 50), 200));
    const groups = {
      fastBaccarat: new Map(),
      baccarat: new Map(),
    };
    for (const round of this.rounds.values()) {
      const category = baccaratCategory(round);
      if (!category) continue;
      const bankerCards = cardArray(round.bankerRaw || round.bankerCards);
      const playerCards = cardArray(round.playerRaw || round.playerCards);
      if (!bankerCards.length || !playerCards.length) continue;
      const signature = `${bankerCards.join(",")}|${playerCards.join(",")}`;
      const bucket = groups[category];
      if (!bucket.has(signature)) {
        bucket.set(signature, {
          category,
          signature,
          bankerCards: displayCards(round.bankerCards, bankerCards),
          playerCards: displayCards(round.playerCards, playerCards),
          count: 0,
          rounds: [],
        });
      }
      const group = bucket.get(signature);
      group.count += 1;
      group.rounds.push({
        tableCode: round.tableCode,
        tableName: round.tableName,
        tableShortName: round.tableShortName,
        roundId: round.roundId,
        inningNumber: round.inningNumber,
        receivedAt: round.receivedAt || round.updatedAt,
        winner: round.winner,
        cardsText: round.cardsText,
      });
    }
    return {
      fastBaccarat: sortedSameCardGroups(groups.fastBaccarat, minCount, limit),
      baccarat: sortedSameCardGroups(groups.baccarat, minCount, limit),
    };
  }

  stats() {
    return {
      tables: this.tables.size,
      rounds: this.rounds.size,
      events: this.events.length,
      latestEvents: this.events.slice(-50).reverse(),
    };
  }
}

function cardArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function displayCards(value, fallback) {
  const cards = cardArray(value);
  return cards.length ? cards : fallback;
}

function baccaratCategory(round) {
  if (round.source === "TableInfoReplay.field8") return "";
  if (round.gameType !== "百家乐") return "";
  const text = [round.tableName || "", round.tableShortName || ""].join(" ");
  if (/极速/.test(text)) return "fastBaccarat";
  if (/百家乐|百|Baccarat|Bac/i.test(text)) return "baccarat";
  return "";
}

function sortedSameCardGroups(map, minCount, limit) {
  return [...map.values()]
    .filter((group) => group.count >= minCount)
    .sort((a, b) => b.count - a.count || String(b.rounds[0]?.receivedAt || "").localeCompare(String(a.rounds[0]?.receivedAt || "")))
    .slice(0, limit);
}

module.exports = {
  MonitorStore,
};
