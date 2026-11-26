// Browser wiring (injected by l0/emit.mjs): shell access, text sinks and the environment version
// mirror; no frozen contract of its own — the version goes to dataset.appVersion for env-context.
(function () {
  var api = createVersionPainter({
    getTauri: function () {
      try {
        return window.tauriSvc ? window.tauriSvc.raw() : null;
      } catch (e) {
        return null;
      }
    },
    invoke: function (cmd) {
      try {
        var invoke = window.tauriSvc ? window.tauriSvc.invokeOrNull() : null;
        if (invoke) return Promise.resolve(invoke(cmd));
      } catch (e) {}
      return Promise.resolve("");
    },
    setText: function (id, text) {
      try {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
      } catch (e) {}
    },
    setEnvVersion: function (v) {
      try {
        // env-context reads dataset.appVersion; no window global anymore (G1).
        document.documentElement.dataset.appVersion = v;
      } catch (e) {}
    },
  });
  api.run();
})();
