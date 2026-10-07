// 路径: public/coding/app.js
/* 代码台 · 浏览器内轻量 IDE (app.js)
   纯浏览器内:项目 + 文件树存 IndexedDB,在线编辑,AI 生成/改写文件,一键导出 zip。
   不接本地文件系统(浏览器沙箱所限),后续可加 File System Access API。
   依赖:/config.js(模型列表)、/api/chat(AI 流式,同 studio/canvas 契约)、费用窗口已由 status-panel 取代(旧 cost-widget.js 已删)。
   零第三方依赖:zip 为自实现 STORE 方法(含 CRC32)。 */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };

  // ───── IndexedDB ─────
  var DB_NAME = "cfw_coding_ide_v1", STORE = "projects", DB_VER = 1, db = null;
  function openDB() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function ostore(mode) { return db.transaction(STORE, mode).objectStore(STORE); }
  function dbGetAll() { return new Promise(function (res, rej) { var r = ostore("readonly").getAll(); r.onsuccess = function () { res(r.result || []); }; r.onerror = function () { rej(r.error); }; }); }
  function dbPut(p) { return new Promise(function (res, rej) { var r = ostore("readwrite").put(p); r.onsuccess = function () { res(); }; r.onerror = function () { rej(r.error); }; }); }
  function dbDel(id) { return new Promise(function (res, rej) { var r = ostore("readwrite").delete(id); r.onsuccess = function () { res(); }; r.onerror = function () { rej(r.error); }; }); }

  // ───── 状态 ─────
  var projects = [];   // [{id,name,files:{path:content},folders:[path],createdAt,updatedAt,openPath}]
  var cur = null;      // 当前项目
  var openPath = null; // 当前打开文件
  var openTabs = []; // 当前打开的标签(文件路径数组)
  var collapsed = {};  // 文件夹折叠状态 path->true
  var saveTimer = null;
  var LS_LAST = "cfw_coding_ide_last_v1";
  var LS_MODEL = "cfw_coding_ide_model_v1";
  function unlimitedOn() { return false; }
  
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;"); }
  function normPath(p) { return String(p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "").trim(); }

  // ───── 语法高亮(零依赖,手写扫描器:注释/字符串/数字/关键字) ─────
  var KEYWORDS = {};
  ("const let var function return if else for while do switch case break continue new class extends super this " +
   "typeof instanceof in of try catch finally throw async await yield import from export default void delete " +
   "null true false undefined NaN static get set def lambda None True False elif pass with as not and or is " +
   "self print public private protected interface enum type namespace package").split(" ").forEach(function (k) { KEYWORDS[k] = 1; });
  var HASH_EXT = { py: 1, rb: 1, sh: 1, bash: 1, yml: 1, yaml: 1, toml: 1, ini: 1, conf: 1, r: 1, pl: 1 };
  function hlSpan(cls, text) { return '<span class="t-' + cls + '">' + esc(text) + '</span>'; }
  function isWordChar(c) { return c && (c === "_" || c === "$" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")); }
  function highlightCode(src, ext) {
    src = String(src == null ? "" : src);
    var hash = HASH_EXT[ext] === 1, out = "", i = 0, n = src.length;
    while (i < n) {
      var c = src[i], c2 = src[i + 1], j;
      if (c === "/" && c2 === "*") { j = src.indexOf("*/", i + 2); j = j < 0 ? n : j + 2; out += hlSpan("comment", src.slice(i, j)); i = j; continue; }
      if (c === "<" && src.substr(i, 4) === "<!--") { j = src.indexOf("-->", i + 4); j = j < 0 ? n : j + 3; out += hlSpan("comment", src.slice(i, j)); i = j; continue; }
      if (c === "/" && c2 === "/") { j = src.indexOf("\n", i); if (j < 0) j = n; out += hlSpan("comment", src.slice(i, j)); i = j; continue; }
      if (hash && c === "#") { j = src.indexOf("\n", i); if (j < 0) j = n; out += hlSpan("comment", src.slice(i, j)); i = j; continue; }
      if (c === "\"" || c === "'" || c === "`") { var q = c; j = i + 1; while (j < n) { var cc = src[j]; if (cc === "\\") { j += 2; continue; } if (cc === q) { j++; break; } if (q !== "`" && cc === "\n") break; j++; } out += hlSpan("string", src.slice(i, j)); i = j; continue; }
      if (c >= "0" && c <= "9") { j = i + 1; while (j < n && (isWordChar(src[j]) || src[j] === ".")) j++; out += hlSpan("number", src.slice(i, j)); i = j; continue; }
      if (isWordChar(c)) { j = i + 1; while (j < n && isWordChar(src[j])) j++; var w = src.slice(i, j); out += KEYWORDS[w] ? hlSpan("keyword", w) : esc(w); i = j; continue; }
      out += esc(c); i++;
    }
    return out;
  }
  function syncScroll() { var pre = $("#edPre"), ed = $("#editor"); if (pre && ed) { pre.scrollTop = ed.scrollTop; pre.scrollLeft = ed.scrollLeft; } }
  function updateHighlight() {
    var code = $("#edHL"); if (!code) return;
    var ed = $("#editor");
    var ext = openPath ? (openPath.split(".").pop() || "").toLowerCase() : "";
    code.innerHTML = highlightCode(ed.value, ext) + "\n";
    syncScroll();
  }
  // 4.82: 输入路径的高亮防抖 —— highlightCode 对全文逐字符扫描并重建 innerHTML,
  // 大文件每个按键全量重算会明显卡顿;150ms 防抖,Tab 缩进等单次操作仍即时高亮。
  var _hlTimer = 0;
  function scheduleHighlight() {
    if (_hlTimer) clearTimeout(_hlTimer);
    _hlTimer = setTimeout(function () { _hlTimer = 0; updateHighlight(); }, 150);
  }

  // ───── 模型列表(同 canvas/studio) ─────
  function models() {
    var free = (window.APP_MODELS_FREE && window.APP_MODELS_FREE.length) ? window.APP_MODELS_FREE : ["deepseek-ai/deepseek-v4-pro"];
    var fast = (window.APP_MODELS_FAST && window.APP_MODELS_FAST.length) ? window.APP_MODELS_FAST : [];
    var seen = {}, out = [];
    free.concat(fast).forEach(function (m) {
      if (!m) return;
      var id = (typeof m === "string") ? m : (m.id || "");
      var label = (typeof m === "string") ? m : (m.label || m.id || "");
      if (!id || seen[id]) return;
      if (id.indexOf("__") === 0) return; // 2026-09-14:占位模型("__xx_placeholder__")不是可选项
      seen[id] = 1; out.push({ id: id, label: label });
    });
    return out;
  }

  // ───── zip (STORE 方法,无压缩,含 CRC32;零依赖) ─────
  var CRC_TABLE = (function () {
    var t = [], c, n, k;
    for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function buildZip(entries) {
    var enc = new TextEncoder();
    function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
    function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }
    var local = [], central = [], offset = 0, count = 0;
    entries.forEach(function (e) {
      var nameBytes = enc.encode(e.name);
      var data = (e.data instanceof Uint8Array) ? e.data : enc.encode(String(e.data || ""));
      var crc = crc32(data), size = data.length;
      var lh = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0));
      local.push(new Uint8Array(lh), nameBytes, data);
      var ch = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push(new Uint8Array(ch), nameBytes);
      offset += lh.length + nameBytes.length + size;
      count++;
    });
    var centralSize = central.reduce(function (a, c) { return a + c.length; }, 0);
    var eocd = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(centralSize), u32(offset), u16(0)));
    var all = local.concat(central, [eocd]);
    var total = all.reduce(function (a, c) { return a + c.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  // ───── 文件工具 ─────
  function fileList() { return cur ? Object.keys(cur.files).sort() : []; }
  function ensureFolders(path) {
    var parts = path.split("/"); parts.pop();
    var acc = "";
    parts.forEach(function (p) { acc = acc ? acc + "/" + p : p; if (cur.folders.indexOf(acc) < 0) cur.folders.push(acc); });
  }
  function buildTree() {
    var root = { name: "", path: "", type: "dir", children: [] }, dirMap = { "": root };
    function getDir(path) {
      if (dirMap[path] != null) return dirMap[path];
      var parts = path.split("/"), name = parts.pop(), parent = getDir(parts.join("/"));
      var d = { name: name, path: path, type: "dir", children: [] };
      dirMap[path] = d; parent.children.push(d); return d;
    }
    (cur.folders || []).forEach(function (f) { if (f) getDir(f); });
    fileList().forEach(function (path) {
      var parts = path.split("/"), name = parts.pop(), parent = getDir(parts.join("/"));
      parent.children.push({ name: name, path: path, type: "file", children: [] });
    });
    (function sortDir(d) {
      d.children.sort(function (a, b) { return (a.type !== b.type) ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name); });
      d.children.forEach(function (c) { if (c.type === "dir") sortDir(c); });
    })(root);
    return root;
  }

  // ───── 渲染:项目下拉 ─────
  function renderProjects() {
    var sel = $("#projSel");
    sel.innerHTML = "";
    projects.slice().sort(function (a, b) { return (b.updatedAt || "").localeCompare(a.updatedAt || ""); }).forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.id; o.textContent = p.name;
      if (cur && p.id === cur.id) o.selected = true;
      sel.appendChild(o);
    });
  }

  // ───── 渲染:文件树 ─────
  var SVG_DIR_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  var SVG_DIR_CLOSED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  var SVG_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 4H7a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9z"/><path d="M13.5 4v5H18.5"/></svg>';
  function renderTree() {
    var box = $("#tree");
    box.innerHTML = "";
    if (!cur || (!fileList().length && !(cur.folders || []).length)) {
      var e = document.createElement("div");
      e.className = "tree-empty";
      e.textContent = "还没有文件。点上方 + 新建文件,或让下方 AI 生成到新文件。";
      box.appendChild(e);
      return;
    }
    var root = buildTree();
    function row(node, depth) {
      var div = document.createElement("div");
      div.className = "tnode" + (node.type === "file" && node.path === openPath ? " active" : "");
      div.style.paddingLeft = (8 + depth * 14) + "px";
      var tw = document.createElement("span"); tw.className = "tw";
      tw.innerHTML = node.type === "dir" ? (collapsed[node.path] ? SVG_DIR_CLOSED : SVG_DIR_OPEN) : SVG_FILE;
      var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = node.name;
      var del = document.createElement("button"); del.className = "del"; del.textContent = "×";
      del.title = node.type === "dir" ? "删除文件夹(含内部文件)" : "删除文件";
      div.appendChild(tw); div.appendChild(nm); div.appendChild(del);
      div.addEventListener("click", function (ev) {
        if (ev.target === del) return;
        if (node.type === "dir") { collapsed[node.path] = !collapsed[node.path]; renderTree(); }
        else openFile(node.path);
      });
      del.addEventListener("click", function (ev) { ev.stopPropagation(); node.type === "dir" ? deleteFolder(node.path) : deleteFile(node.path); });
      box.appendChild(div);
      if (node.type === "dir" && !collapsed[node.path]) node.children.forEach(function (c) { row(c, depth + 1); });
    }
    root.children.forEach(function (c) { row(c, 0); });
  }

  // ───── 编辑器 ─────
  function refreshEditorState() {
    var has = !!(cur && openPath != null && cur.files[openPath] != null);
    var ed = $("#editor");
    ed.disabled = !has;
    $("#edEmpty").style.display = has ? "none" : "flex";
    $("#edPath").textContent = has ? openPath : "未打开文件";
    $("#renameFileBtn").disabled = !has;
    $("#delFileBtn").disabled = !has;
  }
  function renderTabs() {
    var box = $("#edTabs"); if (!box) return;
    box.innerHTML = "";
    openTabs.forEach(function (path) {
      if (!cur || cur.files[path] == null) return;
      var t = document.createElement("div");
      t.className = "ed-tab" + (path === openPath ? " active" : "");
      var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = path.split("/").pop(); nm.title = path;
      var x = document.createElement("span"); x.className = "x"; x.textContent = "×"; x.title = "关闭";
      t.appendChild(nm); t.appendChild(x);
      t.addEventListener("click", function (ev) { if (ev.target === x) closeTab(path); else activateTab(path); });
      box.appendChild(t);
    });
  }
  function activeTabEl() { return $("#edTabs .ed-tab.active"); }
  function activateTab(path) {
    if (!cur || cur.files[path] == null) return;
    openPath = path; cur.openPath = path;
    $("#editor").value = cur.files[path];
    refreshEditorState(); renderTabs(); renderTree(); updateHighlight(); markClean(); scheduleSave();
  }
  function closeTab(path) {
    var idx = openTabs.indexOf(path);
    if (idx < 0) return;
    openTabs.splice(idx, 1);
    if (cur) cur.openTabs = openTabs.slice();
    if (openPath === path) {
      var next = openTabs[idx] || openTabs[idx - 1] || null;
      if (next != null) { activateTab(next); return; }
      openPath = null; if (cur) cur.openPath = null; $("#editor").value = "";
      refreshEditorState(); renderTabs(); renderTree(); updateHighlight();
    } else { renderTabs(); }
    scheduleSave();
  }
  function openFile(path) {
    if (!cur || cur.files[path] == null) return;
    if (openTabs.indexOf(path) < 0) openTabs.push(path);
    if (cur) cur.openTabs = openTabs.slice();
    activateTab(path);
  }
  function markDirty() { $("#edDot").classList.add("on"); var t = activeTabEl(); if (t) t.classList.add("dirty"); }
  function markClean() { $("#edDot").classList.remove("on"); var t = activeTabEl(); if (t) t.classList.remove("dirty"); }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
  }
  function saveNow() {
    if (!cur) return;
    cur.updatedAt = new Date().toISOString();
    dbPut(cur).then(function () { markClean(); }).catch(function () {});
  }

  // ───── 文件/文件夹 增删改 ─────
  // (4.82: 删掉带 prompt() 的旧 newFile() —— 无任何调用方,「新建文件」按钮走 openFileModal)
  function newFolder() {
    if (!cur) return;
    var path = prompt("新文件夹路径(如 src/utils):", "");
    if (path == null) return;
    path = normPath(path);
    if (!path) { alert("路径不能为空"); return; }
    if (cur.folders.indexOf(path) < 0) cur.folders.push(path);
    var seg = path.split("/"); seg.pop();
    var acc = ""; seg.forEach(function (p) { acc = acc ? acc + "/" + p : p; if (cur.folders.indexOf(acc) < 0) cur.folders.push(acc); });
    collapsed[path] = false; saveNow(); renderTree();
  }
  function renameFile() {
    if (!cur || openPath == null) return;
    var np = prompt("重命名 / 移动文件:", openPath);
    if (np == null) return;
    np = normPath(np);
    if (!np || np === openPath) return;
    if (cur.files[np] != null) { alert("目标已存在:" + np); return; }
    cur.files[np] = cur.files[openPath];
    delete cur.files[openPath];
    ensureFolders(np);
    var ri = openTabs.indexOf(openPath); if (ri >= 0) openTabs[ri] = np;
    openPath = np; cur.openPath = np; cur.openTabs = openTabs.slice();
    saveNow(); renderTabs(); renderTree(); refreshEditorState(); updateHighlight();
  }
  function deleteFile(path) {
    if (!cur || cur.files[path] == null) return;
    if (!confirm("删除文件 " + path + " ?")) return;
    delete cur.files[path];
    var ti = openTabs.indexOf(path); if (ti >= 0) openTabs.splice(ti, 1);
    cur.openTabs = openTabs.slice();
    if (openPath === path) { openPath = openTabs[0] || null; cur.openPath = openPath; $("#editor").value = (openPath != null && cur.files[openPath] != null) ? cur.files[openPath] : ""; }
    saveNow(); renderTabs(); renderTree(); refreshEditorState(); updateHighlight();
  }
  function deleteFolder(folder) {
    if (!cur) return;
    var hits = fileList().filter(function (p) { return p === folder || p.indexOf(folder + "/") === 0; });
    if (!confirm("删除文件夹 " + folder + " 及其下 " + hits.length + " 个文件?")) return;
    hits.forEach(function (p) { delete cur.files[p]; var ti = openTabs.indexOf(p); if (ti >= 0) openTabs.splice(ti, 1); if (openPath === p) { openPath = null; cur.openPath = null; $("#editor").value = ""; } });
    cur.folders = (cur.folders || []).filter(function (f) { return f !== folder && f.indexOf(folder + "/") !== 0; });
    if (openPath == null) { openPath = openTabs[0] || null; cur.openPath = openPath; if (openPath != null) $("#editor").value = cur.files[openPath]; }
    cur.openTabs = openTabs.slice();
    saveNow(); renderTabs(); renderTree(); refreshEditorState(); updateHighlight();
  }

  // ───── 项目 增删改 ─────
  function starterFiles() {
    return {
      "index.html": "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\" />\n<title>新项目</title>\n<link rel=\"stylesheet\" href=\"style.css\" />\n</head>\n<body>\n  <h1>Hello</h1>\n  <script src=\"main.js\"></script>\n</body>\n</html>\n",
      "style.css": "body { font-family: system-ui, sans-serif; margin: 2rem; }\n",
      "main.js": "console.log('hello from 代码台');\n"
    };
  }
  function createProject(name, files, folders) {
    var p = { id: uid(), name: name || "新项目", files: files || {}, folders: folders || [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), openPath: null };
    projects.push(p);
    return dbPut(p).then(function () { return p; });
  }
  function switchProject(id) {
    var p = projects.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    cur = p; collapsed = {};
    openTabs = (p.openTabs || []).filter(function (pp) { return p.files[pp] != null; });
    openPath = (p.openPath && p.files[p.openPath] != null) ? p.openPath : (openTabs[0] || fileList()[0] || null);
    if (openPath != null && openTabs.indexOf(openPath) < 0) openTabs.push(openPath);
    cur.openTabs = openTabs.slice(); cur.openPath = openPath;
    try { localStorage.setItem(LS_LAST, p.id); } catch (e) {}
    renderProjects(); renderTabs(); renderTree();
    if (openPath != null && cur.files[openPath] != null) { $("#editor").value = cur.files[openPath]; }
    else { $("#editor").value = ""; }
    refreshEditorState(); updateHighlight(); markClean();
  }
  function newProject() {
    var name = prompt("新项目名称:", "新项目");
    if (name == null) return;
    createProject(name.trim() || "新项目", starterFiles(), []).then(function (p) { switchProject(p.id); });
  }
  function renameProject() {
    if (!cur) return;
    var name = prompt("重命名项目:", cur.name);
    if (name == null) return;
    cur.name = name.trim() || cur.name; saveNow(); renderProjects();
  }
  function deleteProject() {
    if (!cur) return;
    if (!confirm("删除项目 「" + cur.name + "」 及其全部文件?此操作不可撤销。")) return;
    var id = cur.id;
    projects = projects.filter(function (x) { return x.id !== id; });
    dbDel(id).then(function () {
      if (projects.length) switchProject(projects[0].id);
      else createProject("新项目", starterFiles(), []).then(function (p) { switchProject(p.id); });
    });
  }

  // ───── 导出 zip ─────
  function exportZip() {
    if (!cur) return;
    var paths = fileList();
    if (!paths.length) { alert("项目里还没有文件"); return; }
    var entries = paths.map(function (p) { return { name: p, data: cur.files[p] }; });
    var bytes = buildZip(entries);
    var blob = new Blob([bytes], { type: "application/zip" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = (cur.name || "project").replace(/[^\w一-龥.-]+/g, "_") + ".zip";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  // ───── 导入 zip(STORE 直接拷,DEFLATE 用浏览器原生 DecompressionStream)─────
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") throw new Error("此浏览器不支持解压(DecompressionStream),请用新版 Chrome/Edge/Android");
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }
  async function readZip(buf) {
    var dv = new DataView(buf), bytes = new Uint8Array(buf), dec = new TextDecoder();
    var eocd = -1;
    for (var q = bytes.length - 22; q >= 0; q--) { if (dv.getUint32(q, true) === 0x06054b50) { eocd = q; break; } }
    if (eocd < 0) throw new Error("不是有效的 zip 文件");
    var count = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true), files = {};
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.charAt(name.length - 1) === "/") continue;
      if (dv.getUint32(lho, true) !== 0x04034b50) continue;
      var lNameLen = dv.getUint16(lho + 26, true);
      var lExtraLen = dv.getUint16(lho + 28, true);
      var dataStart = lho + 30 + lNameLen + lExtraLen;
      var comp = bytes.subarray(dataStart, dataStart + compSize);
      var raw;
      if (method === 0) raw = comp;
      else if (method === 8) raw = await inflateRaw(comp);
      else continue;
      files[normPath(name)] = dec.decode(raw);
    }
    return files;
  }
  function stripCommonRoot(files) {
    var keys = Object.keys(files);
    if (!keys.length) return files;
    var first = keys[0].split("/")[0];
    if (!first) return files;
    var all = keys.every(function (key) { return key.indexOf("/") >= 0 && key.split("/")[0] === first; });
    if (!all) return files;
    var out = {};
    keys.forEach(function (key) { out[key.slice(first.length + 1)] = files[key]; });
    return out;
  }
  function deriveFolders(files) {
    var set = {};
    Object.keys(files).forEach(function (p) { var parts = p.split("/"); parts.pop(); var acc = ""; parts.forEach(function (s) { acc = acc ? acc + "/" + s : s; set[acc] = 1; }); });
    return Object.keys(set);
  }
  async function importZip(file) {
    if ($("#aiStatus")) $("#aiStatus").textContent = "正在解压 " + file.name + " …";
    try {
      var buf = await file.arrayBuffer();
      var files = stripCommonRoot(await readZip(buf));
      var paths = Object.keys(files);
      if (!paths.length) { alert("zip 里没有可导入的文本文件"); return; }
      var name = file.name.replace(/\.zip$/i, "") || "导入项目";
      var pj = await createProject(name, files, deriveFolders(files));
      switchProject(pj.id);
      if ($("#aiStatus")) $("#aiStatus").textContent = "已导入 " + paths.length + " 个文件为新项目「" + pj.name + "」";
    } catch (e) {
      if ($("#aiStatus")) $("#aiStatus").textContent = "";
      alert("导入失败:" + (e && e.message || e));
    }
  }

  // ───── AI(/api/chat 流式,同 canvas 契约) ─────
  var aiAborter = null;
  function stripFences(text) {
    var t = String(text || "").trim();
    var m = t.match(/^```[\w+\-]*\s*\n([\s\S]*?)\n```$/);
    if (m) return m[1];
    return t.replace(/^```[\w+\-]*\s*\n?/, "").replace(/\n?```$/, "");
  }
  function aiBusy(on) {
    $("#aiRunBtn").hidden = on; $("#aiStopBtn").hidden = !on;
  }
  async function aiChat(system, user, model, onDelta) {
    var on = unlimitedOn();
    var body = { mode: "free", model: model || "", promptProfile: "assist", use_builtin_persona: on, custom_system_prompt: system || "", thinking: "disabled", messages: [{ role: "user", content: user || "" }] };
    try { var _bid = localStorage.getItem("cfw_base_id_v1") || ""; if (_bid) body.baseId = _bid; } catch (e) {}
    
    aiAborter = new AbortController();
    var resp = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: aiAborter.signal });
    if (!resp.ok || !resp.body) throw new Error("请求失败 HTTP " + resp.status);
    var reader = resp.body.getReader(), dec = new TextDecoder(), buf = "", full = "";
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var lines = buf.split("\n"); buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.indexOf("data:") !== 0) continue;
        var data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          var j = JSON.parse(data);
          var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) { full += delta; if (onDelta) onDelta(full); }
        } catch (e) {}
      }
    }
    return full;
  }
  function parseManifest(text) {
    var t = stripFences(text);
    try { return JSON.parse(t); } catch (e) {}
    var i = t.indexOf("{"), j = t.lastIndexOf("}");
    if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) {} }
    return null;
  }
  // 整个项目模式: 把 AI 返回的文件操作清单落到项目(建/改/删/移文件 + 建文件夹)
  function applyManifest(manifest) {
    var ops = (manifest && Array.isArray(manifest.ops)) ? manifest.ops : [];
    var log = [];
    ops.forEach(function (op) {
      if (!op || !op.action) return;
      if (op.action === "write") {
        var p = normPath(op.path); if (!p) return;
        var existed = cur.files[p] != null;
        cur.files[p] = String(op.content == null ? "" : op.content);
        ensureFolders(p);
        log.push((existed ? "改 " : "建 ") + p);
      } else if (op.action === "delete") {
        var dp = normPath(op.path); if (!dp || cur.files[dp] == null) return;
        delete cur.files[dp];
        if (openPath === dp) { openPath = null; cur.openPath = null; $("#editor").value = ""; }
        log.push("删 " + dp);
      } else if (op.action === "mkdir") {
        var fp = normPath(op.path); if (!fp) return;
        if (cur.folders.indexOf(fp) < 0) cur.folders.push(fp);
        var seg = fp.split("/"); seg.pop(); var acc = "";
        seg.forEach(function (s) { acc = acc ? acc + "/" + s : s; if (cur.folders.indexOf(acc) < 0) cur.folders.push(acc); });
        log.push("建夹 " + fp);
      } else if (op.action === "rename") {
        var from = normPath(op.from), to = normPath(op.to);
        if (!from || !to || cur.files[from] == null || cur.files[to] != null) return;
        cur.files[to] = cur.files[from]; delete cur.files[from]; ensureFolders(to);
        if (openPath === from) { openPath = to; cur.openPath = to; }
        log.push("移 " + from + " → " + to);
      }
    });
    openTabs = openTabs.filter(function (p) { return cur.files[p] != null; });
    if (openPath != null && cur.files[openPath] == null) { openPath = openTabs[0] || null; cur.openPath = openPath; }
    cur.openTabs = openTabs.slice();
    saveNow(); renderTabs(); renderTree(); refreshEditorState();
    $("#editor").value = (openPath != null && cur.files[openPath] != null) ? cur.files[openPath] : "";
    updateHighlight();
    return { applied: log.length, summary: log.join("\n") };
  }
  async function runProjectAI(prompt0, model) {
    var listing = fileList().map(function (p) { return "  " + p + " (" + (cur.files[p] || "").length + " 字)"; }).join("\n") || "  (空项目)";
    var folders = (cur.folders || []).join(", ") || "(无)";
    var sys = "你是项目级代码助手,可新建/改写/删除文件和文件夹来满足需求。\n"
      + "当前项目文件:\n" + listing + "\n文件夹: " + folders + "\n\n"
      + "只输出一个 JSON 对象(不要解释、不要 Markdown 围栏),格式:\n"
      + '{"note":"一句话说明改动","ops":[\n'
      + '  {"action":"write","path":"src/app.js","content":"完整文件内容"},\n'
      + '  {"action":"delete","path":"old.js"},\n'
      + '  {"action":"mkdir","path":"src/utils"},\n'
      + '  {"action":"rename","from":"a.js","to":"b.js"}\n'
      + "]}\n"
      + "规则: write 的 content 必须是完整文件内容(不是补丁); 只列出需要改动的文件; 路径用相对项目根的正斜杠路径。";
    var userMsg = "需求:" + prompt0;
    aiBusy(true); $("#aiStatus").textContent = "规划文件改动中…";
    try {
      var result = await aiChat(sys, userMsg, model, function (full) { $("#aiStatus").textContent = "规划中… " + full.length + " 字"; });
      var manifest = parseManifest(result);
      if (!manifest || !Array.isArray(manifest.ops) || !manifest.ops.length) {
        $("#aiStatus").textContent = "AI 没返回可用的文件操作,可重试或换单文件模式";
        return;
      }
      var preview = manifest.ops.map(function (op) {
        if (op.action === "write") return (cur.files[normPath(op.path)] != null ? "改 " : "建 ") + op.path;
        if (op.action === "delete") return "删 " + op.path;
        if (op.action === "mkdir") return "建夹 " + op.path;
        if (op.action === "rename") return "移 " + op.from + " → " + op.to;
        return op.action;
      }).join("\n");
      if (!confirm("AI 计划对项目做以下改动:\n\n" + preview + "\n\n" + (manifest.note ? ("说明: " + manifest.note + "\n\n") : "") + "确认应用?")) {
        $("#aiStatus").textContent = "已取消"; return;
      }
      var r = applyManifest(manifest);
      $("#aiStatus").textContent = "已应用 " + r.applied + " 项改动";
      $("#aiPrompt").value = "";
    } catch (e) {
      $("#aiStatus").textContent = (e && e.name === "AbortError") ? "已停止" : ("出错:" + (e && e.message || e));
    } finally {
      aiBusy(false); aiAborter = null;
    }
  }
  async function runAI() {
    if (!cur) { alert("先创建或选择一个项目"); return; }
    var prompt0 = $("#aiPrompt").value.trim();
    if (!prompt0) { $("#aiPrompt").focus(); return; }
    var target = $("#aiTarget").value;
    var model = $("#aiModel").value;
    if ((target === "replace" || target === "insert") && openPath == null) { alert("请先打开一个文件,或改用「生成到新文件」"); return; }
    // 整个项目模式: AI 自管文件架构(建/删/改/移文件 + 建文件夹),走 JSON manifest 协议
    if (target === "project") { await runProjectAI(prompt0, model); return; }
    if ($("#twoPass") && $("#twoPass").checked) {
      var spec = await expandToSpec(prompt0, target, model);
      if (spec == null) return;
      prompt0 = spec;
    }
    var lang = openPath ? (openPath.split(".").pop() || "") : "";
    var sys = "你是代码助手。根据需求生成或修改代码。只输出代码本体,不要任何解释、不要 Markdown 代码块围栏。";
    var userMsg = prompt0;
    if (target !== "new" && openPath) {
      sys += "目标文件:" + openPath + (lang ? (" (" + lang + ")") : "") + "。输出完整的文件内容。";
      userMsg = "当前文件内容:\n" + (cur.files[openPath] || "(空)") + "\n\n需求:" + prompt0;
    }
    aiBusy(true); $("#aiStatus").textContent = "生成中…";
    try {
      var result = await aiChat(sys, userMsg, model, function (full) { $("#aiStatus").textContent = "生成中… " + full.length + " 字"; });
      var code = stripFences(result);
      if (target === "new") {
        var suggested = guessName(prompt0, code);
        openFileModal({ title: "保存生成结果为新文件", defaultName: suggested, onConfirm: function (path) {
          if (cur.files[path] != null && !confirm("覆盖已有文件 " + path + "?")) return;
          cur.files[path] = code; ensureFolders(path); saveNow(); renderTree(); openFile(path);
          $("#aiStatus").textContent = "已保存到 " + path;
        } });
      } else if (target === "replace") {
        $("#editor").value = code; cur.files[openPath] = code; markDirty(); scheduleSave(); updateHighlight();
      } else { // insert
        var ed = $("#editor"), s = ed.selectionStart, e = ed.selectionEnd, v = ed.value;
        ed.value = v.slice(0, s) + code + v.slice(e);
        cur.files[openPath] = ed.value; markDirty(); scheduleSave(); updateHighlight();
        var np = s + code.length; ed.selectionStart = ed.selectionEnd = np;
      }
      $("#aiStatus").textContent = "完成 · " + code.length + " 字";
      $("#aiPrompt").value = "";
    } catch (e) {
      $("#aiStatus").textContent = (e && e.name === "AbortError") ? "已停止" : ("出错:" + (e && e.message || e));
    } finally {
      aiBusy(false); aiAborter = null;
    }
  }
  // ───── 两段式：规格确认弹窗 ─────
  var specModalConfirm = null;
  function openSpecModal(text, onConfirm) {
    var ta = $("#specText"); ta.value = text || "";
    specModalConfirm = onConfirm || null;
    $("#specModalMask").hidden = false;
    setTimeout(function () { ta.focus(); }, 0);
  }
  function closeSpecModal(apply) {
    var cb = specModalConfirm; specModalConfirm = null;
    var val = $("#specText").value;
    $("#specModalMask").hidden = true;
    if (cb) cb(apply ? val : null);
  }
  function wireSpecModal() {
    $("#specCancel").addEventListener("click", function () { closeSpecModal(false); });
    $("#specOk").addEventListener("click", function () { closeSpecModal(true); });
    $("#specModalMask").addEventListener("click", function (ev) { if (ev.target === this) closeSpecModal(false); });
  }
  function guessName(prompt0, code) {
    var t = String(code || "").trim();
    if (/^<!doctype html|^<html[\s>]/i.test(t)) return "new.html";
    if (/^\s*[{\[]/.test(t)) { try { JSON.parse(t); return "data.json"; } catch (e) {} }
    if (/\bdef \w+\(|\bimport \w+/.test(t) && !/function|=>|;\s*$/m.test(t)) return "script.py";
    if (/[#.@][\w-]+\s*\{[\s\S]*\}/.test(t) && /:[^;]+;/.test(t)) return "style.css";
    return "snippet.js";
  }

  var SPEC_SYS = "你是资深技术规格师。把用户这句模糊需求扩写成一份简洁但完整的实现规格,包含:目标与核心功能、技术栈与依赖库(给出推荐与理由)、文件结构、关键交互或算法要点、边界与异常、验收标准。只输出规格本身(用 Markdown),先不要写代码。";
  async function expandToSpec(prompt0, target, model) {
    var ctxNote = (target !== "new" && openPath) ? ("\n(将用于修改文件 " + openPath + ")") : "";
    aiBusy(true); $("#aiStatus").textContent = "规划规格中…";
    var spec;
    try {
      spec = await aiChat(SPEC_SYS, "需求:" + prompt0 + ctxNote, model, function (full) { $("#aiStatus").textContent = "规划规格中… " + full.length + " 字"; });
    } catch (e) {
      $("#aiStatus").textContent = (e && e.name === "AbortError") ? "已停止" : ("出错:" + (e && e.message || e));
      aiBusy(false); aiAborter = null; return null;
    }
    aiBusy(false); aiAborter = null;
    $("#aiStatus").textContent = "规格已生成,确认/编辑后生成代码";
    return await new Promise(function (resolve) {
      openSpecModal(spec, function (val) { if (val == null) $("#aiStatus").textContent = "已取消"; resolve(val); });
    });
  }
  // ───── 语言 & 新建/保存弹窗 ─────
  var LANGS = [
    { label: "HTML", ext: "html" },
    { label: "CSS", ext: "css" },
    { label: "JavaScript", ext: "js" },
    { label: "TypeScript", ext: "ts" },
    { label: "JSON", ext: "json" },
    { label: "Python", ext: "py" },
    { label: "Markdown", ext: "md" },
    { label: "纯文本", ext: "txt" }
  ];
  function extOf(p) { p = normPath(p); var i = p.lastIndexOf("."); return i >= 0 ? p.slice(i + 1).toLowerCase() : ""; }
  function langByExt(e) { for (var i = 0; i < LANGS.length; i++) { if (LANGS[i].ext === e) return LANGS[i]; } return null; }
  function swapExt(p, e) { p = normPath(p) || "未命名"; var i = p.lastIndexOf("/"), d = p.lastIndexOf("."); if (d > i) p = p.slice(0, d); return e ? p + "." + e : p; }
  var fileModalCb = null;
  function fillLangSelect() { var sel = $("#fileModalLang"); if (!sel || sel.__filled) return; sel.__filled = 1; LANGS.forEach(function (l) { var o = document.createElement("option"); o.value = l.ext; o.textContent = l.label + " (." + l.ext + ")"; sel.appendChild(o); }); }
  function openFileModal(opts) {
    opts = opts || {}; fillLangSelect();
    var nameEl = $("#fileModalName"), langEl = $("#fileModalLang");
    $("#fileModalTitle").textContent = opts.title || "新建文件";
    nameEl.value = opts.defaultName || "";
    var e = extOf(nameEl.value) || opts.defaultLang || "js";
    langEl.value = langByExt(e) ? e : "txt";
    fileModalCb = opts.onConfirm || null;
    $("#fileModalMask").hidden = false;
    setTimeout(function () { nameEl.focus(); var d = nameEl.value.lastIndexOf("."); try { nameEl.setSelectionRange(0, d > 0 ? d : nameEl.value.length); } catch (x) {} }, 0);
  }
  function closeFileModal() { $("#fileModalMask").hidden = true; fileModalCb = null; }
  function wireFileModal() {
    var nameEl = $("#fileModalName"), langEl = $("#fileModalLang");
    langEl.addEventListener("change", function () { nameEl.value = swapExt(nameEl.value, langEl.value); nameEl.focus(); });
    nameEl.addEventListener("input", function () { var e = extOf(nameEl.value); if (langByExt(e)) langEl.value = e; });
    nameEl.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); $("#fileModalOk").click(); } else if (ev.key === "Escape") { closeFileModal(); } });
    $("#fileModalCancel").addEventListener("click", closeFileModal);
    $("#fileModalMask").addEventListener("click", function (ev) { if (ev.target === this) closeFileModal(); });
    $("#fileModalOk").addEventListener("click", function () { var path = normPath(nameEl.value); if (!path) { nameEl.focus(); return; } var cb = fileModalCb; closeFileModal(); if (cb) cb(path); });
  }

  // ───── 运行 / 预览(浏览器内沙箱;支持 HTML / CSS / JS) ─────
  var RUN_RUNNABLE = { html: 1, htm: 1, js: 1, css: 1 };
  function dirOf(p) { var i = p.lastIndexOf("/"); return i >= 0 ? p.slice(0, i) : ""; }
  function joinPath(base, rel) {
    rel = String(rel || "").replace(/^\.\//, "");
    if (rel.charAt(0) === "/") return normPath(rel);
    var parts = (base ? base.split("/") : []).concat(rel.split("/")), out = [];
    parts.forEach(function (s) { if (s === "" || s === ".") return; if (s === "..") out.pop(); else out.push(s); });
    return out.join("/");
  }
  function consoleHook() {
    return "<script>(function(){function s(t,a){try{parent.postMessage({__cfwRun:1,t:t,m:a},'*')}catch(e){}}"
      + "['log','info','warn','error'].forEach(function(k){var o=console[k];console[k]=function(){var a=[].slice.call(arguments).map(function(x){try{return typeof x==='object'?JSON.stringify(x):String(x)}catch(e){return String(x)}}).join(' ');s(k,a);if(o)o.apply(console,arguments)}});"
      + "window.addEventListener('error',function(e){s('error',(e.message||'Error')+' @'+(e.lineno||0)+':'+(e.colno||0))});"
      + "window.addEventListener('unhandledrejection',function(e){s('error','Promise: '+((e.reason&&e.reason.message)||e.reason))});"
      + "})();<\/script>";
  }
  function inlineAssets(html, dir) {
    html = html.replace(/<link\b[^>]*>/gi, function (tag) {
      if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
      var m = tag.match(/href\s*=\s*["']([^"']+)["']/i); if (!m) return tag;
      var fp = joinPath(dir, m[1]);
      return cur.files[fp] != null ? "<style>\n" + cur.files[fp] + "\n</style>" : tag;
    });
    html = html.replace(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*><\/script>/gi, function (tag, src) {
      var fp = joinPath(dir, src);
      return cur.files[fp] != null ? "<script>\n" + cur.files[fp].replace(/<\/script>/gi, "<\\/script>") + "\n</script>" : tag;
    });
    return html;
  }
  function buildPreviewDoc(entry) {
    var hook = consoleHook(), src = cur.files[entry] || "";
    if (/\.css$/i.test(entry)) return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" + hook + "<style>\n" + src + "\n</style></head><body style=\"font-family:system-ui;padding:20px;color:#222\"><h2>CSS 预览</h2><p>这是应用了该样式表的示例文字。</p><button>示例按钮</button></body></html>";
    if (/\.html?$/i.test(entry)) {
      var html = inlineAssets(src, dirOf(entry));
      if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, function (m) { return m + hook; });
      if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, function (m) { return m + hook; });
      return hook + html;
    }
    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" + hook + "</head><body><script>\n" + src.replace(/<\/script>/gi, "<\\/script>") + "\n</script></body></html>";
  }

  // ───── 运行控制器 ─────
  function runConsolePush(type, text) { var c = $("#runConsole"); if (!c) return; var ln = document.createElement("div"); ln.className = "rc-line rc-" + (type || "log"); ln.textContent = text; c.appendChild(ln); c.scrollTop = c.scrollHeight; }
  function runConsoleClear() { var c = $("#runConsole"); if (c) c.innerHTML = ""; }
  function runnableFiles() { return fileList().filter(function (p) { return RUN_RUNNABLE[extOf(p)]; }); }
  function pickEntry() {
    if (openPath && RUN_RUNNABLE[extOf(openPath)]) return openPath;
    if (cur.files["index.html"] != null) return "index.html";
    var h = fileList().filter(function (p) { return /\.html?$/i.test(p); })[0];
    return h || runnableFiles()[0] || null;
  }
  function fillRunEntry(sel) { var box = $("#runEntry"); box.innerHTML = ""; runnableFiles().forEach(function (p) { var o = document.createElement("option"); o.value = p; o.textContent = p; if (p === sel) o.selected = true; box.appendChild(o); }); }
  function doRun() {
    var entry = $("#runEntry").value; if (!entry || !cur) return;
    runConsoleClear();
    runConsolePush("info", "运行 " + entry + " · " + new Date().toLocaleTimeString());
    $("#runFrame").srcdoc = buildPreviewDoc(entry);
  }
  function openRun() {
    if (!cur) { alert("先创建或选择一个项目"); return; }
    if (openPath != null && cur.files[openPath] != null) { cur.files[openPath] = $("#editor").value; saveNow(); }
    if (!runnableFiles().length) { alert("项目里没有可运行的文件。\n浏览器内可直接运行 HTML / CSS / JS;Python 等语言暂不支持(后续可接运行时)。"); return; }
    fillRunEntry(pickEntry());
    $("#runMask").hidden = false;
    doRun();
  }
  function closeRun() { var fr = $("#runFrame"); if (fr) fr.srcdoc = ""; $("#runMask").hidden = true; }

  // ───── 接线 ─────
  function wire() {
    var ed = $("#editor");
    ed.addEventListener("input", function () { if (cur && openPath != null) { cur.files[openPath] = ed.value; markDirty(); scheduleSave(); } scheduleHighlight(); });
    ed.addEventListener("scroll", syncScroll);
    ed.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        var s = ed.selectionStart, en = ed.selectionEnd, v = ed.value;
        ed.value = v.slice(0, s) + "  " + v.slice(en);
        ed.selectionStart = ed.selectionEnd = s + 2;
        if (cur && openPath != null) { cur.files[openPath] = ed.value; markDirty(); scheduleSave(); }
        updateHighlight();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault(); saveNow();
      }
    });
    $("#projSel").addEventListener("change", function () { switchProject(this.value); });
    $("#newProjBtn").addEventListener("click", newProject);
    $("#renameProjBtn").addEventListener("click", renameProject);
    $("#delProjBtn").addEventListener("click", deleteProject);
    $("#newFileBtn").addEventListener("click", function () {
      if (!cur) return;
      openFileModal({ title: "新建文件", defaultLang: "js", onConfirm: function (path) {
        if (cur.files[path] != null) { alert("文件已存在:" + path); openFile(path); return; }
        cur.files[path] = ""; ensureFolders(path); saveNow(); renderTree(); openFile(path);
      } });
    });
    $("#newFolderBtn").addEventListener("click", newFolder);
    $("#renameFileBtn").addEventListener("click", renameFile);
    $("#delFileBtn").addEventListener("click", function () { if (openPath != null) deleteFile(openPath); });
    $("#exportBtn").addEventListener("click", exportZip);
    var ib = $("#importBtn"), ii = $("#importInput");
    if (ib && ii) { ib.addEventListener("click", function () { ii.click(); }); ii.addEventListener("change", function () { var f = this.files && this.files[0]; if (f) importZip(f); this.value = ""; }); }
    $("#aiRunBtn").addEventListener("click", runAI);
    $("#aiStopBtn").addEventListener("click", function () { if (aiAborter) aiAborter.abort(); });
    var ap = $("#aiPrompt");
    ap.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runAI(); } });
    ap.addEventListener("input", function () { ap.style.height = "auto"; ap.style.height = Math.min(160, ap.scrollHeight) + "px"; });
    $("#runBtn").addEventListener("click", openRun);
    $("#runRefresh").addEventListener("click", doRun);
    $("#runClose").addEventListener("click", closeRun);
    $("#runEntry").addEventListener("change", doRun);
    $("#runMask").addEventListener("click", function (ev) { if (ev.target === this) closeRun(); });
    window.addEventListener("message", function (ev) { var d = ev.data; if (d && d.__cfwRun) runConsolePush(d.t || "log", String(d.m)); });
    wireFileModal();
    wireSpecModal();
    window.addEventListener("beforeunload", function () { if (cur) { try { saveNow(); } catch (e) {} } });
  }
  function fillModels() {
    var sel = $("#aiModel"); sel.innerHTML = "";
    var saved = ""; try { saved = localStorage.getItem(LS_MODEL) || ""; } catch (e) {}
    models().forEach(function (m) { var o = document.createElement("option"); o.value = m.id; o.textContent = m.label; if (m.id === saved) o.selected = true; sel.appendChild(o); });
    sel.addEventListener("change", function () { try { localStorage.setItem(LS_MODEL, sel.value); } catch (e) {} });
  }

  // ───── 启动 ─────
  openDB().then(function (d) {
    db = d; return dbGetAll();
  }).then(function (rows) {
    projects = rows || [];
    fillModels(); wire();
    if (!projects.length) {
      return createProject("我的项目", starterFiles(), []).then(function (p) { switchProject(p.id); });
    }
    var last = ""; try { last = localStorage.getItem(LS_LAST) || ""; } catch (e) {}
    var pick = projects.filter(function (x) { return x.id === last; })[0] || projects.slice().sort(function (a, b) { return (b.updatedAt || "").localeCompare(a.updatedAt || ""); })[0];
    switchProject(pick.id);
  }).catch(function (e) {
    alert("代码台初始化失败:" + (e && e.message || e) + "\n(隐私模式下 IndexedDB 可能不可用)");
  });
})();