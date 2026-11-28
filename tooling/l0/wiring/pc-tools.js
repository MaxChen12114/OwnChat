// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/local/pc-tools.ts; this file owns the
// gate storage, the Web/desktop split, both timeout layers and the four image hooks.
//
// The desktop path is not an optimisation: the request runs in Rust, so it never meets CORS, and it
// keeps working when the tunnel is down. Shell detection is re-run per call instead of snapshotted
// at load, because the shell injects late on some hosts and a snapshot would pin the Web path.
(function () {
  "use strict";
  if (window.__pcTools) return;

  const LS_ENABLED = "cfw_pc_enabled_v1";
  const LS_UNLOCKED = "cfw_unlocked_v1";
  const LS_TOKEN = "cfw_unlock_token_v1";
  const LS_AUTH = "cfw_auth_token_v1";
  const LS_BRIDGE_TOKEN = "cfw_pc_bridge_token_v1";
  const BRIDGE_BASE = "http://127.0.0.1:8802";
  const CALL_TIMEOUT_MS = 45000;

  function unlocked() {
    try { return localStorage.getItem(LS_UNLOCKED) === "1"; } catch (error) { return false; }
  }
  function enabled() {
    try { return localStorage.getItem(LS_ENABLED) === "1"; } catch (error) { return false; }
  }
  function token() {
    try { return localStorage.getItem(LS_TOKEN) || localStorage.getItem(LS_AUTH) || ""; } catch (error) { return ""; }
  }
  function bridgeToken() {
    try { return localStorage.getItem(LS_BRIDGE_TOKEN) || ""; } catch (error) { return ""; }
  }
  function tauriInvoke() {
    try {
      return window.tauriSvc ? window.tauriSvc.invokeOrNull() : null;
    } catch (error) { return null; }
  }
  function directMode() { return !!(tauriInvoke() && bridgeToken()); }
  function gate() {
    return { unlocked: unlocked(), enabled: enabled(), hasInvoke: !!tauriInvoke(), token: token(), bridgeToken: bridgeToken() };
  }
  function ready() { return pcReady(gate()); }

  function setEnabled(on) {
    try { localStorage.setItem(LS_ENABLED, on ? "1" : "0"); } catch (error) { /* storage denied: the switch stays as it was */ }
  }
  function setBridgeToken(value) {
    try {
      if (value) localStorage.setItem(LS_BRIDGE_TOKEN, String(value).trim());
      else localStorage.removeItem(LS_BRIDGE_TOKEN);
    } catch (error) { /* storage denied: the token stays as it was */ }
  }

  // Both transports get a hard deadline. A dead tunnel, a wedged bridge or a Rust client without a
  // timeout used to hang the agent loop forever on this tool; from the outside that reads as
  // "the agent is stuck", with no failing call to point at.
  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise(function (_resolve, reject) {
        timer = setTimeout(function () {
          reject(new Error((label || "远程电脑请求") + "超时（" + Math.round((ms || CALL_TIMEOUT_MS) / 1000) + "s）"));
        }, ms || CALL_TIMEOUT_MS);
      }),
    ]).finally(function () { try { clearTimeout(timer); } catch (error) { /* timer already fired */ } });
  }
  async function fetchT(url, init, ms) {
    const controller = new AbortController();
    const timer = setTimeout(function () { try { controller.abort(); } catch (error) { /* already aborted */ } }, ms || CALL_TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, init || {}, { signal: controller.signal }));
    } catch (error) {
      if (error && error.name === "AbortError") throw new Error("远程电脑请求超时（" + Math.round((ms || CALL_TIMEOUT_MS) / 1000) + "s）");
      throw error;
    } finally {
      try { clearTimeout(timer); } catch (error) { /* timer already fired */ }
    }
  }

  async function tauriHttp(op, opts) {
    const invoke = tauriInvoke();
    if (!invoke) throw new Error("Tauri 环境不可用");
    const headers = { "x-pc-token": bridgeToken() };
    let body;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const response = await withTimeout(invoke("http_request", {
      method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
      url: BRIDGE_BASE + "/pc" + op,
      headers: headers,
      body: body,
    }), CALL_TIMEOUT_MS, "远程电脑请求");
    const binary = atob(response.body_base64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { status: response.status || 0, contentType: response.content_type || "", bytes: bytes, headers: response.headers || {} };
  }
  function parseErr(text, status) {
    try {
      const data = recOf(JSON.parse(text));
      return new Error(data.error || ("HTTP " + status));
    } catch (error) {
      return new Error("HTTP " + status);
    }
  }

  async function api(op, opts) {
    const options = opts || {};
    if (!ready()) throw new Error("远程电脑未启用或未解锁");
    if (tauriInvoke() && bridgeToken()) {
      const direct = await tauriHttp(op, options);
      const text = new TextDecoder("utf-8").decode(direct.bytes);
      if (direct.status >= 400) throw parseErr(text, direct.status);
      try { return JSON.parse(text); } catch (error) { return text; }
    }
    const headers = { authorization: "Bearer " + token() };
    const init = { method: options.method || (options.body !== undefined ? "POST" : "GET"), headers: headers };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await fetchT("/api/pc" + op, init, CALL_TIMEOUT_MS);
    let data = null;
    try { data = await withTimeout(response.json(), 20000, "读取远程电脑响应"); } catch (error) { data = null; }
    if (!response.ok) throw new Error((data && data.error) || ("HTTP " + response.status));
    return data;
  }

  async function apiBlob(op) {
    if (!ready()) throw new Error("远程电脑未启用或未解锁");
    if (tauriInvoke() && bridgeToken()) {
      const direct = await tauriHttp(op, {});
      if (direct.status >= 400) throw parseErr(new TextDecoder("utf-8").decode(direct.bytes), direct.status);
      return {
        blob: new Blob([direct.bytes], { type: direct.contentType || "image/jpeg" }),
        width: direct.headers["x-pc-width"], height: direct.headers["x-pc-height"],
        sourceWidth: direct.headers["x-pc-source-width"], sourceHeight: direct.headers["x-pc-source-height"],
      };
    }
    const response = await fetchT("/api/pc" + op, { headers: { authorization: "Bearer " + token() } }, CALL_TIMEOUT_MS);
    if (!response.ok) {
      let message = "HTTP " + response.status;
      try {
        const data = await withTimeout(response.json(), 20000, "读取远程电脑响应");
        if (data && data.error) message = data.error;
      } catch (error) { /* body was not JSON: keep the status line */ }
      throw new Error(message);
    }
    const blob = await withTimeout(response.blob(), CALL_TIMEOUT_MS, "读取截图");
    return { blob: blob, width: response.headers.get("x-pc-width"), height: response.headers.get("x-pc-height"), sourceWidth: response.headers.get("x-pc-source-width"), sourceHeight: response.headers.get("x-pc-source-height") };
  }

  function visionOn(ctx) {
    return (ctx && typeof ctx.__visionOn === "boolean") ? ctx.__visionOn : window.__agentVisionOn;
  }
  function readDataUrl(blob) {
    return new Promise(function (resolve) {
      try {
        const reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || "")); };
        reader.onerror = function () { resolve(""); };
        reader.readAsDataURL(blob);
      } catch (error) { resolve(""); }
    });
  }
  async function putBlob(id, blob) {
    try {
      const attach = window.attachSvc;
      if (!attach || typeof attach.putBlob !== "function") return false;
      return !!(await attach.putBlob(id, blob));
    } catch (error) { return false; }
  }
  function appendImage(meta, ctx) {
    try {
      if (typeof window.__pcAppendImage !== "function") return false;
      return !!window.__pcAppendImage(meta, ctx);
    } catch (error) { return false; }
  }
  function showBubble(blob, meta, ctx) {
    let url = "";
    let shown = false;
    try { url = URL.createObjectURL(blob); } catch (error) { return false; }
    try {
      if (typeof window.__agentImageBubble === "function") {
        window.__agentImageBubble(url, { source: meta.source, kind: "screenshot" }, ctx);
        shown = true;
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (error) { /* already revoked */ } }, 5 * 60 * 1000);
      }
    } catch (error) { shown = false; }
    if (!shown) { try { URL.revokeObjectURL(url); } catch (error) { /* never created */ } }
    return shown;
  }
  function pushImage(dataUrl, size, ctx) {
    try {
      if (typeof window.__agentPushImage !== "function") return false;
      return !!window.__agentPushImage(dataUrl, { w: size.w, h: size.h }, ctx);
    } catch (error) { return false; }
  }

  const ports = {
    gate: gate,
    call: api,
    callBlob: apiBlob,
    visionOn: visionOn,
    readDataUrl: readDataUrl,
    putBlob: putBlob,
    appendImage: appendImage,
    showBubble: showBubble,
    pushImage: pushImage,
    imageId: function () { return pcImageId(Date.now(), Math.random()); },
    clockLabel: function () { return new Date().toLocaleTimeString("zh-CN", { hour12: false }); },
  };

  window.__pcTools = {
    defineTools: function (registry) { return definePcTools(registry, ports); },
    ready: ready,
    enabled: enabled,
    setEnabled: setEnabled,
    setBridgeToken: setBridgeToken,
    bridgeToken: bridgeToken,
    isTauri: function () { return !!tauriInvoke(); },
    directMode: directMode,
    api: api,
    __v: 2,
  };
})();
