// Browser wiring (injected by tooling/l0/emit.mjs): storage, classes and the three rebind events;
// no frozen contract, the old inline script was an anonymous IIFE with no window surface.
(function () {
  var api = createAndroidMark({
    shellParam: function () {
      try {
        var sp = new URLSearchParams(location.search || "");
        return sp.get("shell");
      } catch (e) {
        return null;
      }
    },
    lsGet: function (key) {
      try {
        return localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    lsSet: function (key, value) {
      try {
        localStorage.setItem(key, value);
      } catch (e) {}
    },
    rootAdd: function (cls) {
      try {
        document.documentElement.classList.add(cls);
      } catch (e) {}
    },
    onRebind: function (cb) {
      try {
        window.addEventListener("pageshow", cb);
        window.addEventListener("focus", cb);
        document.addEventListener("visibilitychange", cb);
      } catch (e) {}
    },
  });
  api.auto();
})();
