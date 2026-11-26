// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// Written against `globalThis`, verbatim as the old file was: the provider-merge and sync vm tests
// run with the global context directly, where `window` need not exist. In a browser
// `globalThis === window`, so behaviour is identical.
(function (g) {
  if (g.__providerMerge) return;
  g.__providerMerge = {
    version: 1,
    mergeProviders: mergeProviders,
    mergeImageChannels: mergeImageChannels,
    // Exposed for the unit tests
    _score: _score,
    _pickNewer: _pickNewer,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
