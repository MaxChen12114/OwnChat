// Browser wiring (injected by l0/emit.mjs): shell access, text sinks and the __appVersion mirror;
// no frozen contract of its own — __appVersion is the pre-existing one env-context reads.
(function () {
  var api = createVersionPainter({
    getTauri: function () {
      try {
        return window.__TAURI__ || null;
      } catch (e) {
        return null;
      }
    },
    invoke: function (cmd) {
      try {
        var T = window.__TAURI__;
        if (T && T.core && typeof T.core.invoke === "function") return Promise.resolve(T.core.invoke(cmd));
      } catch (e) {}
      return Promise.resolve("");
    },
    setText: function (id, text) {
      try {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
      } catch (e) {}
    },
    setGlobalVersion: function (v) {
      try {
        window.__appVersion = v; // env-context.js 读这个，应用版本不再显示 unknown
      } catch (e) {}
    },
  });
  api.run();
})();
