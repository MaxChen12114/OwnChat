// Browser wiring (injected by tooling/l0/emit.mjs): element lookups, the MutationObserver and the
// click re-sweep; no frozen contract, the old inline script was an anonymous IIFE.
(function () {
  var settings = document.getElementById("settings");
  var slot = document.getElementById("settingsImageSlot");
  if (!settings || !slot) return;
  var shell = settings.querySelector(".settings-shell");
  var api = createOrphanObserver({
    get: function (id) {
      try {
        return document.getElementById(id);
      } catch (e) {
        return null;
      }
    },
    shellContains: function (node) {
      try {
        return !!shell && shell.contains(node);
      } catch (e) {
        return false;
      }
    },
    childrenOf: function (root) {
      return Array.prototype.slice.call(root.children);
    },
    adopt: function (node) {
      try {
        slot.appendChild(node);
      } catch (e) {}
    },
    observeSettings: function (onAdded) {
      try {
        var ob = new MutationObserver(function (muts) {
          var added = [];
          muts.forEach(function (m) {
            m.addedNodes.forEach(function (n) {
              added.push(n);
            });
          });
          if (added.length) onAdded(added);
        });
        ob.observe(settings, { childList: true });
      } catch (e) {}
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
  api.run();
})();
