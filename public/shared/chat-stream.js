// public/shared/chat-stream.js — /api/chat 流式调用统一实现（公开版：无 persona/底座字段）
// 契约：window.__chatStream = { v:1, modeForModel(model), buildBody(opts), call(opts) -> Promise<string> }
(function (global) {
  "use strict";
  if (global.__chatStream && global.__chatStream.v === 1) return;
  function modeForModel(model) {
    var fast = global.APP_MODELS_FAST || [];
    for (var i = 0; i < fast.length; i++) {
      var id = (typeof fast[i] === "string") ? fast[i] : (fast[i] && fast[i].id);
      if (id && id === model) return "fast";
    }
    return "free";
  }
  function buildBody(opts) {
    opts = opts || {};
    return {
      mode: opts.mode || modeForModel(opts.model),
      model: opts.model || undefined,
      promptProfile: opts.profile || "assist",
      use_builtin_persona: false,
      custom_system_prompt: opts.system || "",
      thinking: opts.thinking || "disabled",
      messages: opts.messages || [{ role: "user", content: opts.user || "" }]
    };
  }
  async function call(opts) {
    opts = opts || {};
    var r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(opts)),
      signal: opts.signal
    });
    if (!r.ok) {
      var t = "";
      try { t = await r.text(); } catch (e) {}
      throw new Error("服务返回 " + r.status + (t ? (" · " + t.slice(0, 160)) : ""));
    }
    if (!r.body) throw new Error("服务未返回流式内容");
    var reader = r.body.getReader(), dec = new TextDecoder(), buf = "", full = "";
    while (true) {
      var rd = await reader.read();
      if (rd.done) break;
      buf += dec.decode(rd.value, { stream: true });
      var i;
      while ((i = buf.indexOf("\n")) >= 0) {
        var line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line || line.charAt(0) === ":") continue;
        if (line.indexOf("data:") !== 0) continue;
        var data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          var j = JSON.parse(data);
          var d = j && j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (d) { full += d; if (opts.onDelta) opts.onDelta(full); }
        } catch (e) {}
      }
    }
    return full;
  }
  global.__chatStream = { v: 1, modeForModel: modeForModel, buildBody: buildBody, call: call };
})(typeof globalThis !== "undefined" ? globalThis : window);
