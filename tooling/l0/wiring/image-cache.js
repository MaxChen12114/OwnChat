// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/cache.ts; this file owns the
// frozen global name, localStorage, the fetch interception and the change event.
//
// The wrapper has to sit between image-quota and image-album (album is the outermost), so a hit
// never reaches the quota counter and an album write never sees a replay.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);

  var cache = createCache({
    storage: {
      getItem: function (k) { try { return G.localStorage.getItem(k); } catch (e) { return null; } },
      setItem: function (k, v) { try { G.localStorage.setItem(k, v); } catch (e) {} }
    },
    notify: function () {
      try { G.dispatchEvent(new G.CustomEvent("imagecache:changed")); } catch (e) {}
    }
  });

  var rawFetch = G.fetch ? G.fetch.bind(G) : null;
  if (rawFetch) {
    G.fetch = function (input, init) {
      try {
        if (cache.isEnabled()) {
          var url = typeof input === "string" ? input : ((input && input.url) || "");
          var method = (init && init.method) || (input && input.method) || "GET";
          var req = cacheRequest(url, method, init && init.body);
          if (req) {
            var hit = cache.get(req.key);
            if (hit) {
              cache.bumpSaved();
              return Promise.resolve(new G.Response(cachedBody(hit), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              }));
            }
            return rawFetch(input, init).then(function (res) {
              try {
                if (res && res.ok) {
                  res.clone().json().then(function (j) {
                    var first = (j && j.data && j.data[0]) || null;
                    var u = first && first.url;
                    if (u) cache.put(req.key, u, req.prompt);
                  }).catch(function () {});
                }
              } catch (e) {}
              return res;
            });
          }
        }
      } catch (e) {}
      return rawFetch(input, init);
    };
  }

  G.__imageCache = {
    get: cache.get, put: cache.put, clear: cache.clear, stats: cache.stats,
    isEnabled: cache.isEnabled, setEnabled: cache.setEnabled, hashKey: hashKey
  };

  if (typeof module === "object" && module.exports) {
    module.exports = { cache: cache, cacheRequest: cacheRequest, hashKey: hashKey };
  }
})();
