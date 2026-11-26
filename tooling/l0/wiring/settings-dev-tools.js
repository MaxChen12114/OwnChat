// Browser wiring for services/ui/settings-dev-tools.ts: localStorage and hostname as injected
// ports, plus the non-`__` global. On/off normalization (explicit flag wins, else loopback default)
// lives in the emitted TS product and is shared with source-tools.ts via an equivalence lock.
(function () {
  window.settingsDevTools = createSettingsDevTools({
    storage: {
      getItem: function (key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
      },
      setItem: function (key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) {}
      },
    },
    hostname: function () {
      try { return window.location.hostname; } catch (e) { return ""; }
    },
  });
})();
