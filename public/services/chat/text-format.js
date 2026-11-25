(function () {
/**
 * Body-text sanitizing: jailbreak sentinels, think blocks, residual markup, WeChat splitting.
 *
 * Every window bridge arrives as a port (storage for the strip switch, sceneNames for group name
 * tags, stripPhotoSignal / applyAmbientTags / extractPhotoSignal for the image and ambience signals);
 * the adapters and all their try/catch semantics live in l0/wiring/text-format.js, and each bridge is
 * still looked up at call time rather than captured up front.
 *
 * Red line carried over from the old comment: never touch the unlock prompt. The model keeps emitting
 * the [^420]/[^69] sentinels; this module only lifts them out of the body and files them into the fold.
 * Fail-open: the body can always be recovered from the fold, and an empty bubble or a swallowed body is
 * never acceptable.
 *
 * Equivalence: test/text-format.test.mjs plus the golden fingerprint in test/pipeline.test.mjs.
 * @module services/chat/text-format
 */

/** Key-value storage port: window.localStorage in the browser, a Map in the Node tests. */
                            
                                      
                                            
 

/** Environment ports; all window-bridge try/catch semantics belong to the wiring layer. */
                                  
                     
                                                                                                                 
                         
                                                                                                         
                                         
                                                                                       
                                                             
                                                                  
                                                                                                
 

/** What splitJailbreakPrefix returns: body is shown to the user, thinking goes into the fold. */
                              
               
                   
 

/** Callback bundle for finalizeReply, all optional and all injected by the caller. */
                                  
                                
                                                               
                                                                                                                 
                         
                                    
                                                                                             
                            
                                           
                           
 

/** What finalizeReply returns; photoSig and photoKind are handed back so the caller can fire the image. */
                                 
               
                        
                         
                    
                     
                         
 

                                    
               
                         
 

/** Create the text-format service. The browser wiring layer passes window bridges, Node tests pass stubs. */
function createTextFormat(ports                 ) {
  const LS_JAILBREAK_STRIP = "cfw_jailbreak_strip_v1";

  function isJailbreakStripOn()          {
    return (ports.storage.getItem(LS_JAILBREAK_STRIP) ?? "1") === "1";
  }
  // The settings entry point stays with the module (app.js's __dev.setJailbreakStripOn forwards here) so the LS key has one owner
  function setJailbreakStripOn(on         )       {
    ports.storage.setItem(LS_JAILBREAK_STRIP, on ? "1" : "0");
  }

  // Jailbreak thinking-prefix strip, switchable in developer mode via cfw_jailbreak_strip_v1.
  // The RP-Hub unlock base preset prepends "[^69]: Complaintless complete fulfillment:", which pollutes
  // the body: everything before the sentinel (pseudo-token thinking) is cut and only the rest survives.
  // With no sentinel matched the input comes back untouched, so replies without a prefix are never damaged.
  // 4.18 fix v3, root cause: the model emits
  //   [^420]: I am not deepseek. ...            <- jailbreak echo (first sentinel)
  //   <a long block of thinking, no sentinel prefix>
  //   [^69]: Complaintless complete fulfillment: <- last sentinel = start of the final reply
  //   (the reply the user should actually see)
  // The old version stripped only the sentinel lines at the very start, so the middle thinking, the
  // trailing sentinel and the body all stayed in the bubble. Now it finds the *last* [^xxx]: line and
  // cuts after it, so thinking can never leak. No sentinel at all means an untouched return.
  // 4.70 rewrite: from "delete the thinking" to "split and capture", returning { body, thinking }.
  function splitJailbreakPrefix(text        )              {
    if (!text || !isJailbreakStripOn()) return { body: text, thinking: "" };
    // Sentinel: [optional ^ + any digits] + colon + rest of line (up to \n or ||). "[发图:]" is not hit
    // because what follows the bracket is a word, not a digit.
    const re = /\[\^?\d*\][:：][^\n|]*/g;
    let firstStart = -1, lastEnd = -1;
    let m                        ;
    while ((m = re.exec(text)) !== null) {
      if (firstStart < 0) firstStart = m.index;
      lastEnd = m.index + m[0].length;
    }
    // 2026-10-05 tightening: the sentinel must sit at the very start of the reply. A real sentinel is
    // among the first lines; a "[1]: footnote" mid-body is not one, and the old version moved it into the
    // thinking fold. Only whitespace may precede the first sentinel, otherwise the whole rule is disabled
    // (it degrades to "no sentinel", which also keeps the heuristic below from arming).
    if (firstStart >= 0 && text.slice(0, firstStart).trim() !== "") { firstStart = -1; lastEnd = -1; }
    let thinking = "";
    let s = text;
    if (firstStart >= 0) {
      thinking = text.slice(firstStart, lastEnd);
      s = (text.slice(0, firstStart) + "\n" + text.slice(lastEnd)).replace(/^[\s\r\n]+/, "");
    }
    // Heuristic fallback, tightened again on 2026-10-05: it arms only when a sentinel really was cut at
    // the start. ENI-family bases emit no sentinel at all yet their prose often contains words like
    // injection or compliance; with no leading sentinel not a single character is touched.
    const JB_PHRASE = /disregard|injection|fulfillment|complaint|not deepseek|i'?m not deep|i am not deep|jailbreak|unfiltered|no restriction/i;
    if (firstStart >= 0) {
      const _lns = s.split("\n");
      let _i = 0;
      for (; _i < _lns.length; _i++) {
        const _ln = _lns[_i].trim();
        if (_ln === "") continue;            // blank line: a separator only, never judged as residue
        if (JB_PHRASE.test(_ln)) continue;   // jailbreak boilerplate: filed into the thinking fold
        break;
      }
      if (_i > 0) {
        thinking += (thinking ? "\n" : "") + _lns.slice(0, _i).join("\n");
        s = _lns.slice(_i).join("\n").replace(/^[\s\r\n]+/, "");
      }
    }
    // Leftover sentinel fragments from a network truncation: a half [digits] / [digits / ^digits]
    s = s.replace(/\[\^?\d[0-9A-Za-z_]{1,11}\]/g, "");
    s = s.replace(/\[\^?\d[0-9A-Za-z_]{0,11}$/g, "");
    s = s.replace(/(^|[^A-Za-z0-9])\^\d[0-9A-Za-z_]{0,11}\]/g, "$1");
    s = s.replace(/^[\s\r\n]+/, "");
    const body = s.trim() ? s : "";
    // fail-open: emptied by the heuristic with no real sentinel means restore the original — better to leak
    // a little thinking than to swallow the body or leave an empty bubble
    if (!body && firstStart < 0) return { body: text, thinking: "" };
    return { body, thinking: thinking.trim() };
  }

  // Backwards compatibility: old call sites only want the body. Everything routes through splitJailbreakPrefix.
  function stripJailbreakPrefix(text        )         {
    if (!text || !isJailbreakStripOn()) return text;
    return splitJailbreakPrefix(text).body;
  }

  // 2026-05-30 / 4.25: in fishbowl mode the AI sometimes prepends its own speaker label
  // ("【高冷(女)】" / "冷(女)】" leaking into the bubble). Only a leading label is stripped, and it must
  // carry a gender marker or match a scene member name, so that "[action]" prose in the body survives.
  function stripSceneSpeakerLabel(text        )         {
    if (!text) return text;
    const sceneNames = ports.sceneNames();
    let s = text.replace(/^[\s\r\n]+/, "");
    for (let i = 0; i < 2; i++) {
      const m = s.match(/^[^\n]{0,16}?[】\]]\s*[:：]?\s*/);
      if (!m) break;
      const head = m[0];
      const hasGender = /[（(][男女][)）]/.test(head);
      const matchesName = sceneNames.some(function (n) { return head.includes(n); });
      if (!hasGender && !matchesName) break;
      s = s.slice(head.length);
    }
    return s.trim() || text;
  }

  // 2026-05-30 / 4.25 (5): fallback strip of <think>...</think> blocks. Some models, the free/NVIDIA
  // route especially, put their reasoning in the body without a [^sentinel] prefix, so
  // stripJailbreakPrefix misses it and the thinking leaks into the bubble.
  function stripThinkBlocks(text        )         {
    if (!text) return text;
    let s = text;
    // A closed block, possibly spanning lines: remove it whole
    s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
    // An unclosed <think> at the start (no </think> yet, or truncated): cut to the end
    s = s.replace(/^\s*<think(?:ing)?>[\s\S]*$/i, "");
    // Leftover orphan tags
    s = s.replace(/<\/?think(?:ing)?>/gi, "");
    return s.trim() || text;
  }

  // 2026-05-31 / 4.47: strip the image signal live, the way <think> is stripped, including a truncated
  // half signal, so it never flashes inside the bubble while streaming
  function stripPhotoSignalLive(text        )         {
    if (!text) return text;
    return ports.stripPhotoSignal(text);
  }

  // 2026-05-31 / 4.47: in WeChat mode drop action and stage directions ("（...）", "(...)", "*...*") —
  // a real person only sends chat text (the prompt asks for it; this is the safety net).
  // 4.59 residual sweep: when the model mangles [发图:..]/[好感±N]/[next:..] it leaves empty "[]", a lone "]",
  // or a numberless "[好感]". Paired brackets with content (the WeChat emoji code "[害羞]") are left alone.
  function stripUnpairedSquareBrackets(s        )         {
    const open           = [];
    const remove = new Set        ();
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "[") open.push(i);
      else if (ch === "]") { if (open.length) open.pop(); else remove.add(i); }
    }
    for (const i of open) remove.add(i);
    if (!remove.size) return s;
    let out = "";
    for (let i = 0; i < s.length; i++) if (!remove.has(i)) out += s[i];
    return out;
  }

  function stripResidualMarkup(text        )         {
    if (!text) return text;
    let s = text;
    // 1. Empty brackets [] and full-width variants
    s = s.replace(/[\[【]\s*[\]】]/g, "");
    // 2. Mangled affection tags: [好感] / [好感±]. A well-formed [好感±N] is handled by parseAffectionTag;
    //    this clears the numberless remains
    s = s.replace(/[\[【]\s*好感[^\]】\n]*[\]】]/g, "");
    // 3. Empty signal keywords with no colon and no payload
    s = s.replace(/[\[【]\s*(发图|发景|发|next|end|召唤)\s*[\]】]/gi, "");
    // 3.5 Mangled image signals, where [发图:..]/[发景:..] fell apart.
    // 4.70 tightening, after the body was being cut: the keyword must be intact, or "发" followed by a
    // colon. Ordinary prose like [发呆]/[发抖]/[发现...] is never touched.
    s = s.replace(/[\[【]\s*(?:发(?:图|景)[:：]?|发[:：])[^\[\]【】\n]{3,}[\]】]/g, "");
    // 3.6 Mangled structured signal "[[img|...]]" (when a bracket went missing and chat-image's tolerant
    // regex still let it through): clear the leftover shell
    s = s.replace(/\[{1,2}\s*img\s*\|[^\[\]\n]*\]{0,2}/gi, "");
    // 3.7 Ambience tags "[[amb:...]]" / "[[mus:...]]" / "[[voice:...]]": the normal path already executed
    // and stripped them (see applyAmbientTags). This is the clear-only fallback for aborted streams and group
    // chat — better to miss one ambience switch than to leak the tag into the bubble.
    s = s.replace(/\[\[\s*(?:amb|mus|music|bgm|voice)\s*[:：][^\[\]\n]*\]\]/gi, "");
    // 4. Lone square brackets (one half of a signal left behind)
    s = stripUnpairedSquareBrackets(s);
    // Finish: drop empty consecutive segments and collapse runs of spaces
    s = s.split("||").map(function (p) { return p.trim(); }).filter(Boolean).join("||");
    return s.replace(/[ \t]{2,}/g, " ").trim();
  }

  function stripWechatActions(text        )         {
    if (!text) return text;
    let s = text;
    s = s.replace(/（[^（）]*）/g, "");
    s = s.replace(/\([^()]*\)/g, "");
    s = s.replace(/\*[^*\n]+\*/g, "");
    // Collapse the empty segments and extra spaces left behind
    s = s.split("||").map(function (p) { return p.trim(); }).filter(Boolean).join("||");
    s = s.replace(/[ \t]{2,}/g, " ").trim();
    return s || text;
  }

  // 2026-05-30 / 4.25 (9): WeChat fallback splitting. When the model ignored "||" and produced one long
  // paragraph, cut at sentence-ending punctuation so the reply does not suddenly become a wall of text.
  // Only splits when the text is clearly long (>40 chars and at least two pieces); else "" means "no split".
  function autoSplitWechat(text        )         {
    if (!text) return "";
    const t = text.trim();
    if (t.length <= 40) return "";
    const segs = t.match(/[^。！？!?…\n]+[。！？!?…]*[”"』」]?|\n+/g);
    if (!segs) return "";
    const pieces = segs.map(function (s) { return s.trim(); }).filter(function (s) { return s && !/^\n+$/.test(s); });
    if (pieces.length < 2) return "";
    const merged           = [];
    for (const p of pieces) {
      if (merged.length && (merged[merged.length - 1].length + p.length) <= 30) {
        merged[merged.length - 1] += p;
      } else {
        merged.push(p);
      }
    }
    if (merged.length < 2) return "";
    return merged.join("||");
  }

  // 2026-06-24 display-layer voice tags: strip leading and inline "[emotion:intensity]" / "[scene:x]" /
  // "[tone:x]". Only the "key:value" form matches, so a WeChat emoji code like [害羞] or an option shell
  // like [选项] — brackets without a colon — is never touched.
  function stripVoiceTags(text        )         {
    if (!text) return text;
    let s = String(text).replace(/\[\s*[^\[\]:：\n]{1,8}\s*[:：]\s*[^\[\]\n]{0,12}\s*\]/g, "");
    s = s.split("||").map(function (p) { return p.trim(); }).filter(Boolean).join("||");
    return s.replace(/[ \t]{2,}/g, " ").trim();
  }

  // 2026-06-24 display-layer choice signals, dev probe only: strip [选项]...[/选项] and [opt]...[/opt]
  // blocks. A plain bracket without a colon, such as the WeChat emoji code [害羞], is not a choice signal.
  function stripChoiceSignals(text        )         {
    if (!text) return text;
    let s = String(text)
      .replace(/\[选项\][\s\S]*?\[\/选项\]/g, "")
      .replace(/\[opt\][\s\S]*?\[\/opt\]/gi, "");
    s = s.split("||").map(function (p) { return p.trim(); }).filter(Boolean).join("||");
    return s.replace(/[ \t]{2,}/g, " ").trim();
  }

  // 2026-06-15 cleaning-pipeline probe: lets the dev panel see which stage cut the body. Read-only.
  function diffPrefixSuffix(a         , b         )                                     {
    const A = String(a == null ? "" : a);
    const B = String(b == null ? "" : b);
    const max = Math.min(A.length, B.length);
    let p = 0;
    while (p < max && A[p] === B[p]) p++;
    let s = 0;
    while (s < (max - p) && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
    return { removed: A.slice(p, A.length - s), added: B.slice(p, B.length - s) };
  }

  // A33(1): the sendOne end-of-stream pipeline, merged in from engine/app.js 2503-2560 on 2026-11-13 with
  // no behaviour change. Every text transformation applied to one reply once streaming ends, in the original
  // order: 1 archive the thinking, 2 affection tag, 3 ambience tags, 4 WeChat image signal, 5 snapshot for
  // replyForEngine, 6 group speaker label plus [next:X]/[end]/[召唤:X] strip, 7 residual bracket sweep.
  // No DOM in the module: the original re-rendered the bubble after each change, which is now the onRender
  // callback. extractInlineThink/buildArchive are bound to __reasoning by the caller, parseAffectionTag and
  // adjustAffection to the character card inside app.js's closure, so this module stays dependency-free.
  async function finalizeReply(full0         , o                         )                          {
    o = o || {};
    const render = typeof o.onRender === "function" ? o.onRender : function () {};
    let full = String(full0 == null ? "" : full0);

    // 1. Thinking archive and strip. Renders unconditionally: the 70ms streaming throttle can drop the last segment (4.74)
    const _inlineThink = (typeof o.extractInlineThink === "function") ? (o.extractInlineThink(full) || "") : "";
    const _split = splitJailbreakPrefix(stripThinkBlocks(full));
    const reasonArchive = (typeof o.buildArchive === "function") ? (o.buildArchive(o.fullReasoning || "", _inlineThink, _split.thinking) || "") : "";
    if (typeof o.onArchive === "function") o.onArchive(reasonArchive);
    full = _split.body;
    render(full);

    // 2. Affection tag: the delta is reported back for bookkeeping while the strip applies in place
    let affectionDelta = 0;
    if (typeof o.parseAffectionTag === "function") {
      const tagRes = o.parseAffectionTag(full);
      if (tagRes && tagRes.delta) {
        if (o.affectionActive && typeof o.adjustAffection === "function") {
          try { await o.adjustAffection(tagRes.delta); } catch (e) {}
          affectionDelta = tagRes.delta;
        }
      }
      if (tagRes && typeof tagRes.stripped === "string" && tagRes.stripped !== full) { full = tagRes.stripped; render(full); }
    }

    // 3. Ambience tags: executed in window.__ambientTags, and once stripped they reach neither the bubble nor the session body
    try {
      const r = ports.applyAmbientTags(full);
      if (r && typeof r.clean === "string" && r.clean !== full) { full = r.clean; render(full); }
    } catch (e) {}

    // 4. WeChat image signal: firing is deferred until after the session write, when the caller uses photoSig/photoKind
    let photoSig          = null;
    let photoKind          = null;
    try {
      const _r = ports.extractPhotoSignal(full);
      if (_r && _r.scene != null) {
        photoSig = _r.scene;
        photoKind = _r.kind || null; // 4.72: pass the parsed kind through instead of letting handleSignal guess again
        if (typeof _r.clean === "string" && _r.clean !== full) { full = _r.clean; render(full); }
      }
    } catch (e) {}

    // 5. Snapshot: the fishbowl and group chat get the text as it was before labels and tags were stripped
    //    (the residual sweep also happens after this point)
    const replyForEngine = full;

    // 6. Group speaker label plus handoff/end tags: a leaked label puts "冷(女)】" in the bubble, a leaked tag shows [next:高冷]
    if (o.stripGroupTags) {
      const _lbl = stripSceneSpeakerLabel(full);
      if (_lbl !== full) { full = _lbl; render(full); }
      const _noTags = full.replace(/\[next[:：][^\]\n]*\]/gi, "").replace(/\[end\]/gi, "").replace(/\[召唤[:：][^\]\n]*\]/g, "").trim();
      if (_noTags !== full) { full = _noTags; render(full); }
    }

    // 7. Residual bracket sweep (4.59): mangled "[]", a lone "]" and the "[好感]" remains, so both the bubble and the history stay clean
    {
      const _swept = stripResidualMarkup(full);
      if (_swept !== full) { full = _swept; render(full); }
    }

    return { full, reasonArchive, affectionDelta, photoSig, photoKind, replyForEngine };
  }

  // A33(1b): the computing half of WeChat splitting — strip action prose, fall back to sentence splitting
  // when there is no "||", then cut into parts. The DOM and timing half (building rows, per-part delay, the
  // _tailGen abort) stays in app.js. The returned text is the action-stripped full text, which is what the
  // session stores: keeping the synthesised "||" marks would teach the next turn to imitate them.
  function splitWechatParts(full         )                    {
    let text = String(full == null ? "" : full);
    const noAct = stripWechatActions(text);
    if (noAct && noAct !== text) text = noAct;
    // autoSplit is only used to compute the parts; its result is never written back into text (see above)
    let probe = text;
    if (!probe.includes("||")) {
      const auto = autoSplitWechat(probe);
      if (auto) probe = auto;
    }
    if (!probe.includes("||")) return { text: text, parts: null };
    const parts = probe.split("||").map(function (x) { return x.trim(); }).filter(Boolean);
    return { text: text, parts: parts.length > 1 ? parts : null };
  }

  return {
    isJailbreakStripOn,
    setJailbreakStripOn,
    splitJailbreakPrefix,
    stripJailbreakPrefix,
    stripSceneSpeakerLabel,
    stripThinkBlocks,
    stripPhotoSignalLive,
    stripUnpairedSquareBrackets,
    stripResidualMarkup,
    stripWechatActions,
    autoSplitWechat,
    finalizeReply,
    splitWechatParts,
    stripVoiceTags,
    stripChoiceSignals,
    diffPrefixSuffix,
  };
}

// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/chat/text-format.ts; this file carries every window bridge
// with the same try/catch shape as the old inline code. Bridges are resolved per call, never
// captured, because the modules behind them load later.
(function () {
  if (window.__textFormat) return;
  var ports = {
    storage: {
      getItem: function (key) { return window.localStorage.getItem(key); },
      setItem: function (key, value) { window.localStorage.setItem(key, value); },
    },
    // Scene member names, the equivalent of the old inline `stripSceneSpeakerLabel` block.
    sceneNames: function () {
      var names = [];
      try {
        if (window.__multi && window.__multi.getSceneCards) {
          names = window.__multi.getSceneCards().map(function (c) { return (c && c.name) || ""; }).filter(Boolean);
        }
      } catch (e) {}
      return names;
    },
    // Strip the image-send signal during streaming, as the old inline block did. A missing bridge
    // or a throw returns the text untouched.
    stripPhotoSignal: function (text) {
      try {
        if (window.__chatImageText && window.__chatImageText.stripSignalForDisplay) {
          return window.__chatImageText.stripSignalForDisplay(text);
        }
      } catch (e) {}
      return text;
    },
    // Run the ambient-sound tags, as step ③ of the old finalizeReply did. Null means the bridge is
    // missing, threw, or produced no cleaned text.
    applyAmbientTags: function (text) {
      try {
        var at = window.__ambientTags;
        if (at && typeof at.apply === "function") return at.apply(text) || null;
      } catch (e) {}
      return null;
    },
    // Parse the WeChat image signal, as step ④ of the old finalizeReply did. Whether a non-null
    // scene means anything stays on the service side.
    extractPhotoSignal: function (text) {
      try {
        var cit = window.__chatImageText;
        if (cit && typeof cit.extractSignal === "function") return cit.extractSignal(text) || null;
      } catch (e) {}
      return null;
    },
  };
  var tf = createTextFormat(ports);
  window.__textFormat = {
    isJailbreakStripOn: tf.isJailbreakStripOn,
    setJailbreakStripOn: tf.setJailbreakStripOn,
    splitJailbreakPrefix: tf.splitJailbreakPrefix,
    stripJailbreakPrefix: tf.stripJailbreakPrefix,
    stripSceneSpeakerLabel: tf.stripSceneSpeakerLabel,
    stripThinkBlocks: tf.stripThinkBlocks,
    stripPhotoSignalLive: tf.stripPhotoSignalLive,
    stripUnpairedSquareBrackets: tf.stripUnpairedSquareBrackets,
    stripResidualMarkup: tf.stripResidualMarkup,
    stripWechatActions: tf.stripWechatActions,
    autoSplitWechat: tf.autoSplitWechat,
    finalizeReply: tf.finalizeReply,
    splitWechatParts: tf.splitWechatParts,
    stripVoiceTags: tf.stripVoiceTags,
    stripChoiceSignals: tf.stripChoiceSignals,
    diffPrefixSuffix: tf.diffPrefixSuffix,
  };
})();

globalThis.createTextFormat = createTextFormat;
})();
