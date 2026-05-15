# API Response Time Machine 🕰️

A Chrome extension that records every JSON API response, lets you replay history, diff any two versions side-by-side, and **automatically detects when a response silently changed shape** — even days later.

---

## Features

| Feature | Details |
|---------|---------|
| **Auto-capture** | Intercepts all `fetch` + `XMLHttpRequest` calls, records JSON responses |
| **Shape inference** | Derives structural schema from each response |
| **Change detection** | Flags when an endpoint's shape hash changes between calls |
| **Body + Shape diff** | LCS-powered line diff between any two records |
| **Replay / inspect** | Browse full body, shape, and headers in a modal |
| **Filter & search** | By URL, host, or HTTP method |
| **Include/exclude patterns** | Config to focus on specific APIs |
| **Persistent storage** | `chrome.storage.local` survives SW restarts |

---

## Installation (Developer Mode)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder: `api-time-machine/`
5. The hourglass icon appears in your toolbar

---

## How it works

### MV3 Service Worker persistence problem — solved

Manifest V3 service workers die after ~30 seconds idle. This extension uses **three strategies** to stay alive and resilient:

1. **`chrome.alarms`** — fires every 24 seconds, waking the SW and re-registering listeners
2. **Immediate storage writes** — every intercepted record is flushed to `chrome.storage.local` before the SW can die
3. **Content script bridge** — response _bodies_ are captured in the page world (injected.js → content.js) since SW can't read them via `webRequest`

### Architecture

```
Page world (injected.js)
  └─ wraps fetch + XHR
  └─ dispatches CustomEvent with body

Content script (content.js)
  └─ relays to service worker via chrome.runtime.sendMessage

Service worker (background.js)
  └─ receives body + metadata
  └─ infers shape + hash
  └─ stores to chrome.storage.local
  └─ notifies popup if open

Popup (popup.js)
  └─ Feed: live-updating list with flash animation
  └─ Changes: auto-detected shape diffs
  └─ Diff: LCS line diff (shape or body)
  └─ Settings: filters, excludes, toggle
```

### Shape inference

The `buildShape()` function recursively walks a JSON value and replaces leaf values with their type names (`"string"`, `"number"`, `"boolean"`, `"null"`). Arrays are represented as a one-element sample `["string"]`. This shape is then hashed with a fast 32-bit Bernstein hash. Any change in the hash triggers a "shape changed" alert.

---

## Settings

- **URL filter**: Only record responses whose URL contains one of these patterns (leave empty = all)
- **Exclude patterns**: Skip URLs matching these (analytics, trackers, etc.)
- Default excludes: `google-analytics`, `doubleclick`, `facebook`, `hotjar`, `sentry`

---

## Storage limits

- Max 5,000 records (oldest auto-pruned)
- Max 50KB per response body (truncated if exceeded)
- Shape is always stored in full

---

## Privacy

All data stays local in `chrome.storage.local`. Nothing is sent to any server.
