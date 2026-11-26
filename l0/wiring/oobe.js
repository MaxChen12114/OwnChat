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
