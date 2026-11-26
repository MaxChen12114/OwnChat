// Browser wiring for services/ui/settings-deploy.ts: the settings card, the pack loader, the
// deploy/rollback ports, and the first-connect three-way notice.
//
// The card is mounted through settings.js's MOUNTS table (mountDeployCard wrapper) into the same
// account slot as the sync card. The first-connect notice runs at boot once the runtime manifest
// arrives, because "is this a new host" needs the DbPort adapter name.
//
// IO posture: fetching a pack, localStorage, backupSvc/syncSvc, feedback dialogs and the Tauri
// command port live here. The pack rules, the masking and the rollback order live in
// services/platform/deployer.ts; the copy lives in services/ui/settings-deploy.ts.
(function (g) {
  "use strict";
  if (g.settingsDeploy) return;

  // Same-product exports are bare identifiers: emit appends this wiring before the globalThis
  // bridge, so `window.DEPLOY_STORAGE_KEYS` would still be undefined here.
  var KEYS = DEPLOY_STORAGE_KEYS;
  var CATALOG = DEPLOY_PACK_CATALOG || [];
  var pack = null;
  var previewed = false;
  var running = false;
  var wiredManifest = false;

  function readLS(key) {
    try { return g.localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeLS(key, value) {
    try { g.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function writeLSStrict(key, value) {
    g.localStorage.setItem(key, value);
  }
  function removeLS(key) {
    try { g.localStorage.removeItem(key); } catch (e) { /* nothing to remove */ }
  }
  function el(id) { return document.getElementById(id); }
  function toast(message, type) {
    try {
      if (g.feedbackSvc && typeof g.feedbackSvc.toast === "function") {
        g.feedbackSvc.toast(message, { type: type || "info", ms: 3200 });
      }
    } catch (e) { /* a failed toast is not a failed deploy */ }
  }
  function confirmDialog(opts) {
    try {
      if (g.feedbackSvc && typeof g.feedbackSvc.confirm === "function") return g.feedbackSvc.confirm(opts);
    } catch (e) { /* fall through to the native dialog */ }
    return Promise.resolve(g.confirm(opts && opts.message ? String(opts.message) : "确认？"));
  }
  function alertDialog(message) {
    try {
      if (g.feedbackSvc && typeof g.feedbackSvc.alert === "function") return g.feedbackSvc.alert(message);
    } catch (e) { /* fall through */ }
    g.alert(String(message));
    return Promise.resolve();
  }
  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(message)); }, ms);
      promise.then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function currentManifest() {
    try {
      return g.runtimeManifest && typeof g.runtimeManifest.manifest === "function" ? g.runtimeManifest.manifest() : null;
    } catch (e) {
      return null;
    }
  }

  function backupApi() {
    var svc = g.backupSvc;
    if (!svc) return null;
    var names = ["exportAll", "exportBackup", "backupNow", "createBackup"];
    for (var i = 0; i < names.length; i++) {
      if (typeof svc[names[i]] === "function") {
        return function () { return svc[names[i]](); };
      }
    }
    return null;
  }

  function appendProgress(line) {
    var box = el("deployProgress");
    if (!box) return;
    box.style.display = "block";
    box.textContent += (box.textContent ? "\n" : "") + line;
    box.scrollTop = box.scrollHeight;
  }

  function eventLine(event) {
    var time = "";
    try { time = new Date(event.at || Date.now()).toLocaleTimeString("zh-CN", { hour12: false }); } catch (e) { time = ""; }
    var head = time ? time + " " : "";
    if (event.type === "run/start") return head + "开始" + (event.message ? "，" + event.message : "");
    if (event.type === "step/start") return head + "▶ " + (event.index != null ? (event.index + 1) + "/" + event.total + " " : "") + (event.title || event.stepId || "") + (event.message ? " — " + event.message : "");
    if (event.type === "step/end") return head + "✓ " + (event.title || event.stepId || "") + (event.message ? "（" + event.message + "）" : "");
    if (event.type === "step/skip") return head + "· 跳过 " + (event.title || event.stepId || "") + (event.message ? "（" + event.message + "）" : "");
    if (event.type === "step/error") return head + "✗ " + (event.title || event.stepId || "") + "：" + (event.message || "失败");
    if (event.type === "verify/fail") return head + "✗ verify 失败：" + (event.message || "");
    if (event.type === "journal/error") return head + "! 部署日志写入失败：" + (event.message || "");
    if (event.type === "rollback/start") return head + "开始回滚，" + (event.total || 0) + " 个已完成步骤";
    if (event.type === "rollback/skip") return head + "· 回滚跳过 " + (event.stepId || "") + "（" + (event.message || "") + "）";
    if (event.type === "rollback/end") return head + "回滚结束" + (event.message ? "：" + event.message : "");
    if (event.type === "run/end") return head + "结束" + (event.message ? "：" + event.message : "");
    return head + event.type + (event.message ? "：" + event.message : "");
  }

  // ── ports handed to the executor ─────────────────────────────────────────────

  function httpPort(call) {
    var transport = null;
    try {
      if (g.runtimeManifest && typeof g.runtimeManifest.get === "function") transport = g.runtimeManifest.get("transport");
    } catch (e) {
      transport = null;
    }
    var work;
    if (transport && typeof transport.send === "function") {
      // Verify goes through the capability kernel's transport when it is up (the seam the plan
      // asks for), and falls back to plain fetch when the manifest has not applied yet.
      work = transport.send({
        method: call.method,
        url: call.url,
        headers: call.headers,
        body: call.body == null ? undefined : call.body,
      }).then(function (res) {
        return res.text().then(function (body) { return { status: res.status, body: body }; });
      });
    } else {
      var controller = null;
      try { controller = new AbortController(); } catch (e) { controller = null; }
      var init = { method: call.method, headers: call.headers, cache: "no-store" };
      if (call.body != null) init.body = call.body;
      if (controller) init.signal = controller.signal;
      work = g.fetch(call.url, init).then(function (res) {
        return res.text().then(function (body) { return { status: res.status, body: body }; });
      });
      if (controller) setTimeout(function () { try { controller.abort(); } catch (e) { /* already done */ } }, call.timeoutMs);
    }
    return withTimeout(work, (call.timeoutMs || 30000) + 1000, "HTTP 请求超时");
  }

  function commandPort(call) {
    var shell = g.tauriSvc;
    if (!shell || typeof shell.invoke !== "function" || typeof shell.available !== "function" || !shell.available()) {
      return Promise.resolve({ code: -1, stderr: "命令步骤只在桌面端可用（Web 没有进程执行环境）" });
    }
    var envKeys = call.env ? Object.keys(call.env) : [];
    if (envKeys.length || (call.stdin || "")) {
      // The shell's local_run_command has no env/stdin yet. Fail loudly instead of running
      // wrangler without its token, which would produce a confusing upstream 401.
      return Promise.resolve({ code: -1, stderr: "桌面命令通道暂不支持 env/stdin（需要 T4-B 扩展 local_run_command）" });
    }
    return shell.invoke("local_run_command", {
      cmd: call.command,
      args: call.args && call.args.length ? Array.prototype.slice.call(call.args) : null,
      cwd: call.cwd || null,
      timeoutMs: call.timeoutMs || null,
    }).then(function (result) {
      var record = result && typeof result === "object" ? result : {};
      var ok = record.ok === true;
      var code = ok ? 0 : (typeof record.exitCode === "number" ? record.exitCode : 1);
      return { code: code, stdout: record.stdout || "", stderr: record.stderr || "" };
    }, function (error) {
      return { code: -1, stderr: String(error && error.message || error) };
    });
  }

  function handoffPort(call) {
    writeLS(KEYS.hostConfig, JSON.stringify({
      packId: call.packId,
      profile: call.profile,
      baseUrl: call.baseUrl,
      at: Date.now(),
    }));
    appendProgress("已记录宿主 profile：" + call.profile + (call.baseUrl ? " · " + call.baseUrl : ""));
  }

  function journalKey(packId) { return "cfw_deploy_journal_v1::" + packId; }

  function journalPort() {
    return {
      load: function (packId) {
        var raw = readLS(journalKey(packId));
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
      },
      save: function (state) {
        // Strict on purpose: a quota/private-mode failure must reach the executor so it can tell
        // the user resume is unavailable.
        writeLSStrict(journalKey(state.packId), JSON.stringify(state));
      },
      clear: function (packId) { removeLS(journalKey(packId)); },
    };
  }

  function buildPorts() {
    return {
      http: httpPort,
      command: commandPort,
      handoff: handoffPort,
      journal: journalPort(),
      now: function () { return Date.now(); },
      onEvent: function (event) { appendProgress(eventLine(event)); },
    };
  }

  // ── card ────────────────────────────────────────────────────────────────────

  function renderProfileLine() {
    var line = el("deployProfileLine");
    if (!line) return;
    var manifest = currentManifest();
    line.textContent = typeof capabilityLine === "function" ? capabilityLine(manifest) : "运行时 manifest 尚未加载";
    var allowed = typeof deployAllowed === "function" ? deployAllowed(manifest) : true;
    var note = el("deployGateNote");
    var buttons = [el("deployPreviewBtn"), el("deployRunBtn"), el("deployRollbackBtn")];
    for (var i = 0; i < buttons.length; i++) if (buttons[i]) buttons[i].disabled = !allowed || running;
    if (note) {
      note.style.display = allowed ? "none" : "block";
      note.textContent = allowed ? "" : "当前 profile 不提供部署向导：需要已登录账号、桌面本机或自托管宿主。";
    }
  }

  function packRef(id) {
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    return null;
  }

  function selectedPackId() {
    var sel = el("deployPackSel");
    return sel && sel.value ? String(sel.value) : (CATALOG.length ? CATALOG[0].id : "");
  }

  function renderPackSelect() {
    var sel = el("deployPackSel");
    if (!sel) return;
    sel.innerHTML = "";
    for (var i = 0; i < CATALOG.length; i++) {
      var option = document.createElement("option");
      option.value = CATALOG[i].id;
      option.textContent = CATALOG[i].label;
      sel.appendChild(option);
    }
    if (CATALOG.length) sel.value = CATALOG[0].id;
  }

  function collectValues() {
    var values = {};
    var nodes = document.querySelectorAll("[data-deploy-input]");
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute("data-deploy-input");
      if (id) values[id] = nodes[i].value == null ? "" : String(nodes[i].value);
    }
    return values;
  }

  function renderFields() {
    var host = el("deployFields");
    if (!host) return;
    host.innerHTML = "";
    if (!pack) return;
    for (var i = 0; i < pack.inputs.length; i++) {
      var spec = pack.inputs[i];
      var row = document.createElement("label");
      row.style.cssText = "display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);";
      var name = document.createElement("span");
      name.textContent = spec.label + (spec.required ? " *" : "");
      row.appendChild(name);
      var input = document.createElement("input");
      input.type = spec.kind === "secret" ? "password" : (spec.kind === "url" ? "url" : "text");
      input.setAttribute("data-deploy-input", spec.id);
      input.autocomplete = "off";
      input.spellcheck = false;
      if (spec.placeholder) input.placeholder = spec.placeholder;
      if (spec.default != null) input.value = String(spec.default);
      input.style.cssText = "padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;";
      row.appendChild(input);
      if (spec.hint) {
        var hint = document.createElement("span");
        hint.style.cssText = "font-size:11px;color:var(--muted);line-height:1.5;";
        hint.textContent = spec.hint;
        row.appendChild(hint);
      }
      host.appendChild(row);
    }
  }

  function resetPreview() {
    previewed = false;
    var runBtn = el("deployRunBtn");
    if (runBtn) runBtn.textContent = "开始部署";
  }

  function showErrors(errors) {
    var list = Array.isArray(errors) ? errors : [];
    var lines = [];
    for (var i = 0; i < list.length; i++) {
      var message = list[i] && list[i].message ? String(list[i].message) : String(list[i]);
      lines.push("✗ " + message);
    }
    var status = el("deployStatus");
    if (status) status.textContent = lines.join("\n") || "部署包或输入不合法";
  }

  function loadPack(id) {
    var ref = packRef(id);
    var status = el("deployStatus");
    if (!ref) return Promise.resolve(null);
    if (!g.deployerSvc) {
      if (status) status.textContent = "部署执行器未加载（deployer.js）";
      return Promise.resolve(null);
    }
    return g.fetch(ref.file, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    }).then(function (text) {
      var json = JSON.parse(text);
      var validation = g.deployerSvc.validatePack(json);
      if (!validation.ok) {
        showErrors(validation.errors);
        return null;
      }
      pack = validation.pack;
      renderFields();
      resetPreview();
      var desc = el("deployPackDesc");
      if (desc) desc.textContent = pack.description || "";
      if (status) status.textContent = "";
      return pack;
    }).catch(function (error) {
      pack = null;
      renderFields();
      if (status) {
        status.textContent = "部署包未发布或不可读：" + ref.file + "（" + String(error && error.message || error) + "）。\n"
          + "运行 node deploy/publish.mjs 生成 public/deploy/ 镜像后刷新页面。";
      }
      return null;
    });
  }

  function preview() {
    if (!pack || !g.deployerSvc) return false;
    var result = g.deployerSvc.plan(pack, collectValues());
    if (!result.ok) {
      showErrors(result.errors);
      previewed = false;
      return false;
    }
    var box = el("deployPreview");
    if (box) {
      box.style.display = "block";
      box.textContent = typeof formatPlan === "function" ? formatPlan(result.entries) : "";
    }
    previewed = true;
    var runBtn = el("deployRunBtn");
    if (runBtn) runBtn.textContent = "确认并开始部署";
    var status = el("deployStatus");
    if (status) status.textContent = "预览完成：确认后才会执行（secret 值显示为 ***）。";
    return true;
  }

  function saveRunState(result) {
    if (!result || !result.state || !result.state.completed || !result.state.completed.length) return;
    writeLS(KEYS.runState, JSON.stringify(result.state));
    writeLS(KEYS.lastRun, JSON.stringify({
      packId: result.packId,
      at: Date.now(),
      profile: pack ? pack.resultProfile : "",
      baseUrl: result.state.baseUrl || "",
      ok: !!result.ok,
      stopReason: result.stopReason,
    }));
  }

  function runDeploy() {
    if (running) return;
    if (!pack) return;
    if (!previewed) {
      preview();
      return;
    }
    confirmDialog({
      title: "部署到 " + pack.name,
      message: "将按预览顺序执行 " + pack.steps.length + " 个步骤，失败即停。\n"
        + "verify 失败不会继续；成功后可回滚（标记为不可回滚的步骤会跳过）。\n\n确认开始？",
      okText: "开始部署",
      danger: true,
    }).then(function (ok) {
      if (!ok) return;
      running = true;
      renderProfileLine();
      var progress = el("deployProgress");
      if (progress) { progress.textContent = ""; progress.style.display = "block"; }
      var status = el("deployStatus");
      if (status) status.textContent = "执行中…";
      return g.deployerSvc.run(pack, collectValues(), buildPorts(), {}).then(function (result) {
        saveRunState(result);
        if (status) status.textContent = typeof deployOutcomeText === "function" ? deployOutcomeText(result) : JSON.stringify(result);
        if (result.ok) toast("部署完成", "ok");
        else toast(result.stopReason === "verify_failed" ? "verify 失败，已停止" : "部署失败", "err");
      }).catch(function (error) {
        if (status) status.textContent = "部署异常：" + String(error && error.message || error);
      }).then(function () {
        running = false;
        resetPreview();
        renderProfileLine();
      });
    });
  }

  function rollbackDeploy() {
    if (running) return;
    var raw = readLS(KEYS.runState);
    if (!raw) {
      var status = el("deployStatus");
      if (status) status.textContent = "没有可回滚的部署记录。";
      return;
    }
    var state;
    try { state = JSON.parse(raw); } catch (e) { state = null; }
    if (!state || !state.packId) return;
    var ref = packRef(state.packId);
    if (!ref) {
      var s = el("deployStatus");
      if (s) s.textContent = "回滚状态里的部署包不在目录中：" + state.packId;
      return;
    }
    confirmDialog({
      title: "回滚 " + ref.label,
      message: "将按已完成步骤的倒序执行 inverse；标记为不可回滚的步骤会跳过并如实列出。\n\n"
        + "需要重新填写 secret（访问码 / API Token），它们不会从本机存储里读取。确认回滚？",
      okText: "回滚",
      danger: true,
    }).then(function (ok) {
      if (!ok) return;
      running = true;
      renderProfileLine();
      var progress = el("deployProgress");
      if (progress) { progress.textContent = ""; progress.style.display = "block"; }
      var status = el("deployStatus");
      if (status) status.textContent = "回滚中…";
      var ready = pack && pack.id === state.packId ? Promise.resolve(pack) : loadPack(state.packId);
      return ready.then(function () {
        if (!pack) return null;
        return g.deployerSvc.rollback(pack, state, collectValues(), buildPorts(), {}).then(function (result) {
          if (status) {
            status.textContent = result.ok
              ? "回滚完成（" + result.ran.length + " 步；跳过 " + result.skipped.length + " 步）。"
              : "回滚失败：" + (result.errors.length ? result.errors[0].message : "未知原因");
          }
          if (result.ok) {
            removeLS(KEYS.runState);
            removeLS(KEYS.lastRun);
            toast("回滚完成", "ok");
          } else {
            toast("回滚失败", "err");
          }
        });
      }).catch(function (error) {
        if (status) status.textContent = "回滚异常：" + String(error && error.message || error);
      }).then(function () {
        running = false;
        renderProfileLine();
      });
    });
  }

  // ── first connect ──────────────────────────────────────────────────────────

  function firstConnectPlan() {
    var current = readLS(KEYS.pending) || "";
    var previous = readLS(KEYS.host) || "";
    if (!current || current === previous) return null;
    if (typeof window.planFirstConnect !== "function") return null;
    return window.planFirstConnect(current, previous, !!backupApi());
  }

  function renderFirstConnect() {
    var box = el("deployFirstConnect");
    if (!box) return;
    var plan = firstConnectPlan();
    if (!plan || !plan.isNewHost) {
      box.style.display = "none";
      return;
    }
    var view = typeof firstConnectView === "function"
      ? firstConnectView(plan)
      : { show: true, title: "检测到新宿主", warning: "", options: [] };
    box.style.display = "block";
    box.style.border = "1px solid var(--danger-border, rgba(232,96,125,.45))";
    box.style.background = "var(--danger-soft, rgba(232,96,125,.10))";
    box.style.borderRadius = "10px";
    box.style.padding = "10px";
    box.style.margin = "8px 0";
    var title = el("deployFirstConnectTitle");
    if (title) title.textContent = view.title;
    var warning = el("deployFirstConnectWarning");
    if (warning) {
      warning.textContent = view.warning || "";
      warning.style.display = view.warning ? "block" : "none";
    }
    var host = el("deployFirstConnectBtns");
    if (!host) return;
    host.innerHTML = "";
    for (var i = 0; i < view.options.length; i++) {
      (function (option) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "smallbtn" + (option.destructive ? " danger" : "");
        button.textContent = option.title;
        button.title = option.detail;
        button.setAttribute("data-deploy-choice", option.id);
        host.appendChild(button);
      })(view.options[i]);
    }
  }

  function applyFirstConnect(choice) {
    var pending = readLS(KEYS.pending);
    if (!pending) return;
    var backup = backupApi();
    var backupStep;
    if (backup) {
      backupStep = confirmDialog({
        title: "先自动备份",
        message: "选择「" + (typeof firstConnectChoiceLabel === "function" ? firstConnectChoiceLabel(choice) : choice) + "」前先调用 window.backupSvc 备份一次。\n继续？",
        okText: "备份并继续",
      }).then(function (ok) {
        if (!ok) return false;
        return Promise.resolve().then(backup).then(function () {
          appendProgress("自动备份完成");
          return true;
        }, function (error) {
          return alertDialog("备份失败，已取消本次选择：" + String(error && error.message || error)).then(function () { return false; });
        });
      });
    } else {
      backupStep = confirmDialog({
        title: "备份模块未就绪",
        message: "window.backupSvc 不存在或没有导出备份函数（T3-E 可能还没入库）。\n"
          + "继续将不会自动备份；建议先到「设置 → 云同步」导出备份。仍要继续吗？",
        okText: "不备份，继续",
        danger: true,
      });
    }
    backupStep.then(function (go) {
      if (!go) return;
      // Record the decision before any sync action, because pullOnStartup may reload the page.
      writeLS(KEYS.host, pending);
      writeLS(KEYS.choice, JSON.stringify({ host: pending, choice: choice, at: Date.now() }));
      removeLS(KEYS.pending);
      renderFirstConnect();
      var sync = g.syncSvc;
      var done = function (text) {
        toast(text, "ok");
        var status = el("deployStatus");
        if (status) status.textContent = text;
      };
      if (choice === "local") {
        var syncStatus = null;
        try { syncStatus = sync && typeof sync.getStatus === "function" ? sync.getStatus() : null; } catch (e) { syncStatus = null; }
        if (sync && typeof sync.pushNow === "function" && syncStatus && syncStatus.hasToken) {
          Promise.resolve().then(function () { return sync.pushNow(); }).then(function () {
            done("已按本机为准：本机设置将覆盖云端热窗口。");
          }, function (error) {
            done("已记录本机为准，但上传失败：" + String(error && error.message || error));
          });
        } else {
          done("已按本机为准（云同步未启用：只记录选择，未上传）。");
        }
        return;
      }
      if (sync && typeof sync.pullOnStartup === "function") {
        Promise.resolve().then(function () { return sync.pullOnStartup(); }).then(function () {
          done(choice === "merge" ? "已按合并处理：从宿主拉取并合并热窗口。" : "已按宿主为准：正在从宿主拉取。");
        }, function (error) {
          done("已记录选择，但从宿主拉取失败：" + String(error && error.message || error));
        });
      } else {
        done("已记录选择（云同步模块未就绪：没有执行拉取）。");
      }
    });
  }

  function subscribeManifest() {
    if (wiredManifest || !g.runtimeManifest || typeof g.runtimeManifest.onChange !== "function") return;
    wiredManifest = true;
    g.runtimeManifest.onChange(function () {
      renderProfileLine();
      renderFirstConnect();
    });
  }

  function checkFirstConnect() {
    renderProfileLine();
    subscribeManifest();
    var wm = g.runtimeManifest;
    if (!wm || typeof wm.hostKey !== "function") return;
    var current = "";
    try { current = wm.hostKey(); } catch (e) { current = ""; }
    if (!current) return;
    var previous = readLS(KEYS.host) || "";
    if (!previous) {
      // First ever connection: nothing to choose, record the host so the next one is comparable.
      writeLS(KEYS.host, current);
      renderFirstConnect();
      return;
    }
    var plan = typeof window.planFirstConnect === "function" ? window.planFirstConnect(current, previous, !!backupApi()) : null;
    if (plan && plan.isNewHost) {
      writeLS(KEYS.pending, current);
      toast("检测到新宿主：到 设置 → 部署 选择以本机为准 / 宿主为准 / 合并", "warn");
    }
    renderFirstConnect();
  }

  // ── mount ──────────────────────────────────────────────────────────────────

  function mountCard() {
    var existing = el("deployCard");
    if (existing) {
      renderProfileLine();
      renderFirstConnect();
      return;
    }
    var slot = null;
    try { slot = g.slotRegistry && g.slotRegistry.pick ? g.slotRegistry.pick("setAccountSlot") : null; } catch (e) { slot = null; }
    if (!slot || el("deployCard")) return;
    try { g.slotRegistry.claim({ cardId: "deployCard", slotId: "setAccountSlot" }); } catch (e) { /* claim is bookkeeping */ }

    var card = document.createElement("div");
    card.className = "card";
    card.id = "deployCard";
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>部署</h4>'
      + '<p>把 OwnChat 部署到你自己的 Cloudflare Worker 或 VPS（Docker + Caddy TLS），完成后回填宿主 profile。</p>'
      + '<div id="deployProfileLine" style="font-size:11px;color:var(--muted);margin:6px 0;"></div>'
      + '<div id="deployFirstConnect" style="display:none;"><div id="deployFirstConnectTitle" style="font-size:13px;font-weight:700;"></div><div id="deployFirstConnectWarning" style="font-size:11px;color:var(--muted);line-height:1.6;margin:4px 0;"></div><div class="btns" id="deployFirstConnectBtns" style="flex-wrap:wrap;"></div></div>'
      + '<div class="rowline" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;"><label for="deployPackSel" style="font-size:12px;color:var(--muted);">目标宿主</label><select id="deployPackSel" style="flex:1;max-width:220px;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;"></select></div>'
      + '<div id="deployPackDesc" style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:6px;"></div>'
      + '<div id="deployFields" style="display:flex;flex-direction:column;gap:8px;margin-top:8px;"></div>'
      + '<div class="btns" style="margin-top:10px;flex-wrap:wrap;"><button class="smallbtn" id="deployPreviewBtn" type="button">预览命令</button><button class="smallbtn" id="deployRunBtn" type="button">开始部署</button><button class="smallbtn danger" id="deployRollbackBtn" type="button">回滚上次部署</button></div>'
      + '<div id="deployGateNote" style="display:none;font-size:11px;color:var(--muted);margin-top:6px;"></div>'
      + '<pre id="deployPreview" style="display:none;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.6;background:rgba(127,127,127,.08);border-radius:8px;padding:8px;margin-top:8px;max-height:260px;overflow:auto;"></pre>'
      + '<pre id="deployProgress" style="display:none;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.6;background:rgba(127,127,127,.08);border-radius:8px;padding:8px;margin-top:8px;max-height:220px;overflow:auto;"></pre>'
      + '<div id="deployStatus" style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:8px;"></div>';
    slot.appendChild(card);

    renderPackSelect();
    renderProfileLine();
    renderFirstConnect();

    var select = el("deployPackSel");
    if (select) select.addEventListener("change", function () {
      pack = null;
      resetPreview();
      loadPack(selectedPackId());
    });
    var fields = el("deployFields");
    if (fields) fields.addEventListener("input", function () { resetPreview(); });
    var previewBtn = el("deployPreviewBtn");
    if (previewBtn) previewBtn.addEventListener("click", function () { preview(); });
    var runBtn = el("deployRunBtn");
    if (runBtn) runBtn.addEventListener("click", function () { runDeploy(); });
    var rollbackBtn = el("deployRollbackBtn");
    if (rollbackBtn) rollbackBtn.addEventListener("click", function () { rollbackDeploy(); });
    var firstBtns = el("deployFirstConnectBtns");
    if (firstBtns) firstBtns.addEventListener("click", function (event) {
      var target = event.target && event.target.closest ? event.target.closest("[data-deploy-choice]") : null;
      if (!target) return;
      applyFirstConnect(target.getAttribute("data-deploy-choice"));
    });

    subscribeManifest();
    loadPack(selectedPackId());
  }

  // Boot: wait (bounded) for the runtime manifest, then decide whether this is a new host.
  (function waitForManifest() {
    var tries = 0;
    function step() {
      if (g.runtimeManifest && typeof g.runtimeManifest.manifest === "function" && g.runtimeManifest.manifest()) {
        checkFirstConnect();
        return;
      }
      if (g.runtimeManifest && typeof g.runtimeManifest.onChange === "function" && !g.runtimeManifest.manifest()) {
        var fired = false;
        var off = g.runtimeManifest.onChange(function () {
          if (fired) return;
          fired = true;
          try { off(); } catch (e) { /* one-shot */ }
          checkFirstConnect();
        });
        // Close the race: the manifest may have arrived between the check above and the
        // subscription. Re-check once and consume the subscription if it already did.
        if (g.runtimeManifest.manifest() && !fired) {
          fired = true;
          try { off(); } catch (e) { /* one-shot */ }
          checkFirstConnect();
        }
        return;
      }
      tries++;
      if (tries < 40) setTimeout(step, 250);
    }
    if (typeof document === "undefined") return;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", step);
    else step();
  })();

  g.settingsDeploy = {
    keys: KEYS,
    catalog: CATALOG,
    mountCard: mountCard,
    checkFirstConnect: checkFirstConnect,
    preview: preview,
    applyFirstConnect: applyFirstConnect,
  };
})(window);
