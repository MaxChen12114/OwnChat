// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
// Written against `globalThis`, verbatim as the old file was: the think-control vm test runs with
// the window object as the global context, where `window` need not exist. In a browser
// `globalThis === window`, so behaviour is identical.
(function (g) {
  if (g.__modelThink) return;
  g.__modelThink = {
    version: 1,
    levels: LEVELS,
    values: LEVELS.map(function (l) { return l.v; }),
    rules: RULES,
    label: label,
    levelsFor: levelsFor,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
