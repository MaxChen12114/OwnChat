// Browser wiring (injected by tooling/l0/emit.mjs): runs the keeper once at boot — no frozen contract,
// the old inline script was an anonymous IIFE with no window surface.
(function () {
  var api = createFooterKeeper({
    get: function (id) {
      try {
        return document.getElementById(id);
      } catch (e) {
        return null;
      }
    },
    onSettingsClick: function (cb) {
      try {
        var sb = document.getElementById("settingsBtn");
        if (sb) sb.addEventListener("click", function () { cb(); });
      } catch (e) {}
    },
    schedule: function (fn, ms) {
      setTimeout(fn, ms);
    },
  });
  api.auto();
})();
