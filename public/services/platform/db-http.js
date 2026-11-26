(function () {
/**
 * The one HTTP implementation of DbPort. The D1 adapter (same-origin `/api/*`) and the Node adapter
 * (absolute sidecar origin plus an optional bearer token) are this module with different options —
 * two adapters, one SQL wire, no second JSON marshalling to drift.
 *
 * Auth: the D1 adapter sends relative URLs, so the page's own fetch wrapper (`services/auth/token.ts`
 * adds `Authorization` for `/api/*`) covers it. An absolute sidecar origin is not the page's origin
 * and the wrapper deliberately does not touch third-party URLs, hence the explicit `token` option.
 *
 * Errors are thrown, not returned: a port call that cannot run must stop the caller's write path,
 * and a `{rows:[]}` stand-in would look like "no rows" — the exact silent failure this repo keeps
 * paying for. SQL text is not echoed in failures; the server's `error` field is.
 *
 * Transaction shape: the callback's statements are collected and posted once to `/api/data/tx`,
 * which is D1's atomic unit. Nothing is sent when the callback throws, so a caller's early exit is
 * a rollback by construction. Reads inside the callback are not supported (see `core/db.ts`).
 * @module services/platform/db-http
 */

                                                                                               

// Separate emit products bridged on globalThis by the emitter; declared instead of imported because
// the emit channel carries import-free sources only.
                                                                                            
                                                                                           

/** Options: `base` is an origin ("" = same origin), `token` becomes a bearer header. */
                                
                         
                          
 

                              
              
                    
 

/** Object view without an assertion. Arrays and null are not records. */
function isRecord(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A thrown value as a readable string; ports must never leak "[object Object]". */
function errText(e         )         {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Strip trailing slashes; refuse a non-absolute base so a typo cannot silently become a path. */
function normalizeBase(base        )         {
  const value = base.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    throw new Error('db-http: base must be an origin like "http://127.0.0.1:8787" (got "' + value + '")');
  }
  return value.replace(/\/+$/, "");
}

/** Resolve the page's fetch per call: wrappers are layered after boot and must be honoured. */
function resolveFetch()               {
  if (typeof fetch !== "function") throw new Error("db-http: fetch is not available in this host");
  return fetch;
}

/** Read a JSON body; a non-2xx answer becomes a thrown error carrying the server's own message. */
async function readJson(res          , path        )                                   {
  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    throw new Error("db-http: " + path + " response unreadable (" + errText(e) + ")");
  }
  let data          = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      // A non-JSON body is only legal on the error path (an HTML 502 page from a proxy, say):
      // keep `data` null so the failure message below falls back to the raw text.
      data = null;
    }
  }
  if (!res.ok) {
    const detail = isRecord(data) && typeof data.error === "string" ? data.error : text.slice(0, 200);
    throw new Error("db-http: " + path + " failed (" + String(res.status) + "): " + (detail || "no body"));
  }
  if (!isRecord(data)) throw new Error("db-http: " + path + " returned a non-object body");
  return data;
}

/** Rows out of a response body, decoded from the wire form. */
function rowsOf(payload                         )          {
  const rows            = Array.isArray(payload.rows) ? payload.rows : [];
  return rows.map((row) => dbWire.decodeRow(row));
}

/**
 * Build an HTTP-backed port.
 * @param options `base` = "" for same-origin, otherwise an absolute origin; `token` adds the
 *        bearer header the sidecar's `checkAuth` expects.
 */
function createHttpDbPort(options                )         {
  const base = normalizeBase(options && typeof options.base === "string" ? options.base : "");
  const token = options && typeof options.token === "string" ? options.token.trim() : "";

  function headers(json         )                         {
    const out                         = {};
    if (json) out["content-type"] = "application/json";
    if (token) out["authorization"] = "Bearer " + token;
    return out;
  }

  async function send(path        , init             , label        )                                   {
    let res          ;
    try {
      res = await resolveFetch()(base + path, init);
    } catch (e) {
      throw new Error("db-http: " + label + " unreachable (" + errText(e) + ")");
    }
    return readJson(res, label);
  }

  async function exec(sql        , params            )                    {
    if (typeof sql !== "string" || !sql.trim()) throw new Error("db-http: sql is required");
    const payload = await send(
      "/api/data/exec",
      { method: "POST", headers: headers(true), body: JSON.stringify({ sql: sql, params: dbWire.normalizeParams(params) }) },
      "exec",
    );
    return { rows: rowsOf(payload) };
  }

  async function transaction   (fn                              )             {
    if (typeof fn !== "function") throw new Error("db-http: transaction requires a callback");
    const statements                       = [];
    const tx       = {
      exec(statementSql        , params            )       {
        if (typeof statementSql !== "string" || !statementSql.trim()) throw new Error("db-http: tx statement sql is required");
        statements.push({ sql: statementSql, params: dbWire.normalizeParams(params) });
      },
    };
    // A throw here skips the POST entirely: no statements were sent, so nothing to roll back.
    const result = await fn(tx);
    if (statements.length > 0) {
      await send("/api/data/tx", { method: "POST", headers: headers(true), body: JSON.stringify({ statements: statements }) }, "tx");
    }
    return result;
  }

  async function search(surface               , scope             , q        , limit         )                   {
    // The builder owns validation and normalisation; the server repeats both, which is why the
    // query string carries exactly what the builder decided (same clamp, same trim, same scope).
    const built = dbSearchSql.buildSearchQuery(surface, scope, q, limit);
    const qs =
      "surface=" + encodeURIComponent(built.surface) +
      "&" + built.scopeParam + "=" + encodeURIComponent(built.scope) +
      "&q=" + encodeURIComponent(built.q) +
      "&limit=" + String(built.limit);
    const payload = await send("/api/data/search?" + qs, { method: "GET", headers: headers(false) }, "search");
    return rowsOf(payload);
  }

  return { exec: exec, transaction: transaction, search: search };
}

// Browser wiring, appended by l0/emit.mjs. Engine: services/platform/db-http.ts (the one HTTP port
// implementation D1 and the Node sidecar both build on).
//
// Public API: window.dbHttp = { v, createHttpDbPort }. The two adapters normally consume the factory
// through the emitter's bare-name bridge; publishing it here as well keeps a page that only wants an
// ad-hoc HTTP port (a diagnostics panel, a test harness) from depending on load order.
(function (g) {
  "use strict";
  if (g.dbHttp) return;
  g.dbHttp = { v: 1, createHttpDbPort: createHttpDbPort };
})(window);

globalThis.createHttpDbPort = createHttpDbPort;
})();
