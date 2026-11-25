// Browser wiring for services/ui/settings-agent-tools.ts: localStorage and the non-`__` global.
// Mode whitelist, round ceiling and tool-profile rules live in the emitted TS product.
(function () {
  window.settingsAgentTools = createAgentTools({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
    removeItem: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
    },
  });
})();
