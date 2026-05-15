// API Time Machine — Popup UI
'use strict';

// ── State ────────────────────────────────────────────────────
let allRecords = [];
let filteredRecords = [];
let diffA = null;
let diffB = null;
let currentModal = null;
let currentModalTab = 'body';
let diffMode = 'shape';
let config = {};

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  setupListeners();
  renderFeed();
  renderChanges();
  updateStats();
});

// Listen for new records while popup is open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'NEW_RECORD') {
    allRecords.unshift(msg.record);
    applyFilters();
    renderFeed(true);
    renderChanges();
    updateStats();
  }
});

async function loadData() {
  const [recResp, cfgResp] = await Promise.all([
    sendBg({ type: 'GET_RECORDS' }),
    sendBg({ type: 'GET_CONFIG' }),
  ]);
  allRecords = recResp.records || [];
  config = cfgResp.config || {};
  applyFilters();
  loadSettingsUI();
  updateRecIndicator();
}

function sendBg(msg) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
      else res(r || {});
    });
  });
}

// ── Filters ──────────────────────────────────────────────────
function applyFilters() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const method = document.getElementById('methodFilter')?.value || '';
  filteredRecords = allRecords.filter(r => {
    if (method && r.method !== method) return false;
    if (q && !r.url.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ── Stats ────────────────────────────────────────────────────
function updateStats() {
  document.getElementById('totalCount').textContent = allRecords.length;
  document.getElementById('changedCount').textContent = detectAllChanges().length;
  const hosts = new Set(allRecords.map(r => r.host)).size;
  document.getElementById('hostCount').textContent = hosts;
}

// ── Feed render ───────────────────────────────────────────────
function renderFeed(prepend = false) {
  const list = document.getElementById('recordList');

  if (filteredRecords.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📡</div>
        <div class="empty-title">Waiting for API calls</div>
        <div class="empty-sub">Browse any page — JSON responses will appear here</div>
      </div>`;
    return;
  }

  // Full re-render (fast enough for 5000 items with virtual scroll hint)
  const frag = document.createDocumentFragment();
  filteredRecords.slice(0, 200).forEach((r, i) => {
    frag.appendChild(makeRecordEl(r, i === 0 && prepend));
  });
  list.innerHTML = '';
  list.appendChild(frag);
}

function makeRecordEl(r, flash = false) {
  const el = document.createElement('div');
  el.className = 'record-item' + (r.shapeChanged ? ' shape-changed' : '') + (flash ? ' new-flash' : '');
  el.dataset.id = r.id;

  const url = new URL(r.url);
  const hostSpan = `<span class="url-host">${url.hostname}</span>`;
  const path = url.pathname + (url.search ? url.search.slice(0, 30) + (url.search.length > 30 ? '…' : '') : '');

  const statusClass = r.statusCode >= 500 ? 'status-5xx'
    : r.statusCode >= 400 ? 'status-4xx'
    : r.statusCode >= 300 ? 'status-3xx'
    : 'status-2xx';

  const changeBadge = r.shapeChanged
    ? `<span class="change-badge">SHAPE CHANGED</span>` : '';

  el.innerHTML = `
    <div class="record-method method-${r.method}">${r.method}</div>
    <div class="record-body">
      <div class="record-url">${hostSpan}${escHtml(path)}</div>
      <div class="record-meta">
        <span class="record-time">${timeAgo(r.ts)}</span>
        <span class="record-status ${statusClass}">${r.statusCode}</span>
        ${changeBadge}
      </div>
    </div>`;

  el.addEventListener('click', () => openModal(r));
  return el;
}

// ── Changes detection ─────────────────────────────────────────
function detectAllChanges() {
  // Group by (host + path), sort by ts, flag where shapeHash differs from previous
  const groups = {};
  for (const r of allRecords) {
    const key = r.method + ':' + r.host + r.path;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  const changes = [];
  for (const [key, recs] of Object.entries(groups)) {
    // Sort ascending
    const sorted = [...recs].sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].shapeHash !== sorted[i - 1].shapeHash) {
        // Mark on record
        sorted[i].shapeChanged = true;
        changes.push({
          key,
          before: sorted[i - 1],
          after: sorted[i],
          url: sorted[i].url,
          method: sorted[i].method,
        });
      }
    }
  }
  return changes;
}

function renderChanges() {
  const changes = detectAllChanges();
  const list = document.getElementById('changesList');

  if (changes.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No shape changes detected</div>
        <div class="empty-sub">When an API response changes structure, it appears here</div>
      </div>`;
    return;
  }

  list.innerHTML = '';
  changes.slice(0, 100).forEach(c => {
    const el = document.createElement('div');
    el.className = 'change-item';
    const url = new URL(c.url);
    const diff = summarizeShapeDiff(c.before.shape, c.after.shape);
    el.innerHTML = `
      <div class="change-url">${escHtml(url.hostname + url.pathname)}</div>
      <div class="change-summary">${escHtml(diff)}</div>
      <div class="change-time">Changed ${timeAgo(c.after.ts)} · was ${timeAgo(c.before.ts)}</div>`;
    el.addEventListener('click', () => {
      diffA = c.before;
      diffB = c.after;
      updateDiffSlots();
      renderDiff();
      switchTab('diff');
    });
    list.appendChild(el);
  });
}

function summarizeShapeDiff(a, b) {
  if (!a || !b) return 'Shape changed (one side is null)';
  const aKeys = typeof a === 'object' && !Array.isArray(a) ? Object.keys(a) : [];
  const bKeys = typeof b === 'object' && !Array.isArray(b) ? Object.keys(b) : [];
  const added = bKeys.filter(k => !aKeys.includes(k));
  const removed = aKeys.filter(k => !bKeys.includes(k));
  const parts = [];
  if (added.length) parts.push(`+${added.length} keys (${added.slice(0, 3).join(', ')})`);
  if (removed.length) parts.push(`-${removed.length} keys (${removed.slice(0, 3).join(', ')})`);
  if (!parts.length) return 'Nested shape changed';
  return parts.join(', ');
}

// ── Diff engine ───────────────────────────────────────────────
function updateDiffSlots() {
  const slotA = document.getElementById('diffSlotA');
  const slotB = document.getElementById('diffSlotB');

  if (diffA) {
    slotA.innerHTML = `
      <div class="diff-slot-label">Version A</div>
      <div class="diff-slot-content">${escHtml(new URL(diffA.url).pathname)} · ${timeAgo(diffA.ts)}</div>`;
  }
  if (diffB) {
    slotB.innerHTML = `
      <div class="diff-slot-label">Version B</div>
      <div class="diff-slot-content">${escHtml(new URL(diffB.url).pathname)} · ${timeAgo(diffB.ts)}</div>`;
  }
}

function renderDiff() {
  const out = document.getElementById('diffOutput');
  if (!diffA || !diffB) {
    out.innerHTML = `<div class="empty-state"><div class="empty-icon">⚖️</div><div class="empty-title">Select two records to diff</div></div>`;
    return;
  }

  let linesA, linesB;
  if (diffMode === 'shape') {
    linesA = JSON.stringify(diffA.shape, null, 2).split('\n');
    linesB = JSON.stringify(diffB.shape, null, 2).split('\n');
  } else {
    try {
      linesA = JSON.stringify(JSON.parse(diffA.body), null, 2).split('\n');
      linesB = JSON.stringify(JSON.parse(diffB.body), null, 2).split('\n');
    } catch {
      linesA = (diffA.body || '').split('\n');
      linesB = (diffB.body || '').split('\n');
    }
  }

  const diffLines = computeDiff(linesA, linesB);
  out.innerHTML = '';
  diffLines.forEach(line => {
    const el = document.createElement('div');
    el.className = 'diff-line ' + line.type;
    const sign = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
    el.innerHTML = `<span class="diff-sign">${sign}</span>${escHtml(line.text)}`;
    out.appendChild(el);
  });
}

function computeDiff(a, b) {
  // Simple LCS-based line diff
  const m = Math.min(a.length, 200);
  const n = Math.min(b.length, 200);
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);

  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      result.push({ type: 'context', text: a[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      result.push({ type: 'added', text: b[j-1] }); j--;
    } else {
      result.push({ type: 'removed', text: a[i-1] }); i--;
    }
  }
  result.reverse();

  // Collapse long context runs
  const out = [];
  let ctx = [];
  for (const line of result) {
    if (line.type === 'context') {
      ctx.push(line);
    } else {
      if (ctx.length > 4) {
        if (out.length) out.push(...ctx.slice(0, 2));
        out.push({ type: 'context', text: `  … ${ctx.length - 4} unchanged lines …` });
        ctx = ctx.slice(-2);
      }
      out.push(...ctx);
      ctx = [];
      out.push(line);
    }
  }
  if (ctx.length <= 4) out.push(...ctx);
  else {
    out.push(...ctx.slice(0, 2));
    out.push({ type: 'context', text: `  … ${ctx.length - 4} unchanged lines …` });
  }
  return out;
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(r) {
  currentModal = r;
  currentModalTab = 'body';
  document.getElementById('modalTitle').textContent = new URL(r.url).hostname + new URL(r.url).pathname;
  const statusClass = r.statusCode >= 400 ? 'status-4xx' : 'status-2xx';
  document.getElementById('modalMeta').innerHTML = `
    <span class="record-method method-${r.method}">${r.method}</span>
    <span class="${statusClass}">${r.statusCode}</span>
    <span>${new Date(r.ts).toLocaleString()}</span>
    ${r.bodyTruncated ? '<span style="color:var(--amber)">body truncated</span>' : ''}`;
  renderModalTab('body');
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.mtab === 'body'));
  document.getElementById('modalOverlay').classList.add('open');
}

function renderModalTab(tab) {
  const content = document.getElementById('modalContent');
  currentModalTab = tab;
  if (!currentModal) return;
  const r = currentModal;

  if (tab === 'body') {
    try {
      const parsed = JSON.parse(r.body);
      content.innerHTML = syntaxHighlight(JSON.stringify(parsed, null, 2));
    } catch {
      content.textContent = r.body || '(empty)';
    }
  } else if (tab === 'shape') {
    content.innerHTML = syntaxHighlight(JSON.stringify(r.shape, null, 2));
  } else if (tab === 'headers') {
    const headers = r.responseHeaders || [];
    content.textContent = headers.map(h => `${h.name}: ${h.value}`).join('\n') || '(none)';
  }
}

// ── Settings UI ───────────────────────────────────────────────
function loadSettingsUI() {
  document.getElementById('settingEnabled').checked = config.enabled !== false;
  document.getElementById('settingFilters').value = (config.filters || []).join('\n');
  document.getElementById('settingExcludes').value = (config.excludePatterns || []).join('\n');
}

function updateRecIndicator() {
  const ind = document.getElementById('recIndicator');
  const btn = document.getElementById('toggleBtn');
  if (config.enabled !== false) {
    ind.classList.remove('paused');
    btn.textContent = '⏸';
    btn.title = 'Pause recording';
  } else {
    ind.classList.add('paused');
    btn.textContent = '▶';
    btn.title = 'Resume recording';
  }
}

// ── Event listeners ───────────────────────────────────────────
function setupListeners() {
  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Modal tabs
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      renderModalTab(btn.dataset.mtab);
    });
  });

  // Modal close
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Send to diff
  document.getElementById('sendToDiffA').addEventListener('click', () => {
    diffA = currentModal;
    closeModal();
    updateDiffSlots();
    renderDiff();
    switchTab('diff');
  });
  document.getElementById('sendToDiffB').addEventListener('click', () => {
    diffB = currentModal;
    closeModal();
    updateDiffSlots();
    renderDiff();
    switchTab('diff');
  });

  document.getElementById('deleteRecord').addEventListener('click', async () => {
    const id = currentModal?.id;
    if (!id) return;
    await sendBg({ type: 'DELETE_RECORD', id });
    allRecords = allRecords.filter(r => r.id !== id);
    closeModal();
    applyFilters();
    renderFeed();
    renderChanges();
    updateStats();
  });

  // Diff controls
  document.querySelectorAll('.diff-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.diff-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      diffMode = btn.dataset.mode;
      renderDiff();
    });
  });
  document.getElementById('clearDiffBtn').addEventListener('click', () => {
    diffA = diffB = null;
    document.getElementById('diffSlotA').innerHTML = `<div class="diff-slot-label">Version A</div><div class="diff-slot-placeholder">Select a record from Feed</div>`;
    document.getElementById('diffSlotB').innerHTML = `<div class="diff-slot-label">Version B</div><div class="diff-slot-placeholder">Select another record</div>`;
    renderDiff();
  });

  // Search/filter
  document.getElementById('searchInput').addEventListener('input', () => {
    applyFilters();
    renderFeed();
  });
  document.getElementById('methodFilter').addEventListener('change', () => {
    applyFilters();
    renderFeed();
  });

  // Toggle recording
  document.getElementById('toggleBtn').addEventListener('click', async () => {
    config.enabled = !config.enabled;
    await sendBg({ type: 'SET_CONFIG', config });
    updateRecIndicator();
  });

  // Settings
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    config.enabled = document.getElementById('settingEnabled').checked;
    config.filters = document.getElementById('settingFilters').value
      .split('\n').map(s => s.trim()).filter(Boolean);
    config.excludePatterns = document.getElementById('settingExcludes').value
      .split('\n').map(s => s.trim()).filter(Boolean);
    await sendBg({ type: 'SET_CONFIG', config });
    updateRecIndicator();
    showToast('Settings saved');
  });

  document.getElementById('clearAllBtn').addEventListener('click', async () => {
    if (!confirm('Clear all recorded responses?')) return;
    await sendBg({ type: 'CLEAR_RECORDS' });
    allRecords = [];
    filteredRecords = [];
    renderFeed();
    renderChanges();
    updateStats();
    showToast('All records cleared');
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  currentModal = null;
}

function showToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
    background:var(--bg3);border:1px solid var(--border);color:var(--amber);
    font-family:var(--mono);font-size:11px;padding:6px 14px;border-radius:4px;z-index:999;`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

// ── Helpers ───────────────────────────────────────────────────
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function syntaxHighlight(json) {
  return escHtml(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (m) => {
      let cls = 'json-num';
      if (/^"/.test(m)) cls = /:$/.test(m) ? 'json-key' : 'json-str';
      else if (/true|false/.test(m)) cls = 'json-bool';
      else if (/null/.test(m)) cls = 'json-null';
      return `<span class="${cls}">${m}</span>`;
    });
}
