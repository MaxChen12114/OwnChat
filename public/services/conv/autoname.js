(function () {
/**
 * Conversation naming, in two stages: a free local derivation from the first user message, then an
 * optional one-shot summary once the first reply lands. The local stage exists so the list is never
 * showing "New chat" while a request is in flight; the model stage only improves on it.
 *
 * Three invariants, all of them load-bearing:
 *  - Only `新对话` is ever renamed. The main conversation must keep its literal name, because the
 *    registry dedupe and cross-device identification both match on it.
 *  - A manual rename is never overwritten. There is no extra meta flag for this: a name that is
 *    neither the default nor what the local rule would derive counts as manual.
 *  - Every write goes through the app's rename, which touches the conversation and records the
 *    sync meta event. Writing storage here would bypass both.
 *
 * The local derivation is a pure function of the text on purpose: recomputing it after a reload
 * must give the same string, which is how a name written by this module is recognised later.
 * @module services/conv/autoname
 */

                            
                                      
                                            
 

                              
                                                             
                                                                                      
 

                                
                     
                               
                                                
 

                                 
                       
                  
                     
                                    
                                     
                                                             
                                               
                                                     
                     
                       
                                
                                  
                 
 

                                   

/** object to Record, bridged through Object.entries; shallow copy, no assertion. */
function toRecord(o        )                          {
  const out                          = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}

function createAutoname(ports               )                 {
  const storage = ports.storage;
  const LS_CONV_META = "cfw_conv_meta_v1";   // 与 conv-store 的键名契约一致
  const LS_CHAT_SESSION = "cfw_chat_session_v1";
  const LS_OFF = "cfw_autoname_off_v1";
  const LS_AI = "cfw_autoname_ai_v1";
  const DEFAULT_NAME = "新对话";
  const MAX_LEN = 20;

  const SYS_PROMPT = "你是中文会话命名助手。根据下面一段对话的开头，给这个会话起一个简短、具体、能一眼看出主题的中文名称，8 到 20 个字。" +
    "直接输出名称本身，不要引号、书名号、编号、结尾标点或任何解释；不要输出「对话」「会话」「新对话」这类泛词。";

  // One local write and one refine per conversation: pacing, retries and multiple call sites can
  // all fire twice, and each duplicate is a wasted request.
  const _localNames = new Map                ();
  const _refined = new Set        ();

  function readLs(k        )                { try { return storage.getItem(k); } catch { return null; } }
  function writeLs(k        , v        )       { try { storage.setItem(k, v); } catch {} }
  function enabled()          { return readLs(LS_OFF) !== "1"; }
  function aiEnabled()          { return enabled() && readLs(LS_AI) !== "0"; }
  function setEnabled(on         )       { writeLs(LS_OFF, on ? "0" : "1"); }
  function setAiEnabled(on         )       { writeLs(LS_AI, on ? "1" : "0"); }

  function loadConvMeta()                                          {
    try {
      const m          = JSON.parse(storage.getItem(LS_CONV_META) || "{}");
      if (typeof m !== "object" || m === null || Array.isArray(m)) return {};
      const out                                          = {};
      for (const [k, v] of Object.entries(m)) {
        out[k] = (typeof v === "object" && v !== null) ? toRecord(v) : {};
      }
      return out;
    } catch { return {}; }
  }
  function nameOf(convId        )         {
    const m = loadConvMeta()[convId];
    return ((m && String(m.name || "")) || "");
  }
  function isConvId(id        )          { return typeof id === "string" && id.indexOf("c_") === 0; }

  // Stage one: pure derivation from the text, stable across reloads.
  function localTitle(text         )         {
    let s = String(text == null ? "" : text);
    s = s.replace(/```[\s\S]*?```/g, " ")            // 代码块
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")         // markdown 图片
      .replace(/\bhttps?:\/\/\S+/g, " ")             // 裸链接
      .replace(/@[\w\u4e00-\u9fa5_-]{1,20}\s*/g, "") // @提及
      .replace(/<[^>]{1,80}>/g, " ")                 // xml/标签残留
      .replace(/\s+/g, " ")
      .trim();
    if (!s) return "";
    // Prefer the first sentence, unless it is too short to say anything ("你好", "在吗") — then
    // keep more of the text.
    const cut = s.search(/[。！？!?；;，,\n]/);
    if (cut >= 6) s = s.slice(0, cut);
    s = s.replace(/^[\s"'“‘「【《(（#*>\-]+/u, "")
      .replace(/[\s"'”’」】》>。！？!?、,，:：;；\-*#]+$/u, "")
      .trim();
    if (!s) return "";
    // Punctuation, emoji or digits alone make no usable title.
    if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(s)) return "";
    if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN).replace(/[\s,，、]+$/u, "") + "…";
    return s;
  }

  // Stage two: strip what models habitually wrap a title in — quotes, numbering, a "标题：" prefix,
  // or a whole explanatory sentence.
  function cleanAiTitle(out         )         {
    let s = String(out == null ? "" : out).split("\n")[0] || "";
    s = s.replace(/^\s*#+\s*/, "")
      .replace(/^\s*(标题|会话名|名称|名字)\s*[:：]\s*/u, "")
      .replace(/^\s*\d+\s*[\.、)）]\s*/u, "")
      .replace(/^\s*[-*·]\s*/u, "")
      .replace(/^[\["'“‘「『《<{]+/u, "")
      .replace(/[\]"'”’」』》>}]+$/u, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!s || s === DEFAULT_NAME || s === "主对话") return "";
    if (s.length > 40) return "";                    // 明显是整段解释而不是名字
    if (/^(好的|以下是|根据|抱歉|作为|这是|无法|标题是|我(?:建议|为你|认为))/u.test(s)) return "";
    if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(s)) return "";
    if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN).replace(/[\s,，、]+$/u, "") + "…";
    return s;
  }

  function isAutoName(name         , firstUserText         )          {
    const n = String(name || "");
    if (n === DEFAULT_NAME) return true;
    const lt = localTitle(firstUserText);
    return !!lt && n === lt;                        // 仍是本模块 ① 写的本地名
  }
  function stillAuto(convId        , name         , firstUserText         )          {
    return isAutoName(name, firstUserText) || _localNames.get(convId) === name;
  }

  function apply(convId        , name        )          {
    const a = ports.getApp();
    if (!a || typeof a.renameConversation !== "function") return false;
    try {
      a.renameConversation(convId, name);           // touchConv + recordConv(...,"meta") 云同步
      const list = ports.getConvList();
      if (list && typeof list.refresh === "function") list.refresh();
      return true;
    } catch { return false; }
  }

  function firstOf(arr         , role        )         {
    if (!Array.isArray(arr)) return "";
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      if (!m || typeof m !== "object") continue;
      const rec = toRecord(m);
      if (rec._uiOnly || rec.role !== role) continue;
      const c = String(rec.content == null ? "" : rec.content).replace(/\s+/g, " ").trim();
      if (c) return c;
    }
    return "";
  }
  function readMessages(convId        )        {
    try {
      const all          = JSON.parse(storage.getItem(LS_CHAT_SESSION) || "{}");
      if (typeof all !== "object" || all === null) return [];
      const slot = toRecord(all)[convId];
      return Array.isArray(slot) ? slot : [];
    } catch { return []; }
  }

  // Called right after the first user message: synchronous, no request.
  function local(convId        , text         )         {
    if (!enabled() || !isConvId(convId) || _localNames.has(convId)) return "";
    if (nameOf(convId) !== DEFAULT_NAME) return "";  // 主对话 / 手动改过名 → 不动
    const t = localTitle(text);
    if (!t) return "";
    _localNames.set(convId, t);
    if (nameOf(convId) !== DEFAULT_NAME) return "";
    return apply(convId, t) ? t : "";
  }

  // Called after the first reply is stored: asynchronous, never blocks the UI. The caller may pass
  // the array it already has — the user can switch conversations mid-flight, so "the current
  // session" is not a safe source.
  function refine(convId        , sessionArr          )       {
    if (!aiEnabled() || !isConvId(convId) || _refined.has(convId)) return;
    const arr = Array.isArray(sessionArr) ? sessionArr : readMessages(convId);
    const first = firstOf(arr, "user");
    const reply = firstOf(arr, "assistant");
    if (!first && !reply) return;
    if (!loadConvMeta()[convId]) return;            // 会话已被删除
    if (!stillAuto(convId, nameOf(convId), first)) return; // 用户已手动改名 → 放弃
    _refined.add(convId);

    const input = "对话开头：\n用户：" + first.slice(0, 800) + "\n助手：" + reply.slice(0, 800);
    const app = ports.getApp();
    const oneShot = app && app.oneShot;
    if (typeof oneShot !== "function") return;      // 老版本：保留本地名即可
    Promise.resolve()
      .then(function () { return oneShot({ system: SYS_PROMPT, user: input, timeoutMs: 20000 }); })
      .then(function (out) {
        const t = cleanAiTitle(out);
        if (!t || t === localTitle(first)) return;
        // Race window: the user may have renamed, deleted, or another device may have synced a
        // new name while the request was in flight.
        if (!loadConvMeta()[convId]) return;
        if (!stillAuto(convId, nameOf(convId), first)) return;
        apply(convId, t);
      })
      .catch(function () { /* 静默降级：本地名保留，不打扰用户 */ });
  }

  return {
    DEFAULT_NAME, MAX_LEN, SYS_PROMPT,
    localTitle, cleanAiTitle, isAutoName,
    local, refine,
    enabled, aiEnabled, setEnabled, setAiEnabled,
    _reset() { _localNames.clear(); _refined.clear(); },
  };
}

// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);
  if (G.__convAutoname) return;
  var ports = {
    storage: { getItem: function (k) { return G.localStorage.getItem(k); }, setItem: function (k, v) { G.localStorage.setItem(k, v); } },
    getApp: function () { return G.appSvc || null; },
    getConvList: function () { return G.__convList || null; },
  };
  G.__convAutoname = createAutoname(ports);
})();

globalThis.createAutoname = createAutoname;
})();
