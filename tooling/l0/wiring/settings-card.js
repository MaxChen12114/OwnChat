// Browser wiring for services/ui/settings-card.ts: the real document arrives as the DOM port and
// the factory is published as a non-`__` global (window.cardShell — no frozen-contract growth).
// Must load before the settings wiring: the settings cards build their shell through
// createCardShell instead of hand-writing the card/h4/p/tip skeleton per card, while mount
// placement, idempotency and the error fence stay with slotRegistry.declareCard. Port guards
// mirror bind.js: an unusable handle degrades to "content missing" instead of throwing inside a
// card mount.
(function () {
  window.cardShell = createCardShellFactory({
    make: function (tag) { return document.createElement(tag); },
    setAttr: function (el, name, value) { if (el && typeof el.setAttribute === "function") el.setAttribute(name, value); },
    html: function (el, value) { if (el) el.innerHTML = value; },
    query: function (el, selector) {
      if (!el || typeof el.querySelector !== "function") return null;
      var found = el.querySelector(selector);
      return found == null ? null : found;
    },
  });
})();
