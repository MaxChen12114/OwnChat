// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name;
// the version stamp stays 2. The implementation lives in services/data/chat-stream.ts, so every
// window bridge lives here: localStorage, APP_MODELS_FAST and the fetch exit.
// The idempotence check keeps the old rule — already installed at v 2 means keep it, because the
// tools page can load an older public bundle first.
(function () {
  if (window.chatStreamSvc && window.chatStreamSvc.v === 2) return;

  var storage = {
    getItem: function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    setItem: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {}
    },
  };

  var api = createChatStream({
    storage: storage,
    modelsFast: function () {
      return window.APP_MODELS_FAST;
    },
    fetch: function (url, init) {
      return window.fetch(url, init);
    },
  });

  window.chatStreamSvc = {
    v: 2,
    modeForModel: api.modeForModel,
    buildBody: api.buildBody,
    call: api.call,
    readSse: api.readSse,
  };
})();
