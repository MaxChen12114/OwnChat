// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);
  if (G.__sessionStore) return;
  var LS = G.localStorage;
  var ports = { storage: { getItem: function (k) { return LS.getItem(k); }, setItem: function (k, v) { LS.setItem(k, v); }, removeItem: function (k) { LS.removeItem(k); } } };
  G.__sessionStore = { create: function (host) { return createSessionStore(ports, host); } };
})();
