// Injected into the page world — can access real fetch/XHR
// Wraps both to capture JSON API responses + request bodies

(function () {
  'use strict';

  const MAX_REQ_BODY = 20_000; // 20KB cap on request body capture

  function dispatch(data) {
    window.dispatchEvent(new CustomEvent('__atm_response__', { detail: data }));
  }

  function headersToArray(headers) {
    const arr = [];
    if (headers && headers.forEach) {
      headers.forEach((v, k) => arr.push({ name: k, value: v }));
    }
    return arr;
  }

  function headersObjToArray(obj) {
    if (!obj) return [];
    if (obj instanceof Headers) return headersToArray(obj);
    return Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));
  }

  function extractRequestBody(body) {
    if (!body) return null;
    if (typeof body === 'string') return body.slice(0, MAX_REQ_BODY);
    if (body instanceof URLSearchParams) return body.toString().slice(0, MAX_REQ_BODY);
    if (body instanceof FormData) {
      // Best-effort: list keys
      const parts = [];
      body.forEach((v, k) => parts.push(`${k}=${typeof v === 'string' ? v : '[File]'}`));
      return parts.join('&').slice(0, MAX_REQ_BODY);
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return '[binary]';
    if (body instanceof Blob) return `[Blob type=${body.type} size=${body.size}]`;
    return null;
  }

  // ── Wrap fetch ─────────────────────────────────────────────
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input?.url || '';
    const method = (init?.method || input?.method || 'GET').toUpperCase();
    const requestHeaders = headersObjToArray(init?.headers || input?.headers);
    const requestBody = extractRequestBody(init?.body || input?.body);

    let res;
    try {
      res = await _fetch(input, init);
    } catch (err) {
      throw err;
    }

    const clone = res.clone();
    clone.text().then(body => {
      dispatch({
        url,
        method,
        statusCode: res.status,
        responseHeaders: headersToArray(res.headers),
        requestHeaders,
        requestBody,
        body,
      });
    }).catch(() => {});

    return res;
  };

  // ── Wrap XMLHttpRequest ────────────────────────────────────
  const _XHROpen = XMLHttpRequest.prototype.open;
  const _XHRSend = XMLHttpRequest.prototype.send;
  const _XHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__atm_url = url;
    this.__atm_method = method.toUpperCase();
    this.__atm_reqHeaders = [];
    return _XHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__atm_reqHeaders) this.__atm_reqHeaders.push({ name, value });
    return _XHRSetHeader.apply(this, [name, value]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const reqBody = extractRequestBody(body);
    const reqHeaders = this.__atm_reqHeaders || [];
    this.addEventListener('load', function () {
      try {
        dispatch({
          url: this.__atm_url,
          method: this.__atm_method || 'GET',
          statusCode: this.status,
          responseHeaders: parseXHRHeaders(this.getAllResponseHeaders()),
          requestHeaders: reqHeaders,
          requestBody: reqBody,
          body: this.responseText,
        });
      } catch {}
    });
    return _XHRSend.apply(this, [body]);
  };

  function parseXHRHeaders(raw) {
    if (!raw) return [];
    return raw.trim().split('\r\n').map(line => {
      const idx = line.indexOf(': ');
      return { name: line.slice(0, idx), value: line.slice(idx + 2) };
    });
  }
})();