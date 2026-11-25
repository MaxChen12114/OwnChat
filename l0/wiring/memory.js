// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The real IDB adapter and the vector loader are browser-only code and ship with the artifact. The
// vm test swaps in an in-memory `sandbox.indexedDB`, which must stay structurally identical to the
// real one: `getAll` wraps its result once, and the request wrapper sits outside the service's tx
// callback.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);
  var DB_NAME = 'cfw_char_mem_v2', DB_VER = 1, ST = 'epi';
  function openRaw() {
    return new Promise(function (res, rej) {
      var req = G.indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(ST)) {
          var s = d.createObjectStore(ST, { keyPath: 'id' });
          s.createIndex('cid', 'cid', { unique: false });
        }
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }
  var dbPort = {
    tx: function (mode, fn) {
      return openRaw().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(ST, mode), st = t.objectStore(ST), out;
          try { out = fn(st); } catch (e) { rej(e); return; }
          t.oncomplete = function () { res(out && out.__req ? out.__req.result : out); };
          t.onerror = function () { rej(t.error); };
        });
      });
    },
  };
  var ports = {
    storage: { getItem: function (k) { return G.localStorage.getItem(k); }, setItem: function (k, v) { G.localStorage.setItem(k, v); } },
    db: dbPort,
    app: function () { return G.__app || null; },
    // Vector leg (browser only): transformers.js with its bundled webpack build (onnxruntime-web
    // included). Model and wasm are published with the repo under public/models/, loaded from a
    // same-origin path — no external network dependency at runtime.
    loadVectorPipe: function () {
      return (async function () {
        var mod = await import(new URL('/models/tf/transformers.min.js', location.origin).href);
        var env = mod.env;
        env.allowRemoteModels = true;
        env.remoteHost = (location && location.origin ? location.origin : '') + '/models';
        env.remotePathTemplate = '{model}/';
        env.useBrowserCache = true;
        env.allowLocalModels = false;
        try { env.backends.onnx.wasm.wasmPaths = (location && location.origin ? location.origin : '') + '/models/tf/'; } catch (e) {}
        return await mod.pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { quantized: true });
      })();
    },
  };
  G.__memCore = createMemCore(ports);
})();
