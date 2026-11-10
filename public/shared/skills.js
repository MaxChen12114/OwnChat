// public/shared/skills.js
// Skill 系统 v2 — 三级渐进披露（level 1 目录常驻 / level 2 正文按需 / level 3 references 暂缺）
// ─────────────────────────────────────────────────────────────
// 2026-10-06 重做。旧版把「启用技能的正文」并进 extraSystemPrompts —— 与「指令模块（预设）」成了同一件事：
// 每轮都往系统提示里塞全文，长技能每轮都在烧 token，且与预置功能重复（用户反馈"感觉重复了"）。
// 成熟做法（读过 deepseek-harness 的 skill / tool-skill 包、ZCode 的 Skill 工具、Anthropic Agent Skills 文档）：
//   ① **只有目录常驻**：每条一行 `- \`name\`: description`（描述截断 + 目录总长上限），并明确告诉模型
//      "这是摘要，按技能行事前必须先 load"；
//   ② 正文由 `load_skill` 工具按需取（**按 name 寻址**，不是 id），取回后作为一条工具结果进会话，
//      在 agent 步骤面板里自然显示成"加载技能"那一步；
//   ③ references（level 3）**当前不注入**，只计数展示 —— 浏览器壳没有宿主文件系统，要落到会话工作区才谈得上
//      "按需读附件"，留 P1（等 agent 工作区成熟）。旧版卡片上的"未注入"徽章保留，语义不变。
// 作用域：**只有 agent 模式挂载**（目录拼在 app.js 的 agent 装配点，与工具纲领同处）；普通对话不再吃技能正文
// （chat 装配点那一项已删）。这与三家的做法一致：技能是 agent 的能力，不是聊天的人格。
// 存储与云同步不变（cfw_skills_v1 / cfw_skills_enabled_v1）；`enabled` 语义从"每轮注入"改为"列入目录"。
// 安全：社区 skill 视为不可信（可能含 prompt-injection）。导入默认 enabled=false，需用户手动列入。
//
// 暴露：window.__skills = { buildCatalogPrompt, getByName, list, getAll, save, remove, setEnabled,
//                          setGlobalEnabled, isGlobalEnabled, importFromText, importFromUrl, parseSkillMd }
// 位置：本文件属 public/shared/（全局能力层 SDK，与「壳」解耦），随 /shared/ 组在 app.js 之后加载（buildCatalogPrompt 在 send 时才被调用）。
// 跨侧：mountCard 仅在存在 #setSkillSlot（文本侧设置·「技能」分类）时挂卡；其他壳/页面自动跳过、只暴露 window.__skills（仿 shared/tts.js 在网页端的静默降级）。
(() => {
  const LS_SKILLS = "cfw_skills_v1";            // 仿 cfw_prompt_presets_v1（数组）
  const LS_SKILLS_ON = "cfw_skills_enabled_v1"; // 总开关（默认开；仅 "0" 视为关）
  // 正文长度告警线：agent-kernel 把工具结果裁到 8000 字（头 6000 + 尾 1500），
  // 所以正文一旦超过 6000，加载时尾部就会被裁掉 —— 导入与列表都据此提示（DSH 同款纪律是 8192）。
  const SKILL_BODY_WARN = 6000;
  function sizeHint(skill) {
    const n = String((skill && skill.content) || "").length;
    return "（正文 " + n + " 字" + (n > SKILL_BODY_WARN ? "，超过 " + SKILL_BODY_WARN + "：加载时会被工具结果裁剪，建议精简" : "") + "）";
  }

  // ─── 存储读写 ───
  function getAll() {
    try {
      const raw = localStorage.getItem(LS_SKILLS);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function saveAll(arr) {
    try { localStorage.setItem(LS_SKILLS, JSON.stringify(Array.isArray(arr) ? arr : [])); } catch {}
  }
  function isGlobalEnabled() { return (localStorage.getItem(LS_SKILLS_ON) ?? "1") !== "0"; }
  function setGlobalEnabled(on) { try { localStorage.setItem(LS_SKILLS_ON, on ? "1" : "0"); } catch {} renderList(); }
  function uid() { return "sk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ─── level 1：目录（唯一常驻系统提示的东西，且只在 agent 模式）───
  // 描述截断与总长上限都是刻意的：目录一旦被顶掉，技能就等于全部不可达（ZCode 的 diagnosing-skills
  // 记过这一条：清单被挤掉 = 技能全部不可达）。超预算时往后退化成"只列名字"，再超就明说省略了几条。
  const DESC_MAX = 500;      // 单条描述上限（对齐 DSH 的 500 字符）
  const CATALOG_MAX = 4000;  // 目录总长上限（字符）
  function buildCatalogPrompt(onlyNames) {
    try {
      if (!isGlobalEnabled()) return "";
      // 2026-10-08 角色能力档：可传"只列这些技能名"（该角色配了 skillIds 时）——
      // 不传 = 现状（全部 enabled 的技能）。技能按 name 寻址（load_skill 同口径）。
      const allow = (Array.isArray(onlyNames) && onlyNames.length) ? new Set(onlyNames.map((n) => String(n).trim()).filter(Boolean)) : null;
      const arr = getAll()
        .filter(s => s && s.enabled && String(s.name || "").trim())
        .filter(s => !allow || allow.has(String(s.name).trim()))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (!arr.length) return "";
      const lines = [];
      let used = 0, dropped = 0;
      for (const s of arr) {
        const name = String(s.name || "").trim();
        let desc = String(s.description || "").replace(/\s+/g, " ").trim();
        if (!desc) desc = "（未写 description —— 不确定是否匹配时先 load_skill 看正文）";
        if (desc.length > DESC_MAX) desc = desc.slice(0, DESC_MAX) + "…";
        let line = "- `" + name + "`: " + desc;
        if (used + line.length > CATALOG_MAX) {
          const bare = "- `" + name + "`";
          if (used + bare.length > CATALOG_MAX) { dropped = arr.length - lines.length; break; }
          line = bare;
        }
        used += line.length;
        lines.push(line);
      }
      if (dropped > 0) lines.push("- （目录过长，其余 " + dropped + " 条未列出：可按名直接试 load_skill）");
      return "\n\n【可用技能目录】每个技能都是「摘要 + 正文」两段式：想用某个技能，先按名调 `load_skill` 取全文再行动，"
        + "不要凭这里的摘要臆测内容。\n" + lines.join("\n");
    } catch { return ""; }
  }

  // 按 name 取一条（load_skill 工具用；先精确、再大小写不敏感）
  function getByName(name) {
    const want = String(name == null ? "" : name).trim();
    if (!want) return null;
    const arr = getAll();
    const nm = (s) => String((s && s.name) || "").trim();
    return arr.find(s => nm(s) === want) || arr.find(s => nm(s).toLowerCase() === want.toLowerCase()) || null;
  }

  // ─── YAML frontmatter 解析（轻量，不引外部库）───
  // 支持标准 SKILL.md：--- frontmatter --- + body。frontmatter 取 name / description / references。
  // references 支持「行内逗号串」或「下方 - 列表」。无 frontmatter 时取首个 # 标题作 name，全文为正文。
  function stripQuotes(s) {
    s = String(s == null ? "" : s).trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    return s;
  }
  function parseSkillMd(text) {
    const src = String(text == null ? "" : text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let name = "", description = "", references = [], body = src.trim();
    const fm = src.match(/^\uFEFF?---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (fm) {
      const meta = fm[1];
      body = (fm[2] || "").trim();
      let curKey = null;
      for (const ln of meta.split("\n")) {
        const listM = ln.match(/^\s*-\s+(.*)$/);
        if (listM && curKey === "references") { const v = stripQuotes(listM[1].trim()); if (v) references.push(v); continue; }
        const kv = ln.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!kv) continue;
        const key = kv[1].toLowerCase();
        const val = kv[2].trim();
        curKey = key;
        if (key === "name") name = stripQuotes(val);
        else if (key === "description") description = stripQuotes(val);
        else if (key === "references" || key === "resources") {
          if (val) references = val.split(",").map(x => stripQuotes(x.trim())).filter(Boolean);
        }
      }
    }
    if (!name) { const h = body.match(/^#\s+(.+)$/m); if (h) name = h[1].trim(); }
    if (!name) name = "未命名技能";
    return { name, description, references, content: body };
  }

  // ─── 导入 / CRUD ───
  // 安全默认 enabled=false：社区 skill 不可信，导入后需用户手动开启（先阅读正文）。
  function importFromText(text, source) {
    const parsed = parseSkillMd(text);
    if (!parsed.content && !parsed.name) throw new Error("解析为空：不是有效的 SKILL.md");
    const arr = getAll();
    const order = arr.reduce((m, s) => Math.max(m, s.order ?? 0), 0) + 1;
    const skill = {
      id: uid(),
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      references: parsed.references || [],
      enabled: false,
      order,
      source: source || "import",
      createdAt: Date.now(),
    };
    arr.push(skill);
    saveAll(arr);
    return skill;
  }
  async function importFromUrl(url) {
    const u = String(url || "").trim();
    if (!u) throw new Error("请填链接");
    if (!/^https?:\/\//i.test(u)) throw new Error("链接需以 http(s):// 开头");
    const r = await fetch(u);
    if (!r.ok) throw new Error("拉取失败: " + r.status);
    const text = await r.text();
    return importFromText(text, u);
  }
  function save(skill) {
    if (!skill || !skill.id) return;
    const arr = getAll();
    const i = arr.findIndex(s => s && s.id === skill.id);
    if (i >= 0) arr[i] = Object.assign({}, arr[i], skill);
    else arr.push(skill);
    saveAll(arr);
  }
  function remove(id) { saveAll(getAll().filter(s => s && s.id !== id)); }
  function setEnabled(id, on) {
    const arr = getAll();
    const s = arr.find(x => x && x.id === id);
    if (s) { s.enabled = !!on; saveAll(arr); }
  }
  function list() { return getAll(); }

  // ─── 技能库：从 POST /api/presets 拉（2026-10-06 改）───
  // 旧版读 public/presets/starter-skills.json —— 静态资产、人人可 GET，且锁定访客也能拿到库文本。
  // 技能按**名字**去重（库里的 id 是 lib-*，导入后用户手里的 id 是 sk_*，id 对不上，所以名字才是键）。
  async function importStarterLibrary() {
    // 公开版：库文本要登录后取（auth.js 会自动带 Authorization 头）
    const tok = (window.__auth && window.__auth.getToken) ? window.__auth.getToken() : "";
    if (!tok) throw new Error("需先登录（技能库与指令模块库同走访问校验）");
    const r = await fetch("/api/presets", {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) throw new Error("拉取技能库失败: " + r.status);
    const data = await r.json();
    const skills = (data && Array.isArray(data.skills)) ? data.skills : [];
    if (!skills.length) throw new Error("技能库为空");
    const existing = new Set(getAll().map(s => (s.name || "").trim()));
    let added = 0;
    for (const item of skills) {
      const content = (item && typeof item.content === "string") ? item.content : (typeof item === "string" ? item : "");
      if (!content.trim()) continue;
      const nm = String((item && item.name) || "").trim();
      if (!nm || existing.has(nm)) continue; // 同名去重
      const arr = getAll();
      const order = arr.reduce((m, s) => Math.max(m, s.order || 0), 0) + 1;
      arr.push({ id: uid(), name: nm, description: (item && item.description) || "", content: content.trim(),
        references: [], enabled: false, order,
        source: (item && item.source) || "library", license: (item && item.license) || "", createdAt: Date.now() });
      saveAll(arr);
      existing.add(nm);
      added++;
    }
    return added;
  }

  // ─── 设置卡（仿 settings.js mount*Card 模式，挂 #setSkillSlot · 独立「技能」分类）───
  var esc = window.__ownEscape.esc;

  function wireCard(card) {
    const status = card.querySelector("#skillImportStatus");
    function setMsg(t) { if (status) status.textContent = t || ""; }

    const gt = card.querySelector("#skillGlobalToggle");
    if (gt) { gt.checked = isGlobalEnabled(); gt.addEventListener("change", function () { setGlobalEnabled(gt.checked); }); }

    const listEl = card.querySelector("#skillList");
    if (listEl) {
      listEl.addEventListener("change", function (e) { const t = e.target.closest('input[data-act="toggle"]'); if (!t) return; setEnabled(t.getAttribute("data-id"), t.checked); });
      listEl.addEventListener("click", async function (e) { const b = e.target.closest('button[data-act="del"]'); if (!b) return; const ok = (window.__feedback && window.__feedback.confirm) ? await window.__feedback.confirm({ title: "删除技能", message: "删除这条技能？", okText: "删除", danger: true }) : confirm("删除这条技能？"); if (!ok) return; remove(b.getAttribute("data-id")); renderList(); });
    }

    const pasteBtn = card.querySelector("#skillPasteBtn"), pasteText = card.querySelector("#skillPasteText");
    if (pasteBtn && pasteText) pasteBtn.addEventListener("click", function () {
      try { const s = importFromText(pasteText.value, "paste"); pasteText.value = ""; renderList(); setMsg("已导入「" + s.name + "」" + sizeHint(s) + "（默认未列入目录，请在上方勾选）"); }
      catch (e) { setMsg("导入失败：" + (e && e.message || e)); }
    });

    const fileBtn = card.querySelector("#skillFileBtn"), fileInput = card.querySelector("#skillFileInput");
    if (fileBtn && fileInput) {
      fileBtn.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function (e) {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        const reader = new FileReader();
        reader.onload = function () { try { const s = importFromText(String(reader.result), f.name); renderList(); setMsg("已从文件导入「" + s.name + "」" + sizeHint(s)); } catch (err) { setMsg("导入失败：" + (err && err.message || err)); } };
        reader.onerror = function () { setMsg("读取文件失败"); };
        reader.readAsText(f); fileInput.value = "";
      });
    }

    const urlBtn = card.querySelector("#skillUrlBtn"), urlInput = card.querySelector("#skillUrlInput");
    if (urlBtn && urlInput) urlBtn.addEventListener("click", async function () {
      urlBtn.disabled = true; setMsg("拉取中…");
      try { const s = await importFromUrl(urlInput.value); urlInput.value = ""; renderList(); setMsg("已从链接导入「" + s.name + "」" + sizeHint(s) + "（外部内容：建议先读一遍再列入目录）"); }
      catch (e) { setMsg("拉取失败：" + (e && e.message || e)); }
      urlBtn.disabled = false;
    });

    const sampleBtn = card.querySelector("#skillSampleBtn");
    if (sampleBtn) sampleBtn.addEventListener("click", async function () {
      sampleBtn.disabled = true; setMsg("拉取起始技能库…");
      try { const n = await importStarterLibrary(); renderList(); setMsg(n ? ("已导入起始技能库 " + n + " 条（默认未列入目录，逐条阅读后再勾）。") : "起始技能库已全部导入过，无新增。"); }
      catch (e) { setMsg("导入失败：" + (e && e.message || e)); }
      sampleBtn.disabled = false;
    });
  }

  function mountCard() {
    const slot = document.getElementById("setSkillSlot");
    if (!slot || document.getElementById("skillSystemCard")) return;
    const IN = 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
    const card = document.createElement("div");
    card.className = "card";
    card.id = "skillSystemCard";
    card.innerHTML =
      '<h4>Skill 系统（技能）</h4>'
      + '<p>导入 <b>SKILL.md</b>（纯 Markdown + YAML frontmatter）。技能走<b>三级渐进披露</b>：只有「名称 + 描述」这一行目录挂在 <b>agent 模式</b>的系统提示里，正文由 agent 需要时自己调 <code>load_skill</code> 取 —— 这是 Anthropic Agent Skills / DeepSeek Harness / ZCode 的通行做法（摘要常驻、正文按需）。<b>普通对话不挂技能。</b>随云同步、跨设备可用。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="skillGlobalToggle"><label for="skillGlobalToggle">启用技能目录（总开关）</label></div></div>'
      + '<div id="skillList" style="display:flex;flex-direction:column;gap:6px;margin-top:8px;"></div>'
      + '<div style="margin-top:14px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">导入技能</div>'
      + '<textarea id="skillPasteText" rows="4" placeholder="粘贴 SKILL.md 内容…" style="' + IN + 'resize:vertical;"></textarea>'
      + '<div class="rowline" style="margin-top:8px;"><div></div><div class="btns">'
      + '<button class="smallbtn" id="skillPasteBtn">从文本导入</button>'
      + '<button class="smallbtn" id="skillFileBtn">从文件导入</button>'
      + '<input type="file" id="skillFileInput" accept=".md,.markdown,.txt" style="display:none">'
      + '<button class="smallbtn" id="skillSampleBtn">导入起始技能库</button>'
      + '</div></div>'
      + '<div class="rowline" style="margin-top:6px;align-items:center;gap:8px;"><input type="text" id="skillUrlInput" placeholder="GitHub raw 链接（raw.githubusercontent.com/…/SKILL.md）" style="flex:1;' + IN + '"><button class="smallbtn" id="skillUrlBtn">拉取</button></div>'
      + '<div id="skillImportStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div></div>'
      + '<div class="settings-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg><span>第三方 / 社区技能可能含提示词注入，<b>导入后默认不进目录</b>；请先阅读正文再手动列入。正文超过 6000 字会在加载时被工具结果裁剪；含 reference 的技能当前不加载附件（P1：等 agent 工作区成熟再做按需读）。</span></div>';
    slot.appendChild(card);
    wireCard(card);
    renderList();
  }

  // ─── 暴露 + 初始化 ───
  window.__skills = {
    buildCatalogPrompt, getByName, list, getAll, save, remove, setEnabled,
    setGlobalEnabled, isGlobalEnabled, importFromText, importFromUrl, parseSkillMd,
  };

  function init() { mountCard(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();