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
 * Show the wizard when the desktop host is not actually usable yet.
 *
 * A logged-in, key-bearing, healthy host with the flag set stays out of the way; anything else gets a
 * dialog. On the web this never shows: there is no local host to configure (the deployment is the
 * host), and a "paste your admin password" prompt would be the wrong shape there.
 */
function shouldShow(state           )          {
  if (!state.shell) return false;
  if (!state.done) return true;
  return !state.hasToken || !state.modelKeySaved || state.health === "down";
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
      done: true,
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

// Browser wiring, appended by l0/emit.mjs. Engine: services/platform/oobe.ts (first-run decisions).
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

  // Catalog access (see l0/wiring/i18n.js). The engine answers synchronously once the catalog has
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
    style.textContent =
      "#oo-mask{position:fixed;inset:0;z-index:2147482000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}" +
      "#oo-box{width:min(560px,100%);max-height:88vh;overflow:auto;background:var(--panel,#141414);color:var(--text,#ececec);border:1px solid var(--border,#26262b);border-radius:14px;padding:18px 18px 14px;font:14px/1.55 ui-sans-serif,system-ui,sans-serif;box-shadow:0 24px 60px rgba(0,0,0,.45)}" +
      "#oo-box h2{margin:0 0 4px;font-size:17px;font-weight:600}" +
      "#oo-health{margin:0 0 14px;font-size:12px;color:var(--muted,#9a9a9a)}" +
      "#oo-health.ok{color:#8fce9e}" +
      "#oo-health.down{color:#e8918f}" +
      ".oo-step{border-top:1px solid var(--border,#26262b);padding:12px 0}" +
      ".oo-step h3{margin:0 0 6px;font-size:13px;font-weight:600;display:flex;gap:8px;align-items:center}" +
      ".oo-step h3 .oo-tag{margin-left:auto;font-weight:400;font-size:11px;color:var(--muted,#9a9a9a)}" +
      ".oo-step.done h3 .oo-tag{color:#8fce9e}" +
      ".oo-row{display:flex;gap:8px;margin:6px 0}" +
      ".oo-row input[type=password],.oo-row input[type=text]{flex:1 1 auto;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#2a2a2f);background:rgba(255,255,255,.04);color:inherit;font:inherit}" +
      ".oo-row input[type=password]:focus,.oo-row input[type=text]:focus{outline:none;border-color:var(--border-hi,#3a3a41)}" +
      ".oo-btn{padding:7px 12px;border-radius:8px;border:1px solid var(--border,#2a2a2f);background:rgba(255,255,255,.06);color:inherit;font:inherit;cursor:pointer;white-space:nowrap}" +
      ".oo-btn:hover{background:rgba(255,255,255,.11)}" +
      ".oo-btn[disabled]{opacity:.5;cursor:default}" +
      ".oo-btn.primary{background:rgba(255,255,255,.14)}" +
      ".oo-hint{font-size:12px;color:var(--muted,#9a9a9a);margin:4px 0 0}" +
      ".oo-msg{font-size:12px;margin:6px 0 0;min-height:16px}" +
      ".oo-msg.err{color:#e8918f}" +
      ".oo-msg.ok{color:#8fce9e}" +
      ".oo-foot{display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--border,#26262b);padding-top:12px}" +
      ".oo-check{display:flex;gap:8px;align-items:center}";
    document.head.appendChild(style);
  }

  function field(labelText, type, value, placeholder) {
    var row = document.createElement("div");
    row.className = "oo-row";
    var input = document.createElement("input");
    input.type = type;
    input.value = value || "";
    if (placeholder) input.placeholder = placeholder;
    row.appendChild(input);
    return { row: row, input: input, label: labelText };
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
    var steps = buildSteps(state);
    var healthEl = dialog.querySelector("#oo-health");
    healthEl.className = state.health === "ok" ? "ok" : state.health === "down" ? "down" : "";
    healthEl.textContent =
      state.health === "ok"
        ? T("oobe.health.ok", { base: hostBase() })
        : state.health === "down"
          ? T("oobe.health.down", { base: hostBase() })
          : T("oobe.health.checking");
    for (var i = 0; i < steps.length; i++) {
      var row = dialog.querySelector('[data-step="' + steps[i].id + '"]');
      if (!row) continue;
      row.className = "oo-step" + (steps[i].done ? " done" : "");
      var tag = row.querySelector(".oo-tag");
      if (tag) tag.textContent = TC(steps[i].status);
    }
    var doneBtn = dialog.querySelector("#oo-done");
    if (doneBtn) doneBtn.disabled = busy || !isComplete(state);
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
    var mask = el("div", "");
    mask.id = "oo-mask";
    var box = el("div", "");
    box.id = "oo-box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.appendChild(el("h2", "", T("oobe.title")));
    var health = el("p", "", T("oobe.health.checking"));
    health.id = "oo-health";
    box.appendChild(health);

    // ── step 1: admin password ──
    var step1 = el("div", "oo-step");
    step1.setAttribute("data-step", "password");
    var h1 = el("h3", "", T("oobe.steps.password.title"));
    h1.appendChild(el("span", "oo-tag", ""));
    step1.appendChild(h1);
    var passRow = el("div", "oo-row");
    var passInput = document.createElement("input");
    passInput.type = "password";
    passInput.placeholder = T("oobe.password.placeholder");
    passRow.appendChild(passInput);
    var localBtn = el("button", "oo-btn", T("oobe.password.useLocal"));
    localBtn.type = "button";
    passRow.appendChild(localBtn);
    var verifyBtn = el("button", "oo-btn primary", T("oobe.password.verify"));
    verifyBtn.type = "button";
    passRow.appendChild(verifyBtn);
    step1.appendChild(passRow);
    step1.appendChild(el("p", "oo-hint", T("oobe.password.hint")));
    var msg1 = el("p", "oo-msg", "");
    msg1.setAttribute("data-msg", "password");
    step1.appendChild(msg1);
    box.appendChild(step1);

    // ── step 2: model key ──
    var step2 = el("div", "oo-step");
    step2.setAttribute("data-step", "modelKey");
    var h2 = el("h3", "", T("oobe.steps.modelKey.title"));
    h2.appendChild(el("span", "oo-tag", ""));
    step2.appendChild(h2);
    var endpoint = field(T("oobe.modelKey.endpointLabel"), "text", DEFAULT_MODEL_ENDPOINT, T("oobe.modelKey.endpointPlaceholder"));
    var model = field(T("oobe.modelKey.modelLabel"), "text", DEFAULT_MODEL_ID, T("oobe.modelKey.modelPlaceholder"));
    var key = field(T("oobe.modelKey.keyLabel"), "password", "", T("oobe.modelKey.keyPlaceholder"));
    step2.appendChild(endpoint.row);
    step2.appendChild(model.row);
    step2.appendChild(key.row);
    var saveKeyBtn = el("button", "oo-btn primary", T("oobe.modelKey.save"));
    saveKeyBtn.type = "button";
    step2.appendChild(saveKeyBtn);
    step2.appendChild(el("p", "oo-hint", T("oobe.modelKey.hint")));
    var msg2 = el("p", "oo-msg", "");
    msg2.setAttribute("data-msg", "modelKey");
    step2.appendChild(msg2);
    box.appendChild(step2);

    // ── step 3: sync ──
    var step3 = el("div", "oo-step");
    step3.setAttribute("data-step", "sync");
    var h3 = el("h3", "", T("oobe.steps.sync.title"));
    h3.appendChild(el("span", "oo-tag", ""));
    step3.appendChild(h3);
    var checkWrap = el("label", "oo-check");
    var syncBox = document.createElement("input");
    syncBox.type = "checkbox";
    checkWrap.appendChild(syncBox);
    checkWrap.appendChild(el("span", "", T("oobe.sync.label")));
    step3.appendChild(checkWrap);
    step3.appendChild(el("p", "oo-hint", T("oobe.sync.hint")));
    box.appendChild(step3);

    // ── footer ──
    var foot = el("div", "oo-foot");
    var later = el("button", "oo-btn", T("oobe.later"));
    later.type = "button";
    var done = el("button", "oo-btn primary", T("oobe.done"));
    done.id = "oo-done";
    done.type = "button";
    foot.appendChild(later);
    foot.appendChild(done);
    box.appendChild(foot);
    mask.appendChild(box);
    mask.addEventListener("click", function (e) {
      if (e.target === mask) close();
    });
    document.body.appendChild(mask);
    dialog = box;
    document.addEventListener("keydown", onKey);

    localBtn.addEventListener("click", function () {
      useLocalPassword(passInput, localBtn);
    });
    verifyBtn.addEventListener("click", function () {
      verifyPassword(passInput, verifyBtn);
    });
    saveKeyBtn.addEventListener("click", function () {
      saveModelKey({ endpoint: endpoint, model: model, key: key }, saveKeyBtn, cached);
    });
    syncBox.addEventListener("change", function () {
      try {
        g.localStorage.setItem(SYNC_ENABLED_KEY, syncValue(!!syncBox.checked));
      } catch (e) {}
      render(currentState(cached ? cached.health : "unknown"));
    });
    later.addEventListener("click", close);
    done.addEventListener("click", function () {
      if (hostKv) {
        hostKv.set(OOBE_DONE_KEY, "1");
        void hostKv.flush();
      }
      close();
    });

    // Initial paint: state first, health after the probe (never block the dialog on a dead host).
    var initial = currentState("unknown");
    syncBox.checked = initial.syncOn;
    render(initial);
    probe().then(function (health) {
      render(currentState(health));
      // The host may still be starting when the dialog opens; one delayed re-probe turns
      // "未连接" into "已连接" without the user pressing anything.
      if (health !== "ok") {
        setTimeout(function () {
          if (!dialog) return;
          probe().then(function (again) {
            if (dialog) render(currentState(again));
          });
        }, 1500);
      }
    });
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function close() {
    if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
    dialog = null;
    try {
      document.removeEventListener("keydown", onKey);
    } catch (e) {}
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
