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
        ? "宿主状态：已连接（" + hostBase() + "）"
        : state.health === "down"
          ? "宿主状态：未连接（" + hostBase() + "）—— 本机宿主可能还没启动"
          : "宿主状态：检测中…";
    for (var i = 0; i < steps.length; i++) {
      var row = dialog.querySelector('[data-step="' + steps[i].id + '"]');
      if (!row) continue;
      row.className = "oo-step" + (steps[i].done ? " done" : "");
      var tag = row.querySelector(".oo-tag");
      if (tag) tag.textContent = steps[i].status;
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
      say("password", "请输入管理员密码", "err");
      return;
    }
    busy = true;
    button.disabled = true;
    say("password", "正在验证…", "");
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
            say("password", verdict.message, "err");
            return;
          }
          try {
            g.authSvc.setToken(value);
          } catch (e) {}
          say("password", "已登录", "ok");
          return g.hostSvc.refresh().then(function () {
            return probe();
          }).then(function (health) {
            render(currentState(health));
          });
        },
        function (e) {
          say("password", "无法连接宿主：" + ((e && e.message) || e), "err");
        },
      )
      .then(function () {
        busy = false;
        button.disabled = false;
      });
  }

  function useLocalPassword(input, button) {
    if (!g.tauriSvc || typeof g.tauriSvc.invoke !== "function") {
      say("password", "当前环境不支持读取本机密码", "err");
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
          say("password", "已填入本机密码，点「验证并保存」继续", "");
        } else {
          say("password", "还没找到本机密码文件：宿主首次启动后会自动生成", "err");
        }
      },
      function (e) {
        busy = false;
        button.disabled = false;
        say("password", "读取本机密码失败：" + ((e && e.message) || e), "err");
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
      say("modelKey", plan.error, "err");
      return;
    }
    if (!g.providersSvc || typeof g.providersSvc.newCustom !== "function") {
      say("modelKey", "模型渠道注册表不可用，无法保存", "err");
      return;
    }
    busy = true;
    button.disabled = true;
    try {
      var id = g.providersSvc.newCustom({ name: plan.name, endpoint: plan.endpoint, model: plan.model, apiKey: plan.apiKey });
      if (!id) throw new Error("渠道创建失败");
      g.providersSvc.setActive("custom:" + id);
      try {
        if (typeof g.providersSvc.setSelectedModel === "function") g.providersSvc.setSelectedModel("custom:" + id, plan.model);
      } catch (e) {}
      if (hostKv) {
        hostKv.set(OOBE_MODEL_KEY, "1");
        void hostKv.flush();
      }
      say("modelKey", "已保存，下一条消息就会用这个渠道", "ok");
      render(currentState(state ? state.health : cached ? cached.health : "unknown"));
    } catch (e) {
      say("modelKey", "保存失败：" + ((e && e.message) || e), "err");
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  function open() {
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
    box.appendChild(el("h2", "", "首次设置"));
    var health = el("p", "", "宿主状态：检测中…");
    health.id = "oo-health";
    box.appendChild(health);

    // ── step 1: admin password ──
    var step1 = el("div", "oo-step");
    step1.setAttribute("data-step", "password");
    var h1 = el("h3", "", "管理员密码");
    h1.appendChild(el("span", "oo-tag", ""));
    step1.appendChild(h1);
    var passRow = el("div", "oo-row");
    var passInput = document.createElement("input");
    passInput.type = "password";
    passInput.placeholder = "宿主的管理员密码";
    passRow.appendChild(passInput);
    var localBtn = el("button", "oo-btn", "使用本机密码");
    localBtn.type = "button";
    passRow.appendChild(localBtn);
    var verifyBtn = el("button", "oo-btn primary", "验证并保存");
    verifyBtn.type = "button";
    passRow.appendChild(verifyBtn);
    step1.appendChild(passRow);
    step1.appendChild(el("p", "oo-hint", "宿主首次启动会自动生成密码，保存在数据目录的 admin-password.txt。"));
    var msg1 = el("p", "oo-msg", "");
    msg1.setAttribute("data-msg", "password");
    step1.appendChild(msg1);
    box.appendChild(step1);

    // ── step 2: model key ──
    var step2 = el("div", "oo-step");
    step2.setAttribute("data-step", "modelKey");
    var h2 = el("h3", "", "模型 Key");
    h2.appendChild(el("span", "oo-tag", ""));
    step2.appendChild(h2);
    var endpoint = field("服务地址", "text", DEFAULT_MODEL_ENDPOINT, "服务地址（OpenAI 兼容端点）");
    var model = field("模型", "text", DEFAULT_MODEL_ID, "模型 id");
    var key = field("API Key", "password", "", "sk-…");
    step2.appendChild(endpoint.row);
    step2.appendChild(model.row);
    step2.appendChild(key.row);
    var saveKeyBtn = el("button", "oo-btn primary", "保存模型 Key");
    saveKeyBtn.type = "button";
    step2.appendChild(saveKeyBtn);
    step2.appendChild(el("p", "oo-hint", "Key 只保存在本机（渠道注册表），不会写进仓库文件。"));
    var msg2 = el("p", "oo-msg", "");
    msg2.setAttribute("data-msg", "modelKey");
    step2.appendChild(msg2);
    box.appendChild(step2);

    // ── step 3: sync ──
    var step3 = el("div", "oo-step");
    step3.setAttribute("data-step", "sync");
    var h3 = el("h3", "", "同步");
    h3.appendChild(el("span", "oo-tag", ""));
    step3.appendChild(h3);
    var checkWrap = el("label", "oo-check");
    var syncBox = document.createElement("input");
    syncBox.type = "checkbox";
    checkWrap.appendChild(syncBox);
    checkWrap.appendChild(el("span", "", "开启云同步（多设备）"));
    step3.appendChild(checkWrap);
    step3.appendChild(el("p", "oo-hint", "只在本机用可以不开启；开启后设置与会话会推到宿主，下次启动生效。"));
    box.appendChild(step3);

    // ── footer ──
    var foot = el("div", "oo-foot");
    var later = el("button", "oo-btn", "稍后");
    later.type = "button";
    var done = el("button", "oo-btn primary", "完成");
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
