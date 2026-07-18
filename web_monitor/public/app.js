const state = {
  tables: [],
  selectedTableCode: "",
  selectedRoundId: "",
  roundPage: 1,
  roundPageSize: 50,
  roundTotalPages: 1,
  videoPlayer: null,
  selectedVideoUrl: "",
};

const els = {
  status: document.querySelector("#status"),
  tableSearch: document.querySelector("#tableSearch"),
  tables: document.querySelector("#tables"),
  tableTitle: document.querySelector("#tableTitle"),
  tableMeta: document.querySelector("#tableMeta"),
  tabRounds: document.querySelector("#tabRounds"),
  tabSameCards: document.querySelector("#tabSameCards"),
  roundsPanel: document.querySelector("#roundsPanel"),
  sameCardsPanel: document.querySelector("#sameCardsPanel"),
  videoBox: document.querySelector("#videoBox"),
  videoUrls: document.querySelector("#videoUrls"),
  videoPlayerMount: document.querySelector("#videoPlayerMount"),
  videoPlayerStatus: document.querySelector("#videoPlayerStatus"),
  stopVideoBtn: document.querySelector("#stopVideoBtn"),
  roundSearch: document.querySelector("#roundSearch"),
  refreshBtn: document.querySelector("#refreshBtn"),
  pageSize: document.querySelector("#pageSize"),
  prevPageBtn: document.querySelector("#prevPageBtn"),
  nextPageBtn: document.querySelector("#nextPageBtn"),
  pageInput: document.querySelector("#pageInput"),
  paginationStatus: document.querySelector("#paginationStatus"),
  sameCards: document.querySelector("#sameCards"),
  rounds: document.querySelector("#rounds"),
  roundDetail: document.querySelector("#roundDetail"),
};

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function fmtTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function switchTab(tab) {
  const sameCards = tab === "sameCards";
  els.tabRounds.classList.toggle("active", !sameCards);
  els.tabSameCards.classList.toggle("active", sameCards);
  els.roundsPanel.classList.toggle("hidden", sameCards);
  els.sameCardsPanel.classList.toggle("hidden", !sameCards);
  if (sameCards) {
    loadSameCards().catch(console.error);
  }
}

function stopVideoPlayer() {
  if (state.videoPlayer) {
    state.videoPlayer.pause();
    state.videoPlayer.disconnect();
    state.videoPlayer = null;
  }
  state.selectedVideoUrl = "";
  els.videoPlayerMount.replaceChildren();
  els.videoPlayerStatus.textContent = "视频已停止。";
}

function startVideoPlayer(url) {
  if (!url) return;
  stopVideoPlayer();
  state.selectedVideoUrl = url;
  if (!window.WSAvcPlayer || !window.WSAvcPlayer.default) {
    els.videoPlayerStatus.textContent = "播放器资源未加载。";
    return;
  }
  const player = new WSAvcPlayer["default"]({ useWorker: true, workerFile: "/player/Decoder.js" });
  state.videoPlayer = player;
  const canvas = player.AvcPlayer && player.AvcPlayer.canvas;
  if (canvas) {
    canvas.className = "video-canvas";
    els.videoPlayerMount.appendChild(canvas);
  }
  player.on("connected", () => {
    els.videoPlayerStatus.textContent = `视频已连接：${url}`;
  });
  player.on("disconnected", () => {
    if (state.selectedVideoUrl === url) {
      els.videoPlayerStatus.textContent = `视频已断开：${url}`;
    }
  });
  player.on("start_render", () => {
    els.videoPlayerStatus.textContent = `正在播放：${url}`;
  });
  player.connect(url);
  els.videoPlayerStatus.textContent = `正在连接：${url}`;
}

async function loadStatus() {
  const data = await getJson("/api/status");
  const monitor = data.monitor;
  const store = data.store;
  els.status.textContent = [
    `socket=${monitor.connected ? "已连接" : "未连接"}`,
    `桌台=${store.tables} 已存开奖记录=${store.rounds}`,
    `重连=${monitor.reconnects} 解码错误=${monitor.socketStats.decodeErrors}`,
    `最后消息=${fmtTime(monitor.lastMessageAt) || "-"}`,
  ].join("\n");
}

async function loadTables() {
  const q = encodeURIComponent(els.tableSearch.value.trim());
  const data = await getJson(`/api/tables?q=${q}`);
  state.tables = data.tables || [];
  renderTables();
  if (!state.selectedTableCode && state.tables.length) {
    selectTable(state.tables[0].tableCode);
  }
}

async function loadSameCards() {
  const data = await getJson("/api/same-cards?minCount=2&limit=30");
  renderSameCards(data.stats || {});
}

function renderSameCards(stats) {
  const sections = [
    ["极速百家乐", stats.fastBaccarat || []],
    ["百家乐", stats.baccarat || []],
  ];
  els.sameCards.innerHTML = sections
    .map(([title, groups]) => `
      <div class="same-card-section">
        <div class="same-card-title">${escapeHtml(title)} · ${groups.length}</div>
        ${groups.length ? groups.map(renderSameCardGroup).join("") : '<div class="muted">暂无相同牌面。</div>'}
      </div>
    `)
    .join("");
}

function renderSameCardGroup(group) {
  const cards = `庄[${(group.bankerCards || []).join(",")}] 闲[${(group.playerCards || []).join(",")}]`;
  const rounds = (group.rounds || [])
    .map(
      (round) =>
        `${round.tableName || round.tableShortName || round.tableCode} 第${round.inningNumber || "-"}局 ` +
        `${fmtTime(round.receivedAt) || "-"} ${round.roundId}`
    )
    .join("；");
  return `
    <div class="same-card-item">
      <div><strong>重复 ${escapeHtml(group.count)} 次</strong> ${escapeHtml(cards)}</div>
      <div class="same-card-rounds">${escapeHtml(rounds)}</div>
    </div>
  `;
}

function renderTables() {
  els.tables.innerHTML = state.tables
    .map((table) => {
      const active = String(table.tableCode) === String(state.selectedTableCode) ? " active" : "";
      return `
        <button class="table-item${active}" data-code="${escapeHtml(table.tableCode)}">
          <div class="table-name">
            <span>${escapeHtml(table.tableName || table.tableShortName || "未知桌台")}</span>
            <span>#${escapeHtml(table.tableCode)}</span>
          </div>
          <div class="table-sub">${escapeHtml(table.tableShortName || "-")} · 路单局数 ${escapeHtml(table.roundCount || 0)} · ${escapeHtml(table.internalIp || "")}</div>
        </button>
      `;
    })
    .join("");
  for (const item of els.tables.querySelectorAll(".table-item")) {
    item.addEventListener("click", () => selectTable(item.dataset.code));
  }
}

async function selectTable(tableCode) {
  state.selectedTableCode = String(tableCode);
  state.selectedRoundId = "";
  state.roundPage = 1;
  stopVideoPlayer();
  renderTables();
  els.roundDetail.textContent = "点击一条开奖记录查看原始字段。";
  const data = await getJson(`/api/tables/${encodeURIComponent(tableCode)}?page=1&pageSize=${state.roundPageSize}`);
  renderTableDetail(data.table);
  renderRounds(data.rounds || []);
  renderPagination(data.pagination);
}

function renderTableDetail(table) {
  els.tableTitle.textContent = `${table.tableName || "未知桌台"} / ${table.tableShortName || "-"} / #${table.tableCode}`;
  els.tableMeta.textContent = `内网=${table.internalIp || "-"} 更新=${fmtTime(table.updatedAt)} 路单局数=${table.roundCount || 0}`;
  const urls = table.videoUrls || [];
  els.videoBox.classList.toggle("hidden", urls.length === 0);
  els.videoUrls.innerHTML = urls
    .map((url) => `<button class="video-url" data-url="${escapeHtml(url)}">${escapeHtml(url)}</button>`)
    .join("");
  for (const item of els.videoUrls.querySelectorAll(".video-url")) {
    item.addEventListener("click", () => startVideoPlayer(item.dataset.url));
  }
  if (urls.length) {
    startVideoPlayer(urls[0]);
  } else {
    els.videoPlayerStatus.textContent = "当前桌台没有视频流地址。";
    els.videoPlayerMount.replaceChildren();
  }
}

function renderRounds(rounds) {
  els.rounds.innerHTML = rounds
    .map((round) => `
      <tr data-round="${escapeHtml(round.roundId)}">
        <td>${escapeHtml(fmtTime(round.receivedAt || round.updatedAt))}</td>
        <td>${escapeHtml(round.inningNumber || "")}</td>
        <td>${escapeHtml(round.roundId)}</td>
        <td>${escapeHtml(round.gameType || "")}</td>
        <td>${escapeHtml(round.winner || "")}</td>
        <td>${escapeHtml(round.cardsText || "")}</td>
        <td>${escapeHtml(round.updateCount || 1)}</td>
      </tr>
    `)
    .join("");
  for (const row of els.rounds.querySelectorAll("tr")) {
    row.addEventListener("click", () => selectRound(row.dataset.round));
  }
}

function renderPagination(pagination) {
  if (!pagination) return;
  state.roundPage = pagination.page;
  state.roundPageSize = pagination.pageSize;
  state.roundTotalPages = pagination.totalPages;
  els.pageSize.value = String(pagination.pageSize);
  els.pageInput.value = String(pagination.page);
  els.pageInput.max = String(pagination.totalPages);
  els.prevPageBtn.disabled = pagination.page <= 1;
  els.nextPageBtn.disabled = pagination.page >= pagination.totalPages;
  els.paginationStatus.textContent = `共 ${pagination.total} 条 / ${pagination.totalPages} 页`;
}

async function loadRounds() {
  if (!state.selectedTableCode) return;
  const q = encodeURIComponent(els.roundSearch.value.trim());
  const data = await getJson(
    `/api/tables/${encodeURIComponent(state.selectedTableCode)}/rounds?page=${state.roundPage}&pageSize=${state.roundPageSize}&q=${q}`
  );
  renderRounds(data.rounds || []);
  renderPagination(data.pagination);
}

async function selectRound(roundId) {
  state.selectedRoundId = roundId;
  const data = await getJson(`/api/tables/${encodeURIComponent(state.selectedTableCode)}/rounds/${encodeURIComponent(roundId)}`);
  els.roundDetail.textContent = JSON.stringify(data.round, null, 2);
}

async function refreshAll() {
  try {
    await loadStatus();
    await loadTables();
    await loadSameCards();
    if (state.selectedTableCode) await loadRounds();
  } catch (error) {
    els.status.textContent = `加载失败：${error.message}`;
  }
}

els.tableSearch.addEventListener("input", () => loadTables().catch(console.error));
els.roundSearch.addEventListener("input", () => {
  state.roundPage = 1;
  loadRounds().catch(console.error);
});
els.refreshBtn.addEventListener("click", () => refreshAll().catch(console.error));
els.stopVideoBtn.addEventListener("click", stopVideoPlayer);
els.tabRounds.addEventListener("click", () => switchTab("rounds"));
els.tabSameCards.addEventListener("click", () => switchTab("sameCards"));
els.pageSize.addEventListener("change", () => {
  state.roundPageSize = Number(els.pageSize.value);
  state.roundPage = 1;
  loadRounds().catch(console.error);
});
els.prevPageBtn.addEventListener("click", () => {
  state.roundPage = Math.max(1, state.roundPage - 1);
  loadRounds().catch(console.error);
});
els.nextPageBtn.addEventListener("click", () => {
  state.roundPage = Math.min(state.roundTotalPages, state.roundPage + 1);
  loadRounds().catch(console.error);
});
els.pageInput.addEventListener("change", () => {
  state.roundPage = Math.max(1, Math.min(Number(els.pageInput.value || 1), state.roundTotalPages));
  loadRounds().catch(console.error);
});

refreshAll();
setInterval(() => {
  loadStatus().catch(console.error);
  loadSameCards().catch(console.error);
  if (state.selectedTableCode) loadRounds().catch(console.error);
}, 3000);
setInterval(() => loadTables().catch(console.error), 10000);
