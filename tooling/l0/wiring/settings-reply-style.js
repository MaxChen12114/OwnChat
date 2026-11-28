// Browser wiring for services/ui/settings-reply-style.ts: localStorage as the injected port and
// the non-`__` global. The three-value whitelist and default live in the emitted service and are
// shared with chat/request, peer-calls and app-mode via an equivalence lock. The <select> DOM stays
// in the settings card.
(function () {
  window.settingsReplyStyle = createSettingsReplyStyle({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  });
})();
