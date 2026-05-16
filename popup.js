// API Time Machine — Popup UI (v2)
'use strict';

// ── State ────────────────────────────────────────────────────
let allRecords    = [];
let filteredRecords = [];
let shapeHistory  = {};   // { endpointKey: { ts, shapeHash, shape, recordId, changes[] } }
let diffA = null;
let diffB = null;
let currentModal  = null;
let currentModalTab = 'body';
let diffMode = 'shape';
let config = {};

// ── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  setupListeners();
  renderFeed();
  renderChanges();
  renderHistory();
  updateStats();
});

// Live updates while popup is open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'NEW_RECORD') return;
  allRecords.unshift(msg.record);
  applyFilters();
  renderFeed(true);
  renderChanges();
  renderHistory();
  updateStats();
});

// ── Data loading ──────────────────────────────────────────────
async function loadData() {
  const [recResp, cfgResp, histResp] = await Promise.all([
    sendBg({ type: 'GET_RECORDS' }),
    sendBg({ type: 'GET_CONFIG' }),
    sendBg({ type: 'GET_SHAPE_HISTORY' }),
  ]);
  allRecords   = recResp.records  || [];
  config       = cfgResp.config   || {};
  shapeHistory = histResp.history || {};
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

// ── Feed filter ───────────────────────────────────────────────
function applyFilters() {
  const q      = (qs('#searchInput')?.value || '').toLowerCase();
  const method = qs('#methodFilter')?.value || '';
  filteredRecords = allRecords.filter(r => {
    if (method && r.method !== method) return false;
    if (q && !r.url.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ── Stats bar ─────────────────────────────────────────────────
function updateStats() {
  qs('#totalCount').textContent   = allRecords.length;
  qs('#changedCount').textContent = detectAllChanges().length;
  qs('#hostCount').textContent    = new Set(allRecords.map(r => r.host)).size;
}

// ── Feed ──────────────────────────────────────────────────────
function renderFeed(prepend = false) {
  const list = qs('#recordList');
  if (filteredRecords.length === 0) {
    list.innerHTML = emptyState('📡', 'Waiting for API calls', 'Browse any page — JSON responses will appear here');
    return;
  }
  const frag = document.createDocumentFragment();
  filteredRecords.slice(0, 200).forEach((r, i) => frag.appendChild(makeRecordEl(r, i === 0 && prepend)));
  list.innerHTML = '';
  list.appendChild(frag);
}

function makeRecordEl(r, flash = false) {
  const el = document.createElement('div');
  el.className = 'record-item'
    + (r.shapeChanged ? ' shape-changed' : '')
    + (flash ? ' new-flash' : '');
  el.dataset.id = r.id;

  const url  = tryURL(r.url);
  const host = url ? url.hostname : r.host;
  const path = url
    ? url.pathname + (url.search.length > 1 ? url.search.slice(0, 30) + (url.search.length > 31 ? '…' : '') : '')
    : r.url;

  const statusClass = r.statusCode >= 500 ? 'status-5xx'
    : r.statusCode >= 400 ? 'status-4xx'
    : r.statusCode >= 300 ? 'status-3xx' : 'status-2xx';

  const changeBadge  = r.shapeChanged ? `<span class="change-badge">SHAPE CHANGED</span>` : '';
  const reqBodyBadge = r.requestBody  ? `<span class="change-badge" style="background:rgba(74,158,255,0.15);color:var(--blue)">REQ BODY</span>` : '';

  el.innerHTML = `
    <div class="record-method method-${r.method}">${r.method}</div>
    <div class="record-body">
      <div class="record-url"><span class="url-host">${escHtml(host)}</span>${escHtml(path)}</div>
      <div class="record-meta">
        <span class="record-time">${timeAgo(r.ts)}</span>
        <span class="record-status ${statusClass}">${r.statusCode}</span>
        ${changeBadge}${reqBodyBadge}
      </div>
    </div>`;
  el.addEventListener('click', () => openModal(r));
  return el;
}

// ── Changes detection ─────────────────────────────────────────
function detectAllChanges() {
  const groups = {};
  for (const r of allRecords) {
    const key = r.method + ':' + r.host + r.path;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  const changes = [];
  for (const recs of Object.values(groups)) {
    const sorted = [...recs].sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].shapeHash !== sorted[i - 1].shapeHash) {
        sorted[i].shapeChanged = true;
        changes.push({ before: sorted[i - 1], after: sorted[i] });
      }
    }
  }
  return changes;
}

function renderChanges() {
  const list    = qs('#changesList');
  const changes = detectAllChanges();
  if (changes.length === 0) {
    list.innerHTML = emptyState('🔍', 'No shape changes detected', 'When an API response changes structure, it appears here');
    return;
  }
  list.innerHTML = '';
  changes.slice(0, 100).forEach(c => {
    const el  = document.createElement('div');
    el.className = 'change-item';
    const url  = tryURL(c.after.url);
    const diff = summarizeShapeDiff(c.before.shape, c.after.shape);
    el.innerHTML = `
      <div class="change-url">${escHtml(url ? url.hostname + url.pathname : c.after.url)}</div>
      <div class="change-summary">${escHtml(diff)}</div>
      <div class="change-time">Changed ${timeAgo(c.after.ts)} · was ${timeAgo(c.before.ts)}</div>`;
    el.addEventListener('click', () => {
      diffA = c.before; diffB = c.after;
      updateDiffSlots(); renderDiff(); switchTab('diff');
    });
    list.appendChild(el);
  });
}

function summarizeShapeDiff(a, b) {
  if (!a || !b) return 'Shape changed (one side is null)';
  const aKeys = isPlainObj(a) ? Object.keys(a) : [];
  const bKeys = isPlainObj(b) ? Object.keys(b) : [];
  const added   = bKeys.filter(k => !aKeys.includes(k));
  const removed = aKeys.filter(k => !bKeys.includes(k));
  const parts   = [];
  if (added.length)   parts.push(`+${added.length} keys (${added.slice(0, 3).join(', ')})`);
  if (removed.length) parts.push(`-${removed.length} keys (${removed.slice(0, 3).join(', ')})`);
  return parts.length ? parts.join(', ') : 'Nested shape changed';
}

// ── Shape History view ────────────────────────────────────────
function renderHistory() {
  const list = qs('#historyList');
  const keys = Object.keys(shapeHistory);

  if (keys.length === 0) {
    list.innerHTML = emptyState('🗂️', 'No shape history yet', 'Shape versions appear here as endpoints evolve');
    return;
  }

  list.innerHTML = '';

  // Sort: most recently active first
  const sorted = keys.sort((a, b) => (shapeHistory[b]?.ts || 0) - (shapeHistory[a]?.ts || 0));

  sorted.forEach(endpointKey => {
    const entry    = shapeHistory[endpointKey];
    const changes  = entry.changes || [];
    const versions = buildVersionTimeline(entry, changes);

    // Parse "METHOD:host/path"
    const colonIdx = endpointKey.indexOf(':');
    const method   = endpointKey.slice(0, colonIdx);
    const hostPath = endpointKey.slice(colonIdx + 1);
    const slashIdx = hostPath.indexOf('/');
    const host     = slashIdx >= 0 ? hostPath.slice(0, slashIdx) : hostPath;
    const path     = slashIdx >= 0 ? hostPath.slice(slashIdx)    : '/';

    const group = document.createElement('div');
    group.className = 'history-endpoint';
    group.innerHTML = `
      <div class="history-endpoint-header">
        <div class="record-method method-${method}" style="flex-shrink:0">${method}</div>
        <div class="history-endpoint-url">
          <span class="url-host">${escHtml(host)}</span>${escHtml(path)}
        </div>
        <span class="history-version-count">${versions.length} version${versions.length !== 1 ? 's' : ''}</span>
        <span class="history-chevron">▶</span>
      </div>
      <div class="history-timeline"></div>`;

    const header   = group.querySelector('.history-endpoint-header');
    const timeline = group.querySelector('.history-timeline');

    versions.forEach((v, idx) => {
      const isLatest  = idx === versions.length - 1;
      const isInitial = idx === 0;
      const isChange  = v.isChange;

      const vEl = document.createElement('div');
      vEl.className = 'history-version'
        + (isChange ? ' is-change' : '')
        + (isLatest ? ' is-latest' : '');

      const labelHtml = isLatest  ? `<span class="history-version-label label-latest">LATEST</span>`
        : isInitial ? `<span class="history-version-label label-initial">INITIAL</span>`
        : isChange  ? `<span class="history-version-label label-change">CHANGED</span>` : '';

      const diffSummary = isChange && v.prevShape
        ? `<div class="history-version-diff-summary">${escHtml(summarizeShapeDiff(v.prevShape, v.shape))}</div>`
        : '';

      vEl.innerHTML = `
        <div>
          <span class="history-version-time">${new Date(v.ts).toLocaleString()}</span>
          <span class="history-version-hash">#${v.shapeHash}</span>
          ${labelHtml}
        </div>
        ${diffSummary}
        <div class="history-version-actions">
          <button class="btn-sm view-shape-btn">View shape</button>
          ${isChange ? '<button class="btn-sm diff-this-btn">Diff vs prev</button>' : ''}
        </div>`;

      vEl.querySelector('.view-shape-btn').addEventListener('click', () => {
        showShapeModal(v.shape, `${method} ${hostPath} · ${timeAgo(v.ts)}`);
      });

      if (isChange) {
        vEl.querySelector('.diff-this-btn').addEventListener('click', () => {
          const afterRecord  = allRecords.find(r => r.id === v.recordId);
          const beforeRecord = allRecords.find(r => r.id === v.prevRecordId);
          if (afterRecord && beforeRecord) {
            diffA = beforeRecord; diffB = afterRecord;
          } else {
            // Synthetic fallback when original records are pruned
            diffA = { url: `https://${hostPath}`, method, ts: v.prevTs, shape: v.prevShape, shapeHash: v.prevShapeHash, body: null };
            diffB = { url: `https://${hostPath}`, method, ts: v.ts,     shape: v.shape,     shapeHash: v.shapeHash,     body: null };
          }
          updateDiffSlots(); renderDiff(); switchTab('diff');
        });
      }

      timeline.appendChild(vEl);
    });

    header.addEventListener('click', () => group.classList.toggle('open'));
    list.appendChild(group);
  });
}

function buildVersionTimeline(entry, changes) {
  if (changes.length === 0) {
    return [{ ts: entry.ts, shapeHash: entry.shapeHash, shape: entry.shape, recordId: entry.recordId, isChange: false }];
  }
  const versions = [];
  const first = changes[0];
  // Initial shape before first change
  versions.push({ ts: first.prevTs, shapeHash: first.prevShapeHash, shape: first.prevShape, recordId: first.prevRecordId, isChange: false });
  // Each subsequent change
  changes.forEach(c => versions.push({
    ts: c.ts, shapeHash: c.shapeHash, shape: c.shape, recordId: c.recordId,
    prevShape: c.prevShape, prevShapeHash: c.prevShapeHash, prevRecordId: c.prevRecordId, prevTs: c.prevTs,
    isChange: true,
  }));
  return versions;
}

function showShapeModal(shape, title) {
  qs('#modalTitle').textContent = title;
  qs('#modalMeta').innerHTML    = '';
  qs('#modalContent').innerHTML = syntaxHighlight(JSON.stringify(shape, null, 2));
  qs('.modal-tabs').style.display    = 'none';
  qs('.modal-actions').style.display = 'none';
  const overlay = qs('#modalOverlay');
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}

// ── Diff ──────────────────────────────────────────────────────
function updateDiffSlots() {
  if (diffA) qs('#diffSlotA').innerHTML = `
    <div class="diff-slot-label">Version A</div>
    <div class="diff-slot-content">${escHtml(tryURL(diffA.url)?.pathname || diffA.url)} · ${timeAgo(diffA.ts)}</div>`;
  if (diffB) qs('#diffSlotB').innerHTML = `
    <div class="diff-slot-label">Version B</div>
    <div class="diff-slot-content">${escHtml(tryURL(diffB.url)?.pathname || diffB.url)} · ${timeAgo(diffB.ts)}</div>`;
}

function renderDiff() {
  const out = qs('#diffOutput');
  if (!diffA || !diffB) {
    out.innerHTML = emptyState('⚖️', 'Select two records to diff', 'Click "Send to Diff A/B" from any record');
    return;
  }
  let linesA, linesB;
  if (diffMode === 'shape') {
    linesA = JSON.stringify(diffA.shape, null, 2).split('\n');
    linesB = JSON.stringify(diffB.shape, null, 2).split('\n');
  } else {
    try {
      linesA = JSON.stringify(JSON.parse(diffA.body || 'null'), null, 2).split('\n');
      linesB = JSON.stringify(JSON.parse(diffB.body || 'null'), null, 2).split('\n');
    } catch {
      linesA = (diffA.body || '').split('\n');
      linesB = (diffB.body || '').split('\n');
    }
  }
  out.innerHTML = '';
  computeDiff(linesA, linesB).forEach(line => {
    const el = document.createElement('div');
    el.className = 'diff-line ' + line.type;
    const sign = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
    el.innerHTML = `<span class="diff-sign">${sign}</span>${escHtml(line.text)}`;
    out.appendChild(el);
  });
}

function computeDiff(a, b) {
  const m = Math.min(a.length, 200), n = Math.min(b.length, 200);
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);

  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) { result.push({ type: 'context', text: a[i-1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { result.push({ type: 'added',   text: b[j-1] }); j--; }
    else { result.push({ type: 'removed', text: a[i-1] }); i--; }
  }
  result.reverse();

  // Collapse long unchanged runs
  const CTX = 2;
  const out = [];
  let ctx = [];
  const flush = () => {
    if (ctx.length > CTX * 2) {
      out.push(...ctx.slice(0, CTX));
      out.push({ type: 'context', text: `  … ${ctx.length - CTX * 2} unchanged lines …` });
      out.push(...ctx.slice(-CTX));
    } else { out.push(...ctx); }
    ctx = [];
  };
  for (const line of result) {
    if (line.type === 'context') { ctx.push(line); } else { flush(); out.push(line); }
  }
  flush();
  return out;
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(r) {
  currentModal = r;
  qs('.modal-tabs').style.display    = '';
  qs('.modal-actions').style.display = '';

  const url = tryURL(r.url);
  qs('#modalTitle').textContent = url ? url.hostname + url.pathname : r.url;

  const statusClass = r.statusCode >= 400 ? 'status-4xx' : 'status-2xx';
  qs('#modalMeta').innerHTML = `
    <span class="record-method method-${r.method}">${r.method}</span>
    <span class="${statusClass}">${r.statusCode}</span>
    <span>${new Date(r.ts).toLocaleString()}</span>
    ${r.bodyTruncated ? '<span style="color:var(--amber)">response truncated</span>' : ''}
    ${r.requestBody   ? '<span style="color:var(--blue)">has request body</span>'   : ''}`;

  // Default to Request tab for mutation methods that have a body
  const defaultTab = (r.requestBody && ['POST','PUT','PATCH'].includes(r.method)) ? 'request' : 'body';
  qsa('.modal-tab').forEach(t => {
    const selected = t.dataset.mtab === defaultTab;
    t.classList.toggle('active', selected);
    t.setAttribute('aria-selected', selected);
  });
  renderModalTab(defaultTab);
  const overlay = qs('#modalOverlay');
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}

function renderModalTab(tab) {
  const content = qs('#modalContent');
  currentModalTab = tab;
  if (!currentModal) return;
  const r = currentModal;

  if (tab === 'body') {
    if (!r.body) { content.textContent = '(no response body)'; return; }
    try { content.innerHTML = syntaxHighlight(JSON.stringify(JSON.parse(r.body), null, 2)); }
    catch { content.textContent = r.body; }

  } else if (tab === 'request') {
    let out = '';
    const reqHeaders = r.requestHeaders || [];
    if (reqHeaders.length) {
      out += '── Request Headers ──────────────────\n';
      out += reqHeaders.map(h => `${h.name}: ${h.value}`).join('\n') + '\n\n';
    }
    if (r.requestBody) {
      out += '── Request Body ─────────────────────\n';
      try {
        const parsed = JSON.parse(r.requestBody);
        content.innerHTML = escHtml(out) + syntaxHighlight(JSON.stringify(parsed, null, 2));
        return;
      } catch {
        out += r.requestBody;
      }
      if (r.requestBodyTruncated) out += '\n… (truncated at 20KB)';
    } else {
      out += '(no request body)';
    }
    content.textContent = out;

  } else if (tab === 'shape') {
    content.innerHTML = syntaxHighlight(JSON.stringify(r.shape, null, 2));

  } else if (tab === 'headers') {
    const headers = r.responseHeaders || [];
    content.textContent = headers.length
      ? headers.map(h => `${h.name}: ${h.value}`).join('\n')
      : '(no response headers captured)';
  }
}

// ── Export / Import ───────────────────────────────────────────
async function exportJson() {
  const { records, history } = await sendBg({ type: 'EXPORT_RECORDS' });
  const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records, shapeHistory: history }, null, 2);
  download(payload, `api-time-machine-${dateSlug()}.json`, 'application/json');
}

async function exportHar() {
  const { records } = await sendBg({ type: 'EXPORT_RECORDS' });
  const entries = records.map(r => {
    const resHeaders = (r.responseHeaders || []).map(h => ({ name: h.name, value: h.value }));
    const reqHeaders = (r.requestHeaders  || []).map(h => ({ name: h.name, value: h.value }));
    const mimeType   = resHeaders.find(h => h.name.toLowerCase() === 'content-type')?.value || 'application/json';
    const bodyText   = r.body || '';
    const urlObj     = tryURL(r.url);
    return {
      startedDateTime: new Date(r.ts).toISOString(),
      time: 0,
      request: {
        method:      r.method,
        url:         r.url,
        httpVersion: 'HTTP/1.1',
        cookies:     [],
        headers:     reqHeaders,
        queryString: urlObj ? [...urlObj.searchParams.entries()].map(([name, value]) => ({ name, value })) : [],
        postData:    r.requestBody ? { mimeType: 'application/json', text: r.requestBody } : undefined,
        headersSize: -1,
        bodySize:    r.requestBody ? r.requestBody.length : 0,
      },
      response: {
        status:      r.statusCode,
        statusText:  String(r.statusCode),
        httpVersion: 'HTTP/1.1',
        cookies:     [],
        headers:     resHeaders,
        content:     { size: bodyText.length, mimeType, text: bodyText },
        redirectURL: '',
        headersSize: -1,
        bodySize:    bodyText.length,
      },
      cache:   {},
      timings: { send: 0, wait: 0, receive: 0 },
    };
  });

  const har = { log: { version: '1.2', creator: { name: 'API Time Machine', version: '1.0' }, entries } };
  download(JSON.stringify(har, null, 2), `api-time-machine-${dateSlug()}.har`, 'application/json');
}

async function importJson(file) {
  const statusEl = qs('#importStatus');
  statusEl.textContent = 'Reading…';
  statusEl.className = '';
  try {
    const text    = await file.text();
    const data    = JSON.parse(text);
    const records = data.records || (Array.isArray(data) ? data : []);
    if (records.length === 0) throw new Error('No records found in file');
    const resp    = await sendBg({ type: 'IMPORT_RECORDS', records });
    const [recResp, histResp] = await Promise.all([
      sendBg({ type: 'GET_RECORDS' }),
      sendBg({ type: 'GET_SHAPE_HISTORY' }),
    ]);
    allRecords   = recResp.records  || [];
    shapeHistory = histResp.history || {};
    applyFilters();
    renderFeed(); renderChanges(); renderHistory(); updateStats();
    statusEl.textContent = `✓ Imported ${records.length} records (${resp.count} total)`;
    statusEl.className = 'ok';
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className = 'err';
  }
}

function download(text, filename, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateSlug() { return new Date().toISOString().slice(0, 10); }

// ── Settings ──────────────────────────────────────────────────
function loadSettingsUI() {
  qs('#settingEnabled').checked = config.enabled !== false;
  qs('#settingNotify').checked  = !!config.notifyOnShapeChange;
  qs('#settingFilters').value   = (config.filters || []).join('\n');
  qs('#settingExcludes').value  = (config.excludePatterns || []).join('\n');
}

function updateRecIndicator() {
  const on  = config.enabled !== false;
  const ind = qs('#recIndicator');
  const btn = qs('#toggleBtn');
  ind.classList.toggle('paused', !on);
  ind.setAttribute('aria-label', on ? 'Recording active' : 'Recording paused');
  btn.textContent              = on ? '⏸' : '▶';
  btn.title                    = on ? 'Pause recording' : 'Resume recording';
  btn.setAttribute('aria-label',   on ? 'Pause recording' : 'Resume recording');
  btn.setAttribute('aria-pressed',  on ? 'true' : 'false');
}

// ── Event wiring ──────────────────────────────────────────────
function setupListeners() {
  qsa('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  qsa('.modal-tab').forEach(btn => btn.addEventListener('click', () => {
    qsa('.modal-tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    renderModalTab(btn.dataset.mtab);
  }));

  qs('#modalClose').addEventListener('click', closeModal);
  qs('#modalOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

  qs('#sendToDiffA').addEventListener('click', () => {
    diffA = currentModal; closeModal(); updateDiffSlots(); renderDiff(); switchTab('diff');
  });
  qs('#sendToDiffB').addEventListener('click', () => {
    diffB = currentModal; closeModal(); updateDiffSlots(); renderDiff(); switchTab('diff');
  });

  qs('#deleteRecord').addEventListener('click', async () => {
    const id = currentModal?.id; if (!id) return;
    await sendBg({ type: 'DELETE_RECORD', id });
    allRecords = allRecords.filter(r => r.id !== id);
    closeModal(); applyFilters(); renderFeed(); renderChanges(); renderHistory(); updateStats();
  });

  qsa('.diff-mode-btn').forEach(btn => btn.addEventListener('click', () => {
    qsa('.diff-mode-btn').forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-pressed', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
    diffMode = btn.dataset.mode;
    renderDiff();
  }));

  qs('#clearDiffBtn').addEventListener('click', () => {
    diffA = diffB = null;
    qs('#diffSlotA').innerHTML = `<div class="diff-slot-label">Version A</div><div class="diff-slot-placeholder">Select a record from Feed</div>`;
    qs('#diffSlotB').innerHTML = `<div class="diff-slot-label">Version B</div><div class="diff-slot-placeholder">Select another record</div>`;
    renderDiff();
  });

  qs('#searchInput').addEventListener('input', () => { applyFilters(); renderFeed(); });
  qs('#methodFilter').addEventListener('change', () => { applyFilters(); renderFeed(); });

  qs('#toggleBtn').addEventListener('click', async () => {
    config.enabled = !config.enabled;
    await sendBg({ type: 'SET_CONFIG', config });
    updateRecIndicator();
  });

  qs('#saveSettingsBtn').addEventListener('click', async () => {
    config.enabled             = qs('#settingEnabled').checked;
    config.notifyOnShapeChange = qs('#settingNotify').checked;
    config.filters             = qs('#settingFilters').value.split('\n').map(s => s.trim()).filter(Boolean);
    config.excludePatterns     = qs('#settingExcludes').value.split('\n').map(s => s.trim()).filter(Boolean);
    await sendBg({ type: 'SET_CONFIG', config });
    updateRecIndicator();
    showToast('Settings saved');
  });

  qs('#clearAllBtn').addEventListener('click', async () => {
    if (!confirm('Clear all recorded responses and shape history?')) return;
    await sendBg({ type: 'CLEAR_RECORDS' });
    allRecords = []; filteredRecords = []; shapeHistory = {};
    renderFeed(); renderChanges(); renderHistory(); updateStats();
    showToast('All records cleared');
  });

  qs('#clearShapeHistoryBtn').addEventListener('click', async () => {
    if (!confirm('Clear shape history? (Records are kept)')) return;
    await sendBg({ type: 'CLEAR_SHAPE_HISTORY' });
    shapeHistory = {};
    renderHistory();
    showToast('Shape history cleared');
  });

  qs('#exportJsonBtn').addEventListener('click', exportJson);
  qs('#exportHarBtn').addEventListener('click',  exportHar);

  qs('#importFileInput').addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) importJson(file);
    e.target.value = '';
  });
}

// ── Helpers ───────────────────────────────────────────────────
function switchTab(name) {
  qsa('.tab').forEach(t => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active);
  });
  qsa('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
}

function closeModal() {
  qs('.modal-tabs').style.display    = '';
  qs('.modal-actions').style.display = '';
  const overlay = qs('#modalOverlay');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  currentModal = null;
}

function showToast(msg) {
  const t = Object.assign(document.createElement('div'), { textContent: msg });
  t.style.cssText = `position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
    background:var(--bg3);border:1px solid var(--border);color:var(--amber);
    font-family:var(--mono);font-size:11px;padding:6px 14px;border-radius:4px;
    z-index:999;white-space:nowrap;`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function emptyState(icon, title, sub) {
  return `<div class="empty-state">
    <div class="empty-icon">${icon}</div>
    <div class="empty-title">${escHtml(title)}</div>
    <div class="empty-sub">${escHtml(sub)}</div>
  </div>`;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5)     return 'just now';
  if (s < 60)    return s + 's ago';
  if (s < 3600)  return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function syntaxHighlight(json) {
  return escHtml(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    m => {
      let cls = 'json-num';
      if (/^"/.test(m)) cls = /:$/.test(m) ? 'json-key' : 'json-str';
      else if (/true|false/.test(m)) cls = 'json-bool';
      else if (/null/.test(m))       cls = 'json-null';
      return `<span class="${cls}">${m}</span>`;
    });
}

function tryURL(str) { try { return new URL(str); } catch { return null; } }
function isPlainObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

const qs  = s => document.querySelector(s);
const qsa = s => document.querySelectorAll(s);