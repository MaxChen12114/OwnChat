// shared/save-file.js — 统一「保存文件到磁盘」出口（2026-11-11）
// ─────────────────────────────────────────────────────────────
// 根因：Android WebView（手机 Tauri 壳）不支持 <a download>，点了毫无反应 ——
// 旧版导出备份/导出 JSON 在手机壳上"无响应"就是它。桌面 Tauri 的 <a download> 也不可靠。
// 口径：检测到 Tauri → 走 Rust 侧现成命令 export_text_file（桌面弹原生保存框，Android 走系统存储；
// 复用 tts.js/agent-workspace.js 同款 invoke 约定，不新增 Rust 命令、无需重打包）；
// 网页端 → <a download> 下载。取消/失败如实返回，不把"没写盘"报成成功。
// 二进制（图片等）暂不支持 Tauri 落盘 —— 需 Rust 侧新增 export_binary_file，见夜间记录的白天提案。
(function (g) {
  "use strict";
  function tauriInvoke() {
    try {
      var t = g.__TAURI__;
      return (t && t.core && typeof t.core.invoke === "function") ? t.core.invoke.bind(t.core) : null;
    } catch (e) { return null; }
  }
  // → {ok:true, mode:"tauri", path} | {ok:true, mode:"browser", filename} |
  //   {ok:false, cancelled:true, error} | {ok:false, error}
  async function saveTextFile(text, filename) {
    var name = String(filename || "export.txt");
    var invoke = tauriInvoke();
    if (invoke) {
      try {
        var p = await invoke("export_text_file", { suggestedName: name, content: String(text == null ? "" : text) });
        if (p) return { ok: true, mode: "tauri", path: String(p) };
        return { ok: false, cancelled: true, error: "已取消保存（未写盘）" };
      } catch (e) {
        return { ok: false, error: "写盘失败: " + String((e && e.message) || e) };
      }
    }
    try {
      var blob = new Blob([String(text == null ? "" : text)], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = name; a.rel = "noopener";
      a.style.position = "fixed"; a.style.left = "-9999px"; a.style.top = "-9999px";
      document.body.appendChild(a);
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: g }));
      setTimeout(function () {
        try { if (a && a.parentNode) a.parentNode.removeChild(a); } catch (e2) {}
        try { URL.revokeObjectURL(url); } catch (e3) {}
      }, 4000);
      return { ok: true, mode: "browser", filename: name };
    } catch (e) {
      return { ok: false, error: "下载失败: " + String((e && e.message) || e) };
    }
  }
  function saveJsonFile(obj, filename) {
    var text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    var d = new Date().toISOString().slice(0, 10);
    return saveTextFile(text, filename || ("export-" + d + ".json"));
  }
  g.__saveFile = {
    saveTextFile: saveTextFile,
    saveJsonFile: saveJsonFile,
    isTauri: function () { return !!tauriInvoke(); },
  };
})(window);
