// Content script — runs in page context (isolated world)
// Injects the page-level interceptor and relays messages to SW

(function () {
  // Inject the page-world script that can intercept fetch/XHR
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.dataset.extId = chrome.runtime.id;
  (document.head || document.documentElement).prepend(script);
  script.remove();

  // Listen for intercepted responses from the page world
  window.addEventListener('__atm_response__', (e) => {
    const data = e.detail;
    chrome.runtime.sendMessage({ type: 'API_RESPONSE_CAPTURED', ...data }).catch(() => {});
  });
})();
