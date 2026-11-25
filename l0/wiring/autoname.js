// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);
  if (G.__convAutoname) return;
  var ports = {
    storage: { getItem: function (k) { return G.localStorage.getItem(k); }, setItem: function (k, v) { G.localStorage.setItem(k, v); } },
    getApp: function () { return G.__app || null; },
    getConvList: function () { return G.__convList || null; },
  };
  G.__convAutoname = createAutoname(ports);
})();
