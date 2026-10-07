// public/js/text/data/agent-workspace.js — Agent 文件工作区 + 文件工具 · 2026-09-14
//
// 解决什么:旧 write_file 只是「弹下载/弹保存框」—— 文件不落地到任何可读回的地方,
// 模型写完就读不回来,也更谈不上"改一个文件"这种真实 agent 动作。
//
// 现在两层:
//   · 工作区(本模块)      : IndexedDB,真持久化、模型可读回、可在右栏浏览。按**会话隔离**,
//                          不同对话的任务产物互不干扰(键 = convId + "::" + path)。
//   · 导出到真磁盘         : export_file 工具 —— 桌面端走 Tauri 保存对话框,网页端触发下载。
//
// 为什么工作区按会话隔离:Agent 产物是"任务的中间物",A 会话让它改 config.js、切到 B 会话
// 不该还看到。会话删除时其文件也随之无用(留给后续清理,不阻塞主流程)。
//
// 依赖:无。工具通过 window.__agentWorkspace.defineTools(registry) 注册(照 agent-reach.js 的写法)。
(function () {
  "use strict";
  if (window.__agentWorkspace) return;

  var IDB_NAME = "cfw_agent_workspace_v1";
  var IDB_STORE = "files";
  var _db = null;
  function idb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains(IDB_STORE)) {
            var os = d.createObjectStore(IDB_STORE, { keyPath: "id" });
            try { os.createIndex("conv", "convId", { unique: false }); } catch (e) {}
          }
        };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function tx(mode) { return idb().then(function (db) { return db ? db.transaction(IDB_STORE, mode).objectStore(IDB_STORE) : null; }); }
  function reqP(r) { return new Promise(function (res) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(null); }; }); }

  function convId() {
    try { return (window.__app && window.__app.getActiveConvId) ? (window.__app.getActiveConvId() || "__none__") : "__none__"; } catch (e) { return "__none__"; }
  }
  // 路径规范化:统一 / 分隔、去掉开头 ./ 与 /、拒绝 .. 逃逸(工作区是平铺命名空间)
  function normPath(p) {
    var s = String(p == null ? "" : p).trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "");
    if (!s) return "";
    var parts = s.split("/").filter(function (x) { return x && x !== "."; });
    if (parts.some(function (x) { return x === ".."; })) return "";
    return parts.join("/");
  }
  function keyOf(path) { return convId() + "::" + path; }

  function list() {
    return tx("readonly").then(function (os) {
      if (!os) return [];
      return reqP(os.getAll()).then(function (arr) {
        var c = convId();
        return (arr || []).filter(function (r) { return r && r.convId === c; })
          .map(function (r) { return { path: r.path, bytes: r.bytes || 0, ts: r.ts || 0 }; })
          .sort(function (a, b) { return a.path < b.path ? -1 : 1; });
      });
    });
  }
  function read(path) {
    var p = normPath(path);
    if (!p) return Promise.resolve(null);
    return tx("readonly").then(function (os) { return os ? reqP(os.get(keyOf(p))) : null; });
  }
  function write(path, content) {
    var p = normPath(path);
    if (!p) return Promise.resolve({ ok: false, error: "路径不合法(不能为空、不能含 ..)" });
    var text = String(content == null ? "" : content);
    var rec = { id: keyOf(p), convId: convId(), path: p, content: text, bytes: text.length, ts: Date.now() };
    return tx("readwrite").then(function (os) {
      if (!os) return { ok: false, error: "工作区不可用(IndexedDB 打不开)" };
      return reqP(os.put(rec)).then(function () { return { ok: true, path: p, bytes: text.length }; });
    });
  }
  function remove(path) {
    var p = normPath(path);
    if (!p) return Promise.resolve({ ok: false, error: "路径不合法" });
    return tx("readwrite").then(function (os) {
      if (!os) return { ok: false, error: "工作区不可用" };
      return reqP(os.delete(keyOf(p))).then(function () { return { ok: true, path: p }; });
    });
  }

  // 2026-09-14:按会话清理 —— 删除会话/清空历史时调用。
  // 不清理的话工作区会留下一堆 convId 已不存在的孤儿记录,永远读不回来也永远占着配额。
  function removeByConv(cid) {
    var target = cid || convId();
    return tx("readwrite").then(function (os) {
      if (!os) return { ok: false, removed: 0 };
      var n = 0;
      return new Promise(function (res) {
        try {
          var r = os.openCursor();
          r.onsuccess = function (e) {
            var c = e.target.result;
            if (!c) return res({ ok: true, removed: n });
            if (c.value && c.value.convId === target) { n++; c.delete(); }
            c.continue();
          };
          r.onerror = function () { res({ ok: true, removed: n }); };
        } catch (e) { res({ ok: true, removed: n }); }
      });
    });
  }
  // 清空**全部**工作区文件(「清空全部会话」时用)
  function clearAll() {
    return tx("readwrite").then(function (os) {
      if (!os) return { ok: false };
      return reqP(os.clear()).then(function () { return { ok: true }; });
    });
  }

  // ── 工具注册(照 agent-reach.js 的 defineTools 写法) ──
  function defineTools(registry) {
    if (!registry || typeof registry.define !== "function") return;
    // 2026-09-14:逐个独立 try/catch —— registry.define 对重名会抛错,若整体包一个 try,
    // 第一个重名就会把后面所有文件工具一起带崩(工具全没了)。
    var _rawDefine = registry.define.bind(registry);
    registry.define = function (def) {
      try { _rawDefine(def); } catch (e) { console.warn("[agent-workspace] 注册工具失败:", def && def.name, e); }
    };

    registry.define({
      name: "list_files",
      description: "列出当前会话工作区里的文件(路径 / 大小 / 最后修改时间)。工作区是本设备的 IndexedDB,跨会话隔离。",
      parameters: { type: "object", properties: {} },
      run: function () {
        return list().then(function (arr) {
          if (!arr.length) return { ok: true, files: [], note: "工作区还是空的。用 write_file 写入第一个文件。" };
          return { ok: true, count: arr.length, files: arr };
        });
      },
    });

    registry.define({
      name: "read_file",
      description: "读取工作区里某个文件的全文。用 list_files 先看有哪些文件。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "工作区内的文件路径,如 report.md / src/app.js" } },
        required: ["path"],
      },
      run: function (args) {
        return read(args && args.path).then(function (r) {
          if (!r) return { ok: false, error: "文件不存在: " + normPath((args && args.path) || "") };
          return { ok: true, path: r.path, bytes: r.bytes, text: r.content };
        });
      },
    });

    registry.define({
      name: "write_file",
      description: "把内容写入当前会话工作区(IndexedDB,真持久化,可被 read_file 立刻读回)。" +
        "适合产出报告/代码/数据,或作为多步任务的中间产物。要导出到真实磁盘用 export_file。",
      destructive: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内的文件路径,如 report.md / src/app.js" },
          content: { type: "string", description: "文件内容(UTF-8 文本)" },
        },
        required: ["path", "content"],
      },
      run: function (args) {
        return write(args && args.path, args && args.content).then(function (r) {
          return r.ok ? { ok: true, path: r.path, bytes: r.bytes, note: "已写入工作区,可用 read_file 读回或 export_file 导出到磁盘" } : r;
        });
      },
    });

    registry.define({
      name: "edit_file",
      description: "在工作区文件里做精确替换(把 old_string 换成 new_string)。old_string 必须在文件里唯一出现,否则报错让你补足上下文。是最常用的「改文件」工具。",
      destructive: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内的文件路径" },
          old_string: { type: "string", description: "要被替换的原文(需在文件中唯一)" },
          new_string: { type: "string", description: "替换成的新内容" },
          replace_all: { type: "boolean", description: "true = 替换全部出现(默认 false,要求唯一)" },
        },
        required: ["path", "old_string", "new_string"],
      },
      run: function (args) {
        var a = args || {};
        return read(a.path).then(function (r) {
          if (!r) return { ok: false, error: "文件不存在: " + normPath(a.path) };
          var oldS = String(a.old_string == null ? "" : a.old_string);
          if (!oldS) return { ok: false, error: "old_string 不能为空" };
          var cnt = r.content.split(oldS).length - 1;
          if (cnt === 0) return { ok: false, error: "没找到 old_string(注意空格/换行要完全一致)" };
          if (cnt > 1 && a.replace_all !== true) return { ok: false, error: "old_string 在文件里出现了 " + cnt + " 次,不唯一。请把上下文补足让它唯一,或传 replace_all:true。" };
          var next = a.replace_all === true ? r.content.split(oldS).join(String(a.new_string == null ? "" : a.new_string))
            : r.content.replace(oldS, String(a.new_string == null ? "" : a.new_string));
          return write(a.path, next).then(function (w) {
            return w.ok ? { ok: true, path: w.path, replaced: cnt, bytes: w.bytes } : w;
          });
        });
      },
    });

    registry.define({
      name: "delete_file",
      description: "从工作区删除一个文件。",
      destructive: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "工作区内的文件路径" } },
        required: ["path"],
      },
      run: function (args) {
        return remove(args && args.path).then(function (r) {
          return r.ok ? { ok: true, path: r.path, note: "已删除" } : r;
        });
      },
    });

    // 导出到真实磁盘:桌面端走 Tauri 保存对话框,网页端触发浏览器下载
    registry.define({
      name: "export_file",
      description: "把工作区文件导出到**真实磁盘**(桌面端弹保存对话框,网页端触发下载)。要落盘给用户时才用;" +
        "只是产出中间文件请用 write_file(写工作区,不需要用户干预)。",
      destructive: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内要导出的文件路径" },
          filename: { type: "string", description: "另存为的文件名(默认用 path 的文件名)" },
        },
        required: ["path"],
      },
      run: function (args) {
        var a = args || {};
        return read(a.path).then(function (r) {
          if (!r) return { ok: false, error: "文件不存在: " + normPath(a.path) };
          var name = String(a.filename || r.path.split("/").pop() || "file.txt");
          var g = (typeof globalThis !== "undefined") ? globalThis : window;
          var invoke = (g.__TAURI__ && g.__TAURI__.core && typeof g.__TAURI__.core.invoke === "function") ? g.__TAURI__.core.invoke.bind(g.__TAURI__.core) : null;
          if (invoke) {
            return invoke("export_text_file", { suggestedName: name, content: r.content })
              .then(function (p) { return { ok: true, mode: "tauri", path: p || name, bytes: r.bytes }; })
              .catch(function (e) { return { ok: false, error: "桌面端写盘失败: " + String((e && e.message) || e) }; });
          }
          try {
            var blob = new Blob([r.content], { type: "text/plain;charset=utf-8" });
            var url = URL.createObjectURL(blob);
            var el = document.createElement("a");
            el.href = url; el.download = name; el.click();
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
            return { ok: true, mode: "browser-download", filename: name, bytes: r.bytes };
          } catch (e) {
            return { ok: false, error: "下载失败: " + String((e && e.message) || e) };
          }
        });
      },
    });
  }

  window.__agentWorkspace = {
    defineTools: defineTools,
    list: list, read: read, write: write, remove: remove,
    removeByConv: removeByConv, clearAll: clearAll,
    normPath: normPath, convId: convId,
    _idb: { name: IDB_NAME, store: IDB_STORE },
  };
})();
