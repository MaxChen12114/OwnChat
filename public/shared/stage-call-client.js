/* public/shared/stage-call-client.js — 画布页侧的 stage_call 协议（外部页用）
   ─────────────────────────────────────────────────────────────────────
   什么时候需要它：
     · host-html（srcdoc）与 trusted（同源 URL）的画布，宿主会自动注入这段协议，
       页面**什么都不用做**，只挂 window.__stage 即可。
     · external（跨源页面）宿主注入不进去（读不到别人的 document），此时在页面里引一次：
         <script src="http://127.0.0.1:8787/shared/stage-call-client.js"></script>

   用法：
     window.__stage = { 打招呼: function(名字){ return "你好 " + 名字; } };
     之后 agent 就能 stage_call({fn:"打招呼", args:["世界"]})。

   协议（和宿主注入的那份逐字节同义）：
     收 {__panel:1, type:"call", data:{id, fn, args}}
     回 {__panel:1, type:"call-result", data:{id, ok, result | error}}
     args 是**位置参数**，等价于 fn(...args)。
   ───────────────────────────────────────────────────────────────────── */
(function () {
  if (window.__stageCall) return;
  window.__stageCall = 1;
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__panel !== 1 || d.type !== "call") return;
    var id = d.data && d.data.id, fn = d.data && d.data.fn;
    var reply = function (ok, v) {
      try {
        parent.postMessage({ __panel: 1, type: "call-result", data: {
          id: id, ok: ok,
          result: ok ? v : undefined,
          error: ok ? undefined : String((v && v.message) || v)
        } }, "*");
      } catch (_e) {}
    };
    var f = window.__stage && window.__stage[fn];
    if (typeof f !== "function") {
      return reply(false, "这个页面没有注册函数「" + fn + "」。可用：" + (Object.keys(window.__stage || {}).join(" / ") || "（无）"));
    }
    try {
      var a = d.data.args;
      var out = f.apply(null, (a == null) ? [] : (Array.isArray(a) ? a : [a]));
      if (out && typeof out.then === "function") out.then(function (x) { reply(true, x); }, function (er) { reply(false, er); });
      else reply(true, out);
    } catch (er) { reply(false, er); }
  });
})();
