// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// agent domain, seventh brick (2026-11-15): the implementation moved to services/agent/peer-calls.ts,
// so every window access lives here — localStorage reads, the fetch exit, the AbortSignal
// constructor, and the five page globals (card library, cards on stage, kernel, tool bundle, memory
// and panel). Each global is resolved per call, never snapshotted: the kernel is an ESM module that
// loads after this file, and services hold these as ports.
(function () {
  if (window.__peerCalls && window.__peerCalls.v === 1) return;

  function browserCaps(host) {
    var caps = {};
    if (host) {
      for (var k in host) {
        if (Object.prototype.hasOwnProperty.call(host, k)) caps[k] = host[k];
      }
    }
    caps.setting = function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    };
    caps.signalCtor = function () {
      return typeof AbortSignal !== "undefined" ? AbortSignal : undefined;
    };
    caps.fetch = function (url, init) {
      return window.fetch(url, init);
    };
    caps.env = {
      sceneCards: function () {
        return window.multiSvc && window.multiSvc.getSceneCards ? window.multiSvc.getSceneCards() : null;
      },
      allCards: function () {
        return window.characterSvc && window.characterSvc.listAllCards ? window.characterSvc.listAllCards() : null;
      },
      byo: function () {
        return window.byoProviderSvc && window.byoProviderSvc.get ? window.byoProviderSvc.get() : undefined;
      },
      kernel: function () {
        return window.AgentKernel;
      },
      tools: function () {
        return window.OwnChatTools;
      },
      toolGroup: function (name) {
        return window[name];
      },
      memCore: function () {
        return window.__memCore;
      },
      charMemory: function () {
        return window.__charMemory;
      },
      panel: function () {
        return window.panelSvc;
      },
    };
    return caps;
  }

  window.__peerCalls = {
    v: 1,
    create: function (host) {
      return createPeerCalls(browserCaps(host));
    },
  };
})();
