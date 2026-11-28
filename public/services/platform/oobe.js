(function () {
/**
 * First-run decisions: what the host setup wizard asks for, in what order, and when it may stay closed.
 *
 * The wizard is three facts, not three pages: an admin password (the sidecar's access gate), a model
 * key (so a chat can actually leave the machine), and the cloud-sync switch (optional, and only
 * meaningful on a host others also reach). This module owns the *decisions* — should it show, which
 * steps are still blocking, what is a usable key, how a probe result reads — and the wiring owns the
 * DOM.
 *
 * Copy is **addressed, not written**: every user-visible sentence here is a `Copy` descriptor
 * (`{ key, params }`) whose text lives in `public/locales/<lang>.json`. The wiring renders it with
 * `__i18n.tCopy`. That keeps this module free of both the DOM and the translation engine, and lets
 * `test/i18n-catalog.test.mjs` prove that every key it can emit exists in both catalogs.
 *
 * Storage split, deliberately: the "already seen" flag lives in the native KV (`ownchat` namespace,
 * via the storage port), while the two values that existing code reads keep their old homes
 * (`cfw_auth_token_v1` in localStorage via authSvc, `cfw_sync_enabled_v1` in localStorage). Moving
 * those readers is T3-D/T4-A work; writing two sources would be the split-brain this repo avoids.
 *
 * `modelKeySaved` is the only wizard-local fact: the provider registry has no "this key came from the
 * wizard" marker, and inferring it from "any custom provider exists" would hide the step from users
 * who tried one and it failed.
 * @module services/platform/oobe
 */

/** A message in the catalog: `key` plus interpolation params (params may nest descriptors). */
                       
                       
                                            
 

/** Host namespaces and legacy keys the wizard reads or writes. */
const OOBE_NS = "host";
const OOBE_DONE_KEY = "oobe_done_v1";
const OOBE_MODEL_KEY = "oobe_model_key_v1";
const ACCESS_TOKEN_KEY = "cfw_auth_token_v1";
const SYNC_ENABLED_KEY = "cfw_sync_enabled_v1";

/** Defaults for the model-key step (a DeepSeek-compatible endpoint; editable by the user). */
const DEFAULT_MODEL_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_MODEL_ID = "deepseek-chat";

                                                   

/** What the wiring observed; nothing here is derived from DOM state. */
                            
                          
                              
                             
                                  
                           
                                                            
                         
 

/** One row in the dialog. `blocking` steps gate the 完成 button. */
                               
                                                
                       
                         
                             
                        
 

/** `POST /api/unlock` outcome, mirroring services/auth/token.ts (401 = wrong, 500 = store unbound). */
                                  
                       
                                                                               
                                
 

/** A usable model-key submission, or the reason it is not usable. */
                               
                       
                                                                          
                              
                                                                                         
                        
                            
                         
                          
 

function isRecord(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Show the wizard only on a true first run.
 *
 * A desktop installation that already has an access token or a wizard-saved model key predates this
 * wizard (or finished it), so it must not be greeted again just because the new
 * `oobe_done_v1` / `oobe_model_key_v1` flags are absent in the native KV. The same rule keeps a
 * transient host-down probe from turning into a first-run dialog: host health has its own indicator,
 * and the wizard is not a reconnect banner.
 *
 * On the web this never shows: there is no local host to configure (the deployment is the host), and
 * a "paste your admin password" prompt would be the wrong shape there.
 */
function shouldShow(state           )          {
  if (!state.shell) return false;
  if (state.done) return false;
  return !state.hasToken && !state.modelKeySaved;
}

/** The three rows, in the order the dialog renders them. */
function buildSteps(state           )                 {
  return [
    {
      id: "password",
      title: { key: "oobe.steps.password.title" },
      done: state.hasToken,
      blocking: true,
      status: state.hasToken ? { key: "oobe.steps.password.done" } : { key: "oobe.steps.password.pending" },
    },
    {
      id: "modelKey",
      title: { key: "oobe.steps.modelKey.title" },
      done: state.modelKeySaved,
      blocking: true,
      status: state.modelKeySaved ? { key: "oobe.steps.modelKey.done" } : { key: "oobe.steps.modelKey.pending" },
    },
    {
      id: "sync",
      title: { key: "oobe.steps.sync.title" },
      done: state.syncOn,
      blocking: false,
      status: state.syncOn ? { key: "oobe.steps.sync.on" } : { key: "oobe.steps.sync.off" },
    },
  ];
}

/** Whether 完成 may close the dialog (optional steps never block). */
function isComplete(state           )          {
  return state.hasToken && state.modelKeySaved;
}

/** `/config.js` probe result: a 2xx with the OwnChat marker is healthy. */
function judgeHealth(status        , bodyHasMarker         )             {
  if (status >= 200 && status < 300 && bodyHasMarker) return "ok";
  return "down";
}

/** `POST /api/unlock` judgement. Kept in step with services/auth/token.ts. */
function judgePassword(status        )                  {
  if (status === 401) return { ok: false, message: { key: "oobe.password.wrong" } };
  if ((status >= 200 && status < 300) || status === 500) return { ok: true, message: null };
  return { ok: false, message: { key: "oobe.password.network", params: { status: status } } };
}

/**
 * Validate the model-key step. The endpoint must be absolute (a bare host would silently become a
 * page-relative path — the same failure normalizeBase refuses), the model id must be non-empty, and
 * the key must look like a key rather than a placeholder.
 */
function planModelKey(input         )               {
  const rec = isRecord(input) ? input : {};
  const endpoint = (typeof rec.endpoint === "string" && rec.endpoint.trim()) || DEFAULT_MODEL_ENDPOINT;
  const model = (typeof rec.model === "string" && rec.model.trim()) || DEFAULT_MODEL_ID;
  const apiKey = typeof rec.apiKey === "string" ? rec.apiKey.trim() : "";
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const fail = (error      )               => ({ ok: false, error: error, name: name, endpoint: endpoint, model: model, apiKey: "" });
  if (!/^https?:\/\//i.test(endpoint)) return fail({ key: "oobe.modelKey.error.scheme" });
  if (!apiKey) return fail({ key: "oobe.modelKey.error.empty" });
  if (apiKey.length < 8) return fail({ key: "oobe.modelKey.error.short" });
  if (/\s/.test(apiKey)) return fail({ key: "oobe.modelKey.error.space" });
  return { ok: true, error: null, name: name, endpoint: endpoint.replace(/\/+$/, ""), model: model, apiKey: apiKey };
}

/** The localStorage value the sync engine reads (`=== "1"` is the only on-state). */
function syncValue(on         )            {
  return on ? "1" : "0";
}

/** Parse the `host` namespace JSON blobs without letting a corrupt value crash the dialog. */
function readFlag(raw               )          {
  return typeof raw === "string" && raw === "1";
}

// Browser wiring, appended by tooling/l0/emit.mjs. Engine: services/platform/oobe.ts (first-run decisions).
//
// Public API: window.oobeSvc = { v, open, close, state, refresh }. Non-`__` name; the dialog itself is
// the contract (it owns its DOM), and the tray entry reaches it through the `ownchat:host-settings`
// DOM event the host wiring re-broadcasts.
//
// This file is DOM only: every decision (should it show, which steps block, is the key usable, how a
// probe reads) comes from the engine. The two legacy values keep their existing homes — the access
// token goes through authSvc (localStorage `cfw_auth_token_v1`) and the sync switch writes
// `cfw_sync_enabled_v1` directly, because that is what the live readers read until T3-D/T4-A migrate
// them. Wizard-only facts live in the native KV `host` namespace.
(function (g) {
  "use strict";
  if (g.oobeSvc) return;
  if (!g.storageSvc || !g.hostSvc) return; // web build: nothing to configure, no local host
  var shell = false;
  try {
    shell = !!(g.tauriSvc && typeof g.tauriSvc.available === "function" && g.tauriSvc.available());
  } catch (e) {
    shell = false;
  }
  // The wizard exists for the local host. On the web the deployment is the host and there is no
  // password to paste, so this whole file stays out of the way.
  if (!shell) return;

  var hostKv = null;
  try {
    hostKv = g.storageSvc.namespaces("host");
  } catch (e) {
    hostKv = null;
  }
  var dialog = null;
  var busy = false;
  var cached = null;
  var lastFocus = null;
  var prevOverflow = "";
  var pageEls = {};
  var currentPage = "welcome";
  var pageOrder = ["welcome", "password", "modelKey", "sync", "done"];

  // Catalog access (see tooling/l0/wiring/i18n.js). The engine answers synchronously once the catalog has
  // landed; `whenReady` defers the first paint in the rare case it has not. Copy keys and their text
  // live in public/locales/<lang>.json — never inline Chinese here.
  function T(key, params) {
    try { return g.__i18n.t(key, params); } catch (e) { return key; }
  }
  function TC(copy) {
    try { return g.__i18n.tCopy(copy); } catch (e) { return copy && copy.key ? copy.key : ""; }
  }
  function whenCopyReady(fn) {
    try {
      if (g.__i18n && typeof g.__i18n.whenReady === "function") { g.__i18n.whenReady(fn); return; }
    } catch (e) { /* fall through: paint with whatever the engine has */ }
    fn();
  }

  function ls(key, fallback) {
    try {
      var v = g.localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function flag(key) {
    if (!hostKv) return false;
    try {
      return readFlag(hostKv.get(key));
    } catch (e) {
      return false;
    }
  }
  function token() {
    try {
      if (g.authSvc && typeof g.authSvc.getToken === "function") return String(g.authSvc.getToken() || "");
    } catch (e) {}
    return String(ls(ACCESS_TOKEN_KEY, "") || "");
  }
  function currentState(health) {
    return {
      shell: shell,
      health: health || "unknown",
      hasToken: token() !== "",
      modelKeySaved: flag(OOBE_MODEL_KEY),
      syncOn: ls(SYNC_ENABLED_KEY, "0") === "1",
      done: flag(OOBE_DONE_KEY),
    };
  }
  function hostBase() {
    try {
      return String(g.hostSvc.base() || "http://127.0.0.1:8787");
    } catch (e) {
      return "http://127.0.0.1:8787";
    }
  }

  /** Probe /config.js through the pre-router fetch (no stale Authorization involved). */
  function probe() {
    var base = hostBase().replace(/\/+$/, "");
    return g.hostSvc.rawFetch(base + "/config.js", { method: "GET", redirect: "manual" }).then(
      function (res) {
        return res.text().then(
          function (body) {
            return judgeHealth(res.status, String(body || "").indexOf("APP_CTX_EXACT") >= 0);
          },
          function () {
            return "down";
          },
        );
      },
      function () {
        return "down";
      },
    );
  }

  function css() {
    if (document.getElementById("oo-style")) return;
    var style = document.createElement("style");
    style.id = "oo-style";
    style.textContent = [
      "#oo-mask{position:fixed;inset:0;z-index:2147482000;display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;background-color:var(--bg,#fbf6f4);background-image:var(--oobe-window-image,linear-gradient(165deg,var(--accent-soft,transparent),transparent 58%));font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.5;color:var(--text,#2c2a2e);animation:ob-in 420ms cubic-bezier(.22,1,.36,1) both}",
      "#oo-mask [hidden]{display:none!important}",
      "#oo-mask{--dg-window-bg:var(--bg,#fbf6f4);--dg-text-primary:var(--text,#2c2a2e);--dg-text-secondary:var(--muted,#726e77);--dg-text-muted:var(--muted,#726e77);--dg-accent:var(--accent,#ff8a5b);--dg-accent-strong:var(--accent-2,#d9642c);--dg-accent-text:var(--accent-3,var(--accent,#ff8a5b));--dg-accent-bg:var(--accent-soft,rgba(243,133,75,.1));--dg-card-border:var(--border,#e1e1e1);--dg-timeline-grid:var(--border,#e1e1e1);--dg-timeline-card-fill:var(--card,#fff);--dg-hover-fill:var(--accent-soft,rgba(243,133,75,.1));--dg-hover-fill-strong:var(--border-soft,var(--border,#e1e1e1));--dg-focus-ring:var(--accent-soft,rgba(243,133,75,.3));--dg-success:var(--ok,#2f7d57);--dg-danger:var(--danger,#d9432f);--dg-input-fill:var(--input-bg,var(--card,#fff));--dg-input-fill-hover:var(--card,#fff);--dg-input-border:var(--input-border,var(--border,#e1e1e1));--dg-button-secondary-fill:var(--btn-bg,var(--card,#fff));--dg-button-secondary-border:var(--border,#e1e1e1);--dg-button-secondary-text:var(--text,#2c2a2e);--dg-button-secondary-hover:var(--btn-bg-hover,var(--card,#fff));--dg-button-primary-fill:var(--accent,#ff8a5b);--dg-button-primary-hover:var(--accent-2,#d9642c);--dg-button-primary-text:var(--ac-contrast,#fff);--dg-button-primary-shadow:0 8px 20px var(--accent-soft,rgba(243,133,75,.25));--dg-track-fill:var(--card-2,#fbf6f4);--dg-switch-track:var(--input-bg,var(--card-2,#fbf6f4));--dg-switch-track-hover:var(--card-2,#fbf6f4);--dg-switch-knob:#fff;--dg-switch-knob-shadow:0 1px 2px rgba(0,0,0,.2);--dg-motion-base:.2s;--dg-motion-fast:.12s;--dg-ease-out:cubic-bezier(.22,1,.36,1);--dg-ease-glide:cubic-bezier(.32,.72,0,1);--oobe-window-image:linear-gradient(165deg,var(--accent-soft,transparent),transparent 58%)}",
      "html[data-theme=\"lumen\"] #oo-mask{--oobe-window-image:var(--dg-window-gradient)}",
      "#oo-mask .ob__glow{position:absolute;border-radius:50%;filter:blur(60px);opacity:.55;pointer-events:none}",
      "#oo-mask .ob__glow--a{top:-160px;left:-120px;width:520px;height:420px;background:color-mix(in srgb,var(--dg-accent,#ff8a5b) 30%,transparent);animation:ob-drift 16s ease-in-out infinite alternate}",
      "#oo-mask .ob__glow--b{right:-160px;bottom:-200px;width:560px;height:460px;background:color-mix(in srgb,#ffb98a 40%,transparent);animation:ob-drift 20s ease-in-out infinite alternate-reverse}",
      "#oo-mask .ob__bar{position:relative;z-index:1;display:flex;align-items:center;gap:12px;height:52px;padding:0 20px}",
      "#oo-mask .ob__progress{display:flex;align-items:center;gap:5px}",
      "#oo-mask .ob__segment{width:28px;height:4px;border-radius:999px;background:var(--dg-hover-fill-strong,rgba(44,42,46,.12));transition:background var(--dg-motion-base,.2s) ease,width var(--dg-motion-base,.2s) var(--dg-ease-out,ease)}",
      "#oo-mask .ob__segment.is-done{background:color-mix(in srgb,var(--dg-accent,#ff8a5b) 55%,transparent)}",
      "#oo-mask .ob__segment.is-current{width:44px;background:var(--dg-accent,#ff8a5b)}",
      "#oo-mask .ob__count{margin-left:8px;color:var(--dg-text-muted,var(--muted,#726e77));font-size:11px;font-variant-numeric:tabular-nums}",
      "#oo-mask .ob__spacer{flex:1}",
      "#oo-mask .ob__health{display:inline-flex;align-items:center;gap:7px;max-width:42vw;overflow:hidden;padding:5px 10px;border:1px solid var(--dg-timeline-grid,var(--border,#e1e1e1));border-radius:999px;background:var(--dg-timeline-card-fill,var(--card,#fff));color:var(--dg-text-muted,var(--muted,#726e77));font-size:11px;white-space:nowrap;text-overflow:ellipsis}",
      "#oo-mask .ob__health:before{content:'';flex:none;width:6px;height:6px;border-radius:50%;background:var(--dg-text-muted,var(--muted,#726e77))}",
      "#oo-mask .ob__health.ok{color:var(--dg-success,var(--ok,#2f7d57))}",
      "#oo-mask .ob__health.ok:before{background:var(--dg-success,var(--ok,#2f7d57))}",
      "#oo-mask .ob__health.down{color:var(--dg-danger,var(--danger,#d9432f))}",
      "#oo-mask .ob__health.down:before{background:var(--dg-danger,var(--danger,#d9432f))}",
      "#oo-mask .ob__skip{padding:6px 12px;border:none;border-radius:999px;background:transparent;color:var(--dg-text-muted,var(--muted,#726e77));font-family:inherit;font-size:12px;font-weight:550;cursor:pointer}",
      "#oo-mask .ob__skip:hover{background:var(--dg-hover-fill,var(--accent-soft,rgba(243,133,75,.1)));color:var(--dg-text-primary,var(--text,#2c2a2e))}",
      "#oo-mask .ob__skip:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dg-focus-ring,var(--accent-soft,rgba(243,133,75,.3)))}",
      "#oo-mask .ob__theme{appearance:none;-webkit-appearance:none;padding:6px 26px 6px 10px;border:1px solid var(--border,#e1e1e1);border-radius:999px;background-color:var(--card,#fff);background-image:linear-gradient(45deg,transparent 50%,var(--muted,#726e77) 50%),linear-gradient(135deg,var(--muted,#726e77) 50%,transparent 50%);background-position:calc(100% - 13px) 50%,calc(100% - 8px) 50%;background-size:5px 5px;background-repeat:no-repeat;color:var(--text,#2c2a2e);font-family:inherit;font-size:12px;cursor:pointer}",
      "#oo-mask .ob__theme:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-soft,rgba(243,133,75,.3))}",
      "#oo-mask .ob__stage{position:relative;z-index:1;display:grid;justify-items:center;min-height:0;padding:12px 32px 32px}",
      "#oo-mask .ob-page{animation:ob-forward 320ms var(--dg-ease-out,cubic-bezier(.22,1,.36,1)) both}",
      "#oo-mask .ob-page.is-back{animation-name:ob-back}",
      "#oo-mask .ob-hero{display:flex;flex-direction:column;align-items:center;justify-content:center;max-width:560px;height:100%;text-align:center}",
      "#oo-mask .ob-hero__icon{width:96px;height:96px;margin-bottom:18px;border-radius:24px;filter:drop-shadow(0 10px 24px rgba(99,71,56,.25))}",
      "#oo-mask .ob-hero__title{margin:0;color:var(--dg-text-primary,var(--text,#2c2a2e));font-family:'Source Han Serif SC','Noto Serif SC','Songti SC',serif;font-size:44px;font-weight:600;letter-spacing:-1px;line-height:1.12;max-width:100%}",
      "#oo-mask .ob-hero__body{margin:16px 0 0;max-width:520px;color:var(--dg-text-secondary,var(--muted,#726e77));font-size:15px;line-height:1.65}",
      "#oo-mask .ob-hero__cta{min-width:200px;margin-top:32px}",
      "#oo-mask .ob-hero__check{display:grid;width:72px;height:72px;margin-bottom:20px;border-radius:50%;background:var(--dg-accent,#ff8a5b);color:#fff;place-items:center;box-shadow:0 10px 28px color-mix(in srgb,var(--dg-accent,#ff8a5b) 40%,transparent);animation:ob-pop 520ms cubic-bezier(.2,1.4,.4,1) both}",
      "#oo-mask .ob-hero__buttons{display:flex;gap:10px;margin-top:32px}",
      "#oo-mask .ob-step{display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;width:min(680px,100%);height:100%;min-height:0}",
      "#oo-mask .ob-step__title{margin:0;color:var(--dg-text-primary,var(--text,#2c2a2e));font-family:'Source Han Serif SC','Noto Serif SC','Songti SC',serif;font-size:36px;font-weight:600;letter-spacing:-.5px;line-height:1.15;text-align:center}",
      "#oo-mask .ob-step__body{max-width:540px;margin:12px auto 0;color:var(--dg-text-secondary,var(--muted,#726e77));font-size:14px;line-height:1.6;text-align:center}",
      "#oo-mask .ob-step__content{min-height:0;margin-top:28px;overflow-y:auto;padding:4px}",
      "#oo-mask .ob-step__actions{display:flex;align-items:center;gap:10px;padding-top:20px}",
      "#oo-mask .ob-step__spacer{flex:1}",
      "#oo-mask .ob-card{max-width:560px;margin:0 auto;padding:14px 16px;border:1px solid var(--dg-timeline-grid,var(--border,#e1e1e1));border-radius:14px;background:var(--dg-timeline-card-fill,var(--card,#fff))}",
      "#oo-mask .ob-field{display:grid;gap:6px;margin-bottom:10px}",
      "#oo-mask .ob-field:last-of-type{margin-bottom:0}",
      "#oo-mask .ob-field__label{color:var(--dg-text-primary,var(--text,#2c2a2e));font-size:12px;font-weight:600}",
      "#oo-mask .dg-input{width:100%;min-height:34px;padding:7px 10px;border:none;border-radius:7px;background-color:var(--dg-input-fill,var(--card-2,#fff));box-shadow:inset 0 0 0 1px var(--dg-input-border,var(--border,#e1e1e1));color:var(--dg-text-primary,var(--text,#2c2a2e));font-family:inherit;font-size:13px;transition:background-color var(--dg-motion-fast,.12s) ease,box-shadow var(--dg-motion-base,.2s) var(--dg-ease-out,ease)}",
      "#oo-mask .dg-input:hover{background-color:var(--dg-input-fill-hover,var(--card,#fff))}",
      "#oo-mask .dg-input:focus-visible{outline:none;box-shadow:inset 0 0 0 1px var(--dg-accent,#ff8a5b),0 0 0 3px var(--dg-focus-ring,var(--accent-soft,rgba(243,133,75,.3)))}",
      "#oo-mask .ob-inline{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}",
      "#oo-mask .ob-msg{min-height:0;margin:10px 0 0;font-size:12px;line-height:1.5}",
      "#oo-mask .ob-msg:empty{display:none}",
      "#oo-mask .ob-msg.err{color:var(--dg-danger,var(--danger,#d9432f))}",
      "#oo-mask .ob-msg.ok{color:var(--dg-success,var(--ok,#2f7d57))}",
      "#oo-mask .ob-prefs{display:grid;max-width:560px;margin:0 auto;border:1px solid var(--dg-timeline-grid,var(--border,#e1e1e1));border-radius:14px;background:var(--dg-timeline-card-fill,var(--card,#fff))}",
      "#oo-mask .ob-pref{display:flex;align-items:center;gap:16px;min-height:56px;padding:10px 16px;cursor:pointer}",
      "#oo-mask .ob-pref__text{display:grid;flex:1;gap:2px;min-width:0}",
      "#oo-mask .ob-pref__text strong{color:var(--dg-text-primary,var(--text,#2c2a2e));font-size:13px;font-weight:600}",
      "#oo-mask .ob-pref__text span{color:var(--dg-text-muted,var(--muted,#726e77));font-size:11px;line-height:1.45}",
      "#oo-mask .dg-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:6px 14px;border:none;border-radius:8px;background:var(--dg-button-secondary-fill,var(--card-2,#fff));box-shadow:inset 0 0 0 1px var(--dg-button-secondary-border,var(--border,#e1e1e1));color:var(--dg-button-secondary-text,var(--text,#2c2a2e));font-family:inherit;font-size:13px;font-weight:550;white-space:nowrap;cursor:pointer;transition:background var(--dg-motion-fast,.12s) ease,box-shadow var(--dg-motion-base,.2s) var(--dg-ease-out,ease),transform var(--dg-motion-base,.2s) var(--dg-ease-glide,ease)}",
      "#oo-mask .dg-button:disabled{opacity:.48;cursor:default}",
      "#oo-mask .dg-button:not(:disabled):hover{background:var(--dg-button-secondary-hover,var(--card,#fff))}",
      "#oo-mask .dg-button:not(:disabled):active{background:var(--dg-track-fill,var(--card-2,#f0ebe6));box-shadow:inset 0 1px 2px rgba(20,16,25,.08);transform:scale(.97)}",
      "#oo-mask .dg-button:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dg-focus-ring,var(--accent-soft,rgba(243,133,75,.3)))}",
      "#oo-mask .dg-button--primary{background:var(--dg-button-primary-fill,var(--accent,#ff8a5b));box-shadow:var(--dg-button-primary-shadow,0 1px 0 rgba(255,255,255,.2) inset);color:var(--dg-button-primary-text,#fff)}",
      "#oo-mask .dg-button--primary:not(:disabled):hover{background:var(--dg-button-primary-hover,var(--accent-2,#f77952))}",
      "#oo-mask .dg-button--primary:not(:disabled):active{background:var(--dg-button-primary-hover,var(--accent-2,#f77952));box-shadow:inset 0 2px 4px rgba(15,34,60,.22)}",
      "#oo-mask .dg-button--lg{min-height:40px;padding:8px 22px;border-radius:10px;font-size:14px;font-weight:600}",
      "#oo-mask .dg-button svg{flex:none}",
      "#oo-mask .switch{display:inline-flex;align-items:center;padding:9px 0}",
      "#oo-mask .switch input{position:absolute;width:1px;height:1px;margin:0;opacity:0}",
      "#oo-mask .switch__track{position:relative;display:inline-block;box-sizing:border-box;width:40px;height:22px;border:1px solid var(--dg-input-border,var(--border,#e1e1e1));border-radius:999px;background:var(--dg-switch-track,var(--card-2,#f0ebe6));cursor:pointer;transition:background var(--dg-motion-base,.2s) ease,border-color var(--dg-motion-base,.2s) ease}",
      "#oo-mask .switch__track:after{content:'';position:absolute;top:2px;left:2px;box-sizing:border-box;width:16px;height:16px;border-radius:50%;background:var(--dg-switch-knob,#fff);box-shadow:var(--dg-switch-knob-shadow,0 1px 2px rgba(0,0,0,.2));transition:transform var(--dg-motion-base,.2s) var(--dg-ease-glide,ease)}",
      "#oo-mask .switch input:checked + .switch__track{border-color:transparent;background:var(--dg-accent,#ff8a5b)}",
      "#oo-mask .switch input:checked + .switch__track:after{transform:translateX(18px)}",
      "#oo-mask .switch:hover input:not(:checked):not(:disabled) + .switch__track{background:var(--dg-switch-track-hover,var(--card-2,#f0ebe6))}",
      "#oo-mask .switch:hover input:checked:not(:disabled) + .switch__track{background:var(--dg-accent-strong,var(--accent-2,#f77952))}",
      "#oo-mask .switch input:focus-visible + .switch__track{box-shadow:0 0 0 3px var(--dg-focus-ring,var(--accent-soft,rgba(243,133,75,.3)))}",
      "@media(max-width:720px){#oo-mask .ob__bar{height:46px;padding:0 14px}#oo-mask .ob__health{display:none}#oo-mask .ob__stage{padding:8px 18px 20px}#oo-mask .ob-hero__icon{width:72px;height:72px;margin-bottom:14px;border-radius:18px}#oo-mask .ob-hero__title{font-size:32px;letter-spacing:-.5px}#oo-mask .ob-hero__body{font-size:14px;margin-top:12px}#oo-mask .ob-hero__cta{width:100%;min-width:0}#oo-mask .ob-step__title{font-size:28px}#oo-mask .ob-step__content{margin-top:18px}#oo-mask .ob-step__actions{padding-top:12px}}",
      "@media(prefers-reduced-motion:reduce){#oo-mask,#oo-mask .ob__glow,#oo-mask .ob-hero__check,#oo-mask .ob-page{animation:none}#oo-mask .dg-button,#oo-mask .switch__track,#oo-mask .switch__track:after{transition:none}}",
      "@keyframes ob-in{from{opacity:0}to{opacity:1}}",
      "@keyframes ob-drift{from{transform:translate(0,0) scale(1)}to{transform:translate(40px,30px) scale(1.08)}}",
      "@keyframes ob-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:scale(1)}}",
      "@keyframes ob-forward{from{opacity:0;transform:translateX(28px)}to{opacity:1;transform:none}}",
      "@keyframes ob-back{from{opacity:0;transform:translateX(-28px)}to{opacity:1;transform:none}}"
    ].join("");
    document.head.appendChild(style);
  }

  function field(labelText, type, value, placeholder) {
    var wrap = el("label", "ob-field");
    wrap.appendChild(el("span", "ob-field__label", labelText));
    var input = document.createElement("input");
    input.className = "dg-input";
    input.type = type;
    input.value = value || "";
    if (placeholder) input.placeholder = placeholder;
    wrap.appendChild(input);
    return { row: wrap, input: input, label: labelText };
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render(state) {
    cached = state;
    if (!dialog) return;
    var healthEl = dialog.querySelector("#oo-health");
    if (healthEl) {
      var text =
        state.health === "ok"
          ? T("oobe.health.ok", { base: hostBase() })
          : state.health === "down"
            ? T("oobe.health.down", { base: hostBase() })
            : T("oobe.health.checking");
      healthEl.className = "ob__health" + (state.health === "ok" ? " ok" : state.health === "down" ? " down" : "");
      healthEl.textContent = text;
      healthEl.title = text;
    }
    var verify = dialog.querySelector("#oo-verify");
    if (verify) verify.textContent = state.hasToken ? T("oobe.next") : T("oobe.password.verify");
    var saveKey = dialog.querySelector("#oo-save-key");
    if (saveKey) saveKey.textContent = state.modelKeySaved ? T("oobe.next") : T("oobe.modelKey.save");
    var sync = dialog.querySelector("#oo-sync");
    if (sync) sync.checked = state.syncOn;
    var done = dialog.querySelector("#oo-done");
    if (done) done.disabled = !isComplete(state);
    renderNav(state);
  }

  function say(step, text, cls) {
    if (!dialog) return;
    var box = dialog.querySelector('[data-msg="' + step + '"]');
    if (!box) return;
    box.className = "oo-msg" + (cls ? " " + cls : "");
    box.textContent = text || "";
  }

  function verifyPassword(input, button) {
    var value = String(input.value || "").trim();
    if (!value) {
      say("password", T("oobe.password.empty"), "err");
      return;
    }
    busy = true;
    button.disabled = true;
    say("password", T("oobe.password.checking"), "");
    var base = hostBase().replace(/\/+$/, "");
    g.hostSvc
      .rawFetch(base + "/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: value }),
      })
      .then(
        function (res) {
          var verdict = judgePassword(res.status);
          if (!verdict.ok) {
            say("password", TC(verdict.message), "err");
            return;
          }
          try {
            g.authSvc.setToken(value);
          } catch (e) {}
          say("password", T("oobe.password.signedIn"), "ok");
          return g.hostSvc.refresh().then(function () {
            return probe();
          }).then(function (health) {
            render(currentState(health));
            if (dialog && currentPage === "password") go("modelKey");
          });
        },
        function (e) {
          say("password", T("oobe.password.connectFailed", { error: (e && e.message) || e }), "err");
        },
      )
      .then(function () {
        busy = false;
        button.disabled = false;
      });
  }

  function useLocalPassword(input, button) {
    if (!g.tauriSvc || typeof g.tauriSvc.invoke !== "function") {
      say("password", T("oobe.password.localUnsupported"), "err");
      return;
    }
    busy = true;
    button.disabled = true;
    g.tauriSvc.invoke("host_admin_password").then(
      function (value) {
        busy = false;
        button.disabled = false;
        if (typeof value === "string" && value) {
          input.value = value;
          say("password", T("oobe.password.localFilled"), "");
        } else {
          say("password", T("oobe.password.localMissing"), "err");
        }
      },
      function (e) {
        busy = false;
        button.disabled = false;
        say("password", T("oobe.password.localFailed", { error: (e && e.message) || e }), "err");
      },
    );
  }

  function saveModelKey(fields, button, state) {
    var plan = planModelKey({
      endpoint: fields.endpoint.input.value,
      model: fields.model.input.value,
      apiKey: fields.key.input.value,
    });
    if (!plan.ok) {
      say("modelKey", TC(plan.error), "err");
      return;
    }
    if (!g.providersSvc || typeof g.providersSvc.newCustom !== "function") {
      say("modelKey", T("oobe.modelKey.registryMissing"), "err");
      return;
    }
    busy = true;
    button.disabled = true;
    try {
      var id = g.providersSvc.newCustom({
        name: plan.name || T("oobe.modelKey.defaultName"),
        endpoint: plan.endpoint,
        model: plan.model,
        apiKey: plan.apiKey,
      });
      if (!id) throw new Error(T("oobe.modelKey.channelFailed"));
      g.providersSvc.setActive("custom:" + id);
      try {
        if (typeof g.providersSvc.setSelectedModel === "function") g.providersSvc.setSelectedModel("custom:" + id, plan.model);
      } catch (e) {}
      if (hostKv) {
        hostKv.set(OOBE_MODEL_KEY, "1");
        void hostKv.flush();
      }
      say("modelKey", T("oobe.modelKey.saved"), "ok");
      render(currentState(state ? state.health : cached ? cached.health : "unknown"));
      if (dialog && currentPage === "modelKey") go("sync");
    } catch (e) {
      say("modelKey", T("oobe.modelKey.saveFailed", { error: (e && e.message) || e }), "err");
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  // The first paint must not show catalog keys, and the catalog load is async (see i18n.js).
  // `whenCopyReady` runs the builder synchronously once the catalog is in, so this is a no-op in
  // practice: the wizard usually opens ~900 ms in, long after the two JSON files landed.
  function open() {
    whenCopyReady(openNow);
  }

  function openNow() {
    if (dialog) {
      probe().then(function (health) {
        render(currentState(health));
      });
      return;
    }
    css();
    pageEls = {};
    currentPage = "welcome";
    var mask = el("div", "");
    mask.id = "oo-mask";
    mask.setAttribute("role", "dialog");
    mask.setAttribute("aria-modal", "true");
    mask.setAttribute("aria-label", T("oobe.title"));
    mask.appendChild(el("div", "ob__glow ob__glow--a"));
    mask.appendChild(el("div", "ob__glow ob__glow--b"));

    var bar = el("header", "ob__bar");
    var progress = el("div", "ob__progress");
    for (var si = 0; si < 3; si++) progress.appendChild(el("span", "ob__segment"));
    var count = el("span", "ob__count", "");
    progress.appendChild(count);
    bar.appendChild(progress);
    bar.appendChild(el("span", "ob__spacer"));
    var health = el("span", "ob__health", T("oobe.health.checking"));
    health.id = "oo-health";
    health.setAttribute("aria-live", "polite");
    bar.appendChild(health);
    var themeNow = "minimal";
    try { themeNow = String((g.themeSvc && g.themeSvc.get && g.themeSvc.get().style) || "minimal"); } catch (e) {}
    var themeSel = document.createElement("select");
    themeSel.className = "ob__theme";
    themeSel.setAttribute("aria-label", T("oobe.theme"));
    var themeIds = ["minimal", "glass", "lumen"];
    // A true first run cannot be candle: that theme is private and only becomes selectable after
    // unlock. If the wizard is opened manually from the tray on an already-configured install, do
    // not show a selector whose value is outside the public three.
    if (themeIds.indexOf(themeNow) >= 0) {
      for (var ti = 0; ti < themeIds.length; ti++) {
        var opt = document.createElement("option");
        opt.value = themeIds[ti];
        opt.textContent = T("oobe.themes." + themeIds[ti]);
        if (themeIds[ti] === themeNow) opt.selected = true;
        themeSel.appendChild(opt);
      }
      themeSel.addEventListener("change", function () {
        try { g.themeSvc.set({ style: themeSel.value }); } catch (e) {}
      });
      bar.appendChild(themeSel);
    }
    var langNow = "zh";
    try { langNow = String((g.__i18n && g.__i18n.lang) || "zh"); } catch (e) {}
    var langBtn = el("button", "ob__skip ob__lang", langNow.indexOf("en") === 0 ? "中文" : "EN");
    langBtn.type = "button";
    langBtn.title = "切换语言 / Switch language";
    langBtn.setAttribute("aria-label", "切换语言 / Switch language");
    langBtn.addEventListener("click", function () {
      try { g.__i18n.setLang(langNow.indexOf("en") === 0 ? "zh" : "en"); } catch (e) {}
    });
    bar.appendChild(langBtn);
    var skip = el("button", "ob__skip", T("oobe.skip"));
    skip.type = "button";
    bar.appendChild(skip);
    mask.appendChild(bar);

    var stage = el("main", "ob__stage");
    mask.appendChild(stage);

    function pageEl(id, cls) {
      var node = el("section", "ob-page " + cls);
      node.setAttribute("data-page", id);
      node.hidden = true;
      pageEls[id] = node;
      stage.appendChild(node);
      return node;
    }

    function arrowIcon() {
      var span = el("span", "");
      span.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
      return span;
    }
    function checkIcon(size) {
      var span = el("span", "");
      span.innerHTML = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>';
      return span;
    }

    // ── welcome ──
    var welcome = pageEl("welcome", "ob-hero");
    var icon = document.createElement("img");
    icon.className = "ob-hero__icon";
    icon.src = "/assets/icon-192.png";
    icon.alt = "";
    icon.width = 96;
    icon.height = 96;
    welcome.appendChild(icon);
    welcome.appendChild(el("h1", "ob-hero__title", T("oobe.title")));
    welcome.appendChild(el("p", "ob-hero__body", T("oobe.subtitle")));
    var startBtn = el("button", "dg-button dg-button--lg dg-button--primary ob-hero__cta", T("oobe.start"));
    startBtn.type = "button";
    startBtn.appendChild(arrowIcon());
    welcome.appendChild(startBtn);

    function makeStep(id, title, body) {
      var sec = pageEl(id, "ob-step");
      sec.appendChild(el("h1", "ob-step__title", title));
      if (body) sec.appendChild(el("p", "ob-step__body", body));
      var content = el("div", "ob-step__content");
      sec.appendChild(content);
      var actions = el("footer", "ob-step__actions");
      var back = el("button", "dg-button dg-button--lg", T("oobe.back"));
      back.type = "button";
      actions.appendChild(back);
      actions.appendChild(el("span", "ob-step__spacer"));
      sec.appendChild(actions);
      return { sec: sec, content: content, actions: actions, back: back };
    }

    // ── password ──
    var passStep = makeStep("password", T("oobe.steps.password.title"), T("oobe.password.hint"));
    var passCard = el("div", "ob-card");
    var passField = el("label", "ob-field");
    passField.appendChild(el("span", "ob-field__label", T("oobe.steps.password.title")));
    var passInput = document.createElement("input");
    passInput.className = "dg-input";
    passInput.type = "password";
    passInput.placeholder = T("oobe.password.placeholder");
    passInput.setAttribute("aria-label", T("oobe.steps.password.title"));
    passField.appendChild(passInput);
    passCard.appendChild(passField);
    var passInline = el("div", "ob-inline");
    var localBtn = el("button", "dg-button", T("oobe.password.useLocal"));
    localBtn.type = "button";
    passInline.appendChild(localBtn);
    passCard.appendChild(passInline);
    passStep.content.appendChild(passCard);
    var msg1 = el("p", "ob-msg", "");
    msg1.setAttribute("data-msg", "password");
    msg1.setAttribute("role", "status");
    passStep.content.appendChild(msg1);
    var verifyBtn = el("button", "dg-button dg-button--lg dg-button--primary", T("oobe.password.verify"));
    verifyBtn.type = "button";
    verifyBtn.id = "oo-verify";
    passStep.actions.appendChild(verifyBtn);
    passStep.back.addEventListener("click", function () { go("welcome", true); });

    // ── model key ──
    var modelStep = makeStep("modelKey", T("oobe.steps.modelKey.title"), T("oobe.modelKey.hint"));
    var modelCard = el("div", "ob-card");
    var endpoint = field(T("oobe.modelKey.endpointLabel"), "text", DEFAULT_MODEL_ENDPOINT, T("oobe.modelKey.endpointPlaceholder"));
    var model = field(T("oobe.modelKey.modelLabel"), "text", DEFAULT_MODEL_ID, T("oobe.modelKey.modelPlaceholder"));
    var key = field(T("oobe.modelKey.keyLabel"), "password", "", T("oobe.modelKey.keyPlaceholder"));
    modelCard.appendChild(endpoint.row);
    modelCard.appendChild(model.row);
    modelCard.appendChild(key.row);
    modelStep.content.appendChild(modelCard);
    var msg2 = el("p", "ob-msg", "");
    msg2.setAttribute("data-msg", "modelKey");
    msg2.setAttribute("role", "status");
    modelStep.content.appendChild(msg2);
    var saveKeyBtn = el("button", "dg-button dg-button--lg dg-button--primary", T("oobe.modelKey.save"));
    saveKeyBtn.type = "button";
    saveKeyBtn.id = "oo-save-key";
    modelStep.actions.appendChild(saveKeyBtn);
    modelStep.back.addEventListener("click", function () { go("password", true); });

    // ── sync ──
    var syncStep = makeStep("sync", T("oobe.steps.sync.title"), T("oobe.sync.hint"));
    var prefs = el("div", "ob-prefs");
    var pref = el("div", "ob-pref");
    var prefText = el("span", "ob-pref__text");
    prefText.appendChild(el("strong", "", T("oobe.sync.label")));
    pref.appendChild(prefText);
    var switchLabel = el("label", "switch");
    var syncBox = document.createElement("input");
    syncBox.type = "checkbox";
    syncBox.id = "oo-sync";
    syncBox.setAttribute("role", "switch");
    syncBox.setAttribute("aria-label", T("oobe.sync.label"));
    switchLabel.appendChild(syncBox);
    switchLabel.appendChild(el("span", "switch__track"));
    pref.appendChild(switchLabel);
    prefs.appendChild(pref);
    syncStep.content.appendChild(prefs);
    var doneBtn = el("button", "dg-button dg-button--lg dg-button--primary", T("oobe.done"));
    doneBtn.type = "button";
    doneBtn.id = "oo-done";
    syncStep.actions.appendChild(doneBtn);
    syncStep.back.addEventListener("click", function () { go("modelKey", true); });

    // ── done ──
    var done = pageEl("done", "ob-hero");
    var check = el("span", "ob-hero__check");
    check.appendChild(checkIcon(30));
    done.appendChild(check);
    done.appendChild(el("h1", "ob-hero__title", T("oobe.doneTitle")));
    done.appendChild(el("p", "ob-hero__body", T("oobe.doneBody")));
    var doneButtons = el("div", "ob-hero__buttons");
    var enterBtn = el("button", "dg-button dg-button--lg dg-button--primary", T("oobe.enter"));
    enterBtn.type = "button";
    doneButtons.appendChild(enterBtn);
    done.appendChild(doneButtons);

    document.body.appendChild(mask);
    dialog = mask;
    lastFocus = document.activeElement;
    try {
      prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
    } catch (e) {}
    document.addEventListener("keydown", onKey);

    function finish() {
      if (hostKv) {
        hostKv.set(OOBE_DONE_KEY, "1");
        void hostKv.flush();
      }
      close();
    }

    startBtn.addEventListener("click", function () { go("password"); });
    skip.addEventListener("click", finish);
    enterBtn.addEventListener("click", finish);
    localBtn.addEventListener("click", function () { useLocalPassword(passInput, localBtn); });
    verifyBtn.addEventListener("click", function () {
      var st = currentState(cached ? cached.health : "unknown");
      if (st.hasToken) go("modelKey");
      else verifyPassword(passInput, verifyBtn);
    });
    saveKeyBtn.addEventListener("click", function () {
      var st = currentState(cached ? cached.health : "unknown");
      if (st.modelKeySaved) go("sync");
      else saveModelKey({ endpoint: endpoint, model: model, key: key }, saveKeyBtn, cached);
    });
    syncBox.addEventListener("change", function () {
      try { g.localStorage.setItem(SYNC_ENABLED_KEY, syncValue(!!syncBox.checked)); } catch (e) {}
      render(currentState(cached ? cached.health : "unknown"));
    });
    doneBtn.addEventListener("click", function () { go("done"); });

    pageEls.welcome.hidden = false;
    currentPage = "welcome";
    render(currentState("unknown"));
    probe().then(function (health) {
      render(currentState(health));
      if (health !== "ok") {
        setTimeout(function () {
          if (!dialog) return;
          probe().then(function (again) { if (dialog) render(currentState(again)); });
        }, 1500);
      }
    });
  }

  function go(page, back) {
    if (!dialog || !pageEls[page]) return;
    var from = currentPage;
    if (from === page) return;
    if (pageEls[from]) pageEls[from].hidden = true;
    var target = pageEls[page];
    target.hidden = false;
    target.classList.remove("is-back");
    if (back) target.classList.add("is-back");
    target.style.animation = "none";
    void target.offsetWidth;
    target.style.animation = "";
    currentPage = page;
    render(currentState(cached ? cached.health : "unknown"));
    try {
      var input = target.querySelector("input.dg-input");
      if (input) input.focus({ preventScroll: true });
    } catch (e) {}
  }

  function renderNav(state) {
    if (!dialog) return;
    var progress = dialog.querySelector(".ob__progress");
    var count = dialog.querySelector(".ob__count");
    var skip = dialog.querySelector(".ob__skip:not(.ob__lang)");
    var langBtn = dialog.querySelector(".ob__lang");
    if (langBtn) langBtn.hidden = currentPage !== "welcome";
    var themeSelEl = dialog.querySelector(".ob__theme");
    if (themeSelEl) themeSelEl.hidden = currentPage !== "welcome";
    var idx = pageOrder.indexOf(currentPage);
    var show = idx >= 1 && idx <= 3;
    progress.hidden = !show;
    skip.hidden = currentPage === "done";
    if (!show) return;
    var steps = buildSteps(state);
    var segs = progress.querySelectorAll(".ob__segment");
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle("is-done", i < idx - 1 || (i === idx - 1 && steps[i].done));
      segs[i].classList.toggle("is-current", i === idx - 1);
    }
    count.textContent = T("oobe.stepOf", { current: idx, total: 3 });
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function close() {
    if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
    dialog = null;
    try {
      document.documentElement.style.overflow = prevOverflow || "";
    } catch (e) {}
    try {
      document.removeEventListener("keydown", onKey);
    } catch (e) {}
    try {
      if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus({ preventScroll: true });
    } catch (e) {}
    lastFocus = null;
  }

  g.oobeSvc = {
    v: 1,
    open: open,
    close: close,
    state: function (health) {
      return currentState(health);
    },
    refresh: function () {
      return probe().then(function (health) {
        render(currentState(health));
        return currentState(health);
      });
    },
  };

  // Tray entry → host wiring re-broadcast → here.
  try {
    g.addEventListener("ownchat:host-settings", function () {
      open();
    });
  } catch (e) {}

  // First run: wait for the first paint, then decide. `shouldShow` is the engine's call.
  setTimeout(function () {
    probe().then(function (health) {
      var state = currentState(health);
      if (shouldShow(state)) open();
    });
  }, 900);
})(window);

globalThis.OOBE_NS = OOBE_NS;
globalThis.OOBE_DONE_KEY = OOBE_DONE_KEY;
globalThis.OOBE_MODEL_KEY = OOBE_MODEL_KEY;
globalThis.ACCESS_TOKEN_KEY = ACCESS_TOKEN_KEY;
globalThis.SYNC_ENABLED_KEY = SYNC_ENABLED_KEY;
globalThis.DEFAULT_MODEL_ENDPOINT = DEFAULT_MODEL_ENDPOINT;
globalThis.DEFAULT_MODEL_ID = DEFAULT_MODEL_ID;
globalThis.shouldShow = shouldShow;
globalThis.buildSteps = buildSteps;
globalThis.isComplete = isComplete;
globalThis.judgeHealth = judgeHealth;
globalThis.judgePassword = judgePassword;
globalThis.planModelKey = planModelKey;
globalThis.syncValue = syncValue;
globalThis.readFlag = readFlag;
})();
