// Browser wiring for services/ui/bind.ts: the real document arrives as the DOM port and the facade
// is published as a non-`__` global (window.bindEl — no frozen-contract growth). Must load before
// the settings wiring: the settings cards call window.bindEl instead of hand-writing the
// find/reflect/listen/write/fallback chain per control. The port guards an unusable root so a bad
// caller degrades to "element missing" instead of throwing inside a card mount.
(function () {
  window.bindEl = createBind({
    querySelector: function (root, selector) {
      if (!root || typeof root.querySelector !== "function") return null;
      var el = root.querySelector(selector);
      return el == null ? null : el;
    },
    listen: function (el, fn) {
      el.addEventListener("change", fn);
    },
  });
})();
