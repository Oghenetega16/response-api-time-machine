// ============================================================
// API Time Machine — Background Service Worker
// MV3 service workers die after ~30s idle. Strategy:
//   1. Use chrome.alarms to re-register every 20s (keepalive)
//   2. Persist all state to chrome.storage.local immediately
//   3. Re-attach webRequest listeners on every SW wake
// ============================================================

const DB_KEY = 'atm_records';
const CONFIG_KEY = 'atm_config';
const SHAPE_HISTORY_KEY = 'atm_shape_history'; // { endpointKey: { ts, shapeHash, shape, recordId, changes: [...] } }
const MAX_RECORDS = 5000;
const MAX_BODY_SIZE = 50_000;
const MAX_CHANGES_PER_ENDPOINT = 50;

// ── Keepalive: prevent service worker from sleeping ──────────
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Just waking up — listeners are re-registered on each wake
    ensureListeners();
  }
});

// ── Schema helpers ───────────────────────────────────────────
function makeRecord(details, body, statusCode, responseHeaders) {
  const url = new URL(details.url);
  const shape = inferShape(body);
  const reqBody = details.requestBody || null;
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    url: details.url,
    host: url.hostname,
    path: url.pathname,
    method: details.method,
    statusCode,
    requestHeaders: details.requestHeaders || [],
    requestBody: reqBody,
    requestBodyTruncated: typeof reqBody === 'string' && reqBody.length >= 20_000,
    responseHeaders: responseHeaders || [],
    body: typeof body === 'string' ? body.slice(0, MAX_BODY_SIZE) : null,
    bodyTruncated: typeof body === 'string' && body.length > MAX_BODY_SIZE,
    shape,
    shapeHash: hashShape(shape),
    isJson: body !== null && typeof body === 'object' || isJsonString(body),
  };
}

function isJsonString(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return (t.startsWith('{') || t.startsWith('['));
}

function inferShape(body) {
  if (!body) return null;
  let obj;
  if (typeof body === 'string') {
    try { obj = JSON.parse(body); } catch { return null; }
  } else {
    obj = body;
  }
  return buildShape(obj);
}

function buildShape(val, depth = 0) {
  if (depth > 6) return '__deep__';
  if (val === null) return 'null';
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    return [buildShape(val[0], depth + 1)];
  }
  if (typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val).slice(0, 30)) {
      out[k] = buildShape(val[k], depth + 1);
    }
    return out;
  }
  return typeof val;
}

function hashShape(shape) {
  if (!shape) return 'null';
  const str = JSON.stringify(shape);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

async function getShapeHistory() {
  const r = await chrome.storage.local.get(SHAPE_HISTORY_KEY);
  return r[SHAPE_HISTORY_KEY] || {};
}

async function appendShapeHistoryEntry(endpointKey, changeEntry) {
  const history = await getShapeHistory();
  if (!history[endpointKey]) history[endpointKey] = {};
  if (!history[endpointKey].changes) history[endpointKey].changes = [];
  history[endpointKey].changes.push(changeEntry);
  // Cap per endpoint
  if (history[endpointKey].changes.length > MAX_CHANGES_PER_ENDPOINT) {
    history[endpointKey].changes = history[endpointKey].changes.slice(-MAX_CHANGES_PER_ENDPOINT);
  }
  await chrome.storage.local.set({ [SHAPE_HISTORY_KEY]: history });
}

// ── Storage helpers ──────────────────────────────────────────
async function getRecords() {
  const r = await chrome.storage.local.get(DB_KEY);
  return r[DB_KEY] || [];
}

async function saveRecord(record) {
  let records = await getRecords();
  records.unshift(record);
  if (records.length > MAX_RECORDS) records = records.slice(0, MAX_RECORDS);
  await chrome.storage.local.set({ [DB_KEY]: records });

  // Notify popup if open
  chrome.runtime.sendMessage({ type: 'NEW_RECORD', record }).catch(() => {});
}

async function getConfig() {
  const r = await chrome.storage.local.get(CONFIG_KEY);
  return r[CONFIG_KEY] || {
    enabled: true,
    filters: [],
    excludePatterns: ['google-analytics', 'doubleclick', 'facebook', 'hotjar', 'sentry'],
    captureRequestHeaders: false,
    notifyOnShapeChange: false,
  };
}

// Convert a pattern to a RegExp.
// Supports: plain strings (substring), /regex/ syntax, and glob (*wildcards)
function patternToRegex(pattern) {
  const s = pattern.trim();
  if (!s) return null;
  // /regex/flags syntax
  const regexMatch = s.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try { return new RegExp(regexMatch[1], regexMatch[2]); } catch { return null; }
  }
  // Glob: * → .*, ? → .
  if (s.includes('*') || s.includes('?')) {
    const escaped = s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                     .replace(/\*/g, '.*')
                     .replace(/\?/g, '.');
    try { return new RegExp(escaped, 'i'); } catch { return null; }
  }
  // Plain substring (case-insensitive)
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function matchesAnyPattern(url, patterns) {
  return patterns.some(p => {
    const re = patternToRegex(p);
    return re ? re.test(url) : false;
  });
}

// ── Request interception via content script injection ────────
// MV3 doesn't let service workers read response bodies via webRequest.
// Strategy: inject a page-level script that wraps fetch/XHR and
// posts messages back via the content script bridge.

const activeTabListeners = new Set();

function ensureListeners() {
  // webRequest for metadata (headers, status)
  if (!chrome.webRequest.onResponseStarted.hasListener(onResponseStarted)) {
    chrome.webRequest.onResponseStarted.addListener(
      onResponseStarted,
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );
  }
}

function onResponseStarted(details) {
  // We track metadata here; body comes from content script
  pendingRequests.set(details.requestId, {
    statusCode: details.statusCode,
    responseHeaders: details.responseHeaders,
    url: details.url,
    method: details.method,
    ts: Date.now(),
  });
  // Clean up stale entries after 30s
  setTimeout(() => pendingRequests.delete(details.requestId), 30_000);
}

// In-memory map (lost on SW death, but that's OK — body arrives quickly)
const pendingRequests = new Map();

// ── Message handler (from content script) ───────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'API_RESPONSE_CAPTURED') {
    handleCapturedResponse(msg, sender);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'GET_RECORDS') {
    getRecords().then(records => sendResponse({ records }));
    return true;
  }
  if (msg.type === 'GET_CONFIG') {
    getConfig().then(config => sendResponse({ config }));
    return true;
  }
  if (msg.type === 'SET_CONFIG') {
    chrome.storage.local.set({ [CONFIG_KEY]: msg.config }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'GET_SHAPE_HISTORY') {
    getShapeHistory().then(h => sendResponse({ history: h }));
    return true;
  }
  if (msg.type === 'CLEAR_SHAPE_HISTORY') {
    chrome.storage.local.set({ [SHAPE_HISTORY_KEY]: {} }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'EXPORT_RECORDS') {
    Promise.all([getRecords(), getShapeHistory()]).then(([records, history]) => {
      sendResponse({ records, history });
    });
    return true;
  }
  if (msg.type === 'IMPORT_RECORDS') {
    getRecords().then(existing => {
      const incoming = msg.records || [];
      const existingIds = new Set(existing.map(r => r.id));
      const merged = [...incoming.filter(r => !existingIds.has(r.id)), ...existing]
        .slice(0, MAX_RECORDS);
      chrome.storage.local.set({ [DB_KEY]: merged }).then(() => sendResponse({ ok: true, count: merged.length }));
    });
    return true;
  }
  if (msg.type === 'CLEAR_RECORDS') {
    chrome.storage.local.set({ [DB_KEY]: [], [SHAPE_HISTORY_KEY]: {} }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'DELETE_RECORD') {
    getRecords().then(records => {
      const filtered = records.filter(r => r.id !== msg.id);
      chrome.storage.local.set({ [DB_KEY]: filtered }).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
});

async function handleCapturedResponse(msg, sender) {
  const config = await getConfig();
  if (!config.enabled) return;

  const url = msg.url;

  // Exclude patterns (regex/glob aware)
  if (config.excludePatterns?.length && matchesAnyPattern(url, config.excludePatterns)) return;

  // Include filter (if set)
  if (config.filters?.length && !matchesAnyPattern(url, config.filters)) return;

  // Only record JSON-like responses
  const body = msg.body;
  if (!body || !isJsonString(body)) return;

  const details = {
    url,
    method: msg.method || 'GET',
    requestHeaders: msg.requestHeaders || [],
    requestBody: msg.requestBody || null,
  };

  const record = makeRecord(details, body, msg.statusCode || 200, msg.responseHeaders || []);

  // ── Shape history: detect if shape changed vs last seen for this endpoint ──
  const endpointKey = record.method + ':' + record.host + record.path;
  const shapeHistory = await getShapeHistory();
  const prevEntry = shapeHistory[endpointKey];

  if (prevEntry && prevEntry.shapeHash !== record.shapeHash) {
    // Shape changed — record it
    record.shapeChanged = true;
    const changeEntry = {
      ts: record.ts,
      shapeHash: record.shapeHash,
      shape: record.shape,
      recordId: record.id,
      prevShapeHash: prevEntry.shapeHash,
      prevShape: prevEntry.shape,
      prevRecordId: prevEntry.recordId,
      prevTs: prevEntry.ts,
    };
    await appendShapeHistoryEntry(endpointKey, changeEntry);

    // Notify if enabled
    if (config.notifyOnShapeChange) {
      const u = new URL(url);
      chrome.notifications.create(`shape_change_${record.id}`, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'API Shape Changed',
        message: `${record.method} ${u.hostname}${u.pathname}`,
        contextMessage: summarizeShapeChangeBg(prevEntry.shape, record.shape),
      });
    }
  }

  // Update shape history for this endpoint (always store latest)
  shapeHistory[endpointKey] = {
    ts: record.ts,
    shapeHash: record.shapeHash,
    shape: record.shape,
    recordId: record.id,
  };
  await chrome.storage.local.set({ [SHAPE_HISTORY_KEY]: shapeHistory });

  await saveRecord(record);
}

function summarizeShapeChangeBg(a, b) {
  if (!a || !b) return 'Shape changed';
  const aKeys = typeof a === 'object' && !Array.isArray(a) ? Object.keys(a) : [];
  const bKeys = typeof b === 'object' && !Array.isArray(b) ? Object.keys(b) : [];
  const added = bKeys.filter(k => !aKeys.includes(k));
  const removed = aKeys.filter(k => !bKeys.includes(k));
  const parts = [];
  if (added.length) parts.push(`+${added.slice(0, 2).join(', ')}`);
  if (removed.length) parts.push(`-${removed.slice(0, 2).join(', ')}`);
  return parts.join(' ') || 'Nested shape changed';
}

// Boot
ensureListeners();