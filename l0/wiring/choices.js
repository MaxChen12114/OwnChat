// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/choices.ts; this file owns the
// DOM: the stylesheet, the panel/chip construction, the send fallback chain, the bubble
// TreeWalker strip and the mutation-observer scanning loop.
//
// Shared by three entry paths: ① normal chat with agents off — a MutationObserver scans the
// latest finished AI bubble for [选项] tags (autoScan); ② agent mode / autopilot — the
// offer_choices tool or the pause exits call renderChoices explicitly; ③ anywhere —
// parseAndRender(raw, opts) parses and renders in one step.
//
// The send fallback chain (2026-09-10): __app.sendOne first, then #sendBtn click, then a
// synthetic Enter keydown last — a compose-into-#msg-then-press-Enter primary path broke on
// mobile WebViews that swallow synthetic KeyboardEvents, and the 10ms gap allowed double sends.
(function () {
  if (window.__choices) return;

  var BAR_ID = "omniChoicesBar";
  var STYLE_ID = "omniChoicesStyle";

  function $(id) { return document.getElementById(id); }

  function ensureStyle() {
    if ($(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = [
      // 2026-09-10 mobile display fixes (three): ① max-height + overflow-y — an uncapped bar with
      // 5–6 long options pushed the composer off-screen; ② word-break/overflow-wrap — long
      // CJK runs without spaces overflowed the chips; ③ theme variables instead of a hardcoded
      // lavender that clashed on every non-default theme. Rounded corners at 14px because
      // 999px turns elliptical on multi-line chips.
      // 2026-09-12 "panel invisible / unclickable": translucent rgba fallbacks blended into the
      // background on themes where --card/--accent are undefined. Now an opaque surface panel
      // (the same --bubble-ai solid the menus use) + solid border + shadow + higher z-index.
      // 2026-11-10 (owner request: follow the theme, ZCode-style): the chip-wrap became a panel
      // with a title row, numbered full-width options and a bottom action bar.
      "#" + BAR_ID + "{position:relative;z-index:30;flex:0 0 100%;width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:10px 10px 8px;margin:0 0 8px;border-radius:14px;background:var(--surface-2,#1c1c22);border:1px solid var(--border,rgba(127,127,127,.35));box-shadow:0 10px 30px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.04);max-height:38vh;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;animation:ocFade .18s ease;pointer-events:auto;}",
      "@keyframes ocFade{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}",
      "#" + BAR_ID + " .oc-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px 4px;}",
      "#" + BAR_ID + " .oc-title{font-size:11.5px;font-weight:650;letter-spacing:.04em;color:var(--muted,#9a9a9a);}",
      "#" + BAR_ID + " .oc-hint{font-size:11px;opacity:.55;}",
      ".oc-chip{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;font-size:13px;line-height:1.4;padding:9px 10px;border-radius:10px;cursor:pointer;border:1px solid var(--border-soft,rgba(127,127,127,.3));background:rgba(127,127,127,.08);color:inherit;transition:background .15s,border-color .15s;text-align:left;white-space:normal;word-break:break-word;overflow-wrap:anywhere;pointer-events:auto;}",
      ".oc-chip:hover{background:rgba(127,127,127,.18);border-color:var(--accent,#7b82e8);}",
      ".oc-chip:active{transform:scale(.995);}",
      ".oc-idx{flex:none;width:18px;height:18px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:650;background:var(--accent-soft,rgba(127,127,127,.16));color:var(--accent,#7b82e8);}",
      "#" + BAR_ID + " .oc-foot{display:flex;flex-wrap:wrap;gap:4px;padding-top:5px;margin-top:2px;border-top:1px solid var(--border-soft,rgba(127,127,127,.18));}",
      ".oc-chip.oc-meta{display:inline-flex;width:auto;gap:6px;padding:6px 10px;border-style:solid;border-color:transparent;background:transparent;font-size:12px;color:var(--muted,#9a9a9a);}",
      ".oc-chip.oc-meta:hover{background:rgba(127,127,127,.14);border-color:transparent;color:inherit;}",
      ".oc-chip .oc-ico{display:inline-flex;vertical-align:-2px;margin-right:6px;}",
      ".oc-chip .oc-ico svg{width:13px;height:13px;display:block;}",
      "html[data-theme=\"glass\"] #" + BAR_ID + "{background:rgba(255,255,255,.90);border-color:rgba(255,255,255,.8);-webkit-backdrop-filter:blur(20px) saturate(170%);backdrop-filter:blur(20px) saturate(170%);box-shadow:0 14px 40px rgba(30,60,90,.18),inset 0 1px 0 rgba(255,255,255,.9);}",
      "html[data-theme=\"glass\"] .oc-chip{background:rgba(15,30,60,.05);border-color:rgba(15,30,60,.10);}",
      "html[data-theme=\"glass\"] .oc-chip:hover{background:rgba(63,111,143,.10);border-color:var(--accent,#3f6f8f);}",
      "html[data-theme=\"glass\"] #" + BAR_ID + " .oc-title{color:#5a6b78;}"
    ].join("");
    document.head.appendChild(s);
  }

  // Mount anchor above the composer (prefer .input-floating, fall back to #msg's parent).
  function composerHost() {
    var fl = document.querySelector(".input-floating");
    if (fl) return fl;
    var msg = $("msg");
    return (msg && msg.parentElement) || null;
  }

  function sendAsUser(text) {
    if (window.__app && typeof window.__app.sendOne === "function") {
      try { window.__app.sendOne({ text: text }); return; } catch (e) {}
    }
    var msg = $("msg");
    if (!msg) return;
    msg.value = text;
    try { msg.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
    var btn = $("sendBtn");
    if (btn) { btn.click(); return; }
    try { msg.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); } catch (e) {}
  }

  function parseChoices(text) {
    return chParseChoices(text);
  }

  // options: Array<{label,value?}> | Array<string>
  // opts: { onPick?(value,isMeta), includeMeta=true, metaActions?, autoSend=true }
  function renderChoices(options, opts) {
    options = options || [];
    opts = opts || {};
    var norm = chNormalize(options);
    var includeMeta = opts.includeMeta !== false;
    if (!norm.length && !includeMeta) { clearChoices(); return null; }

    ensureStyle();
    clearChoices();
    var host = composerHost();
    if (!host) return null;

    var bar = document.createElement("div");
    bar.id = BAR_ID;

    var head = document.createElement("div");
    head.className = "oc-head";
    var title = document.createElement("span");
    title.className = "oc-title";
    title.textContent = norm.length ? "AI 提供选项" : "继续";
    var hint = document.createElement("span");
    hint.className = "oc-hint";
    hint.textContent = norm.length ? "点一条直接发送 · 或继续打字" : "或自己打字";
    head.appendChild(title);
    head.appendChild(hint);
    bar.appendChild(head);

    function pick(value, isMeta) {
      try { if (typeof opts.onPick === "function" && opts.onPick(value, isMeta) === false) { clearChoices(); return; } } catch (e) {}
      if (opts.autoSend === false) { clearChoices(); return; }
      sendAsUser(value);
      clearChoices();
    }

    norm.forEach(function (o, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "oc-chip";
      var idx = document.createElement("span");
      idx.className = "oc-idx";
      idx.textContent = String(i + 1);
      b.appendChild(idx);
      b.appendChild(document.createTextNode(o.label));
      b.addEventListener("click", function () { pick(o.value, false); });
      bar.appendChild(b);
    });

    if (includeMeta) {
      // 2026-09-14: linear SVG icons for the three fixed actions — the old ✍️ (U+270D + FE0F)
      // rendered as emoji on most platforms, clashing with the site's linear-icon language.
      var META_ICONS = {
        "__compose__": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1 9.6-9.6a2 2 0 0 0-2.8-2.8L5.4 16z"/><path d="M13.5 6.3l4.2 4.2"/></svg>',
        "__continue__": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13"/><path d="M13 7l5 5-5 5"/></svg>',
        "__another__": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h9a4 4 0 0 1 4 4v6"/><path d="M14 14l3 3 3-3"/></svg>'
      };
      var metas = opts.metaActions || [
        { label: "继续", value: "继续", icon: META_ICONS.__continue__ },
        { label: "换个走向", value: "换一个走向，给我新的发展", icon: META_ICONS.__another__ },
        { label: "自己写", value: "__compose__", icon: META_ICONS.__compose__ }
      ];
      var foot = document.createElement("div");
      foot.className = "oc-foot";
      metas.forEach(function (mAct) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "oc-chip oc-meta";
        var ic = mAct.icon || META_ICONS[mAct.value] || "";
        if (ic) b.innerHTML = '<span class="oc-ico">' + ic + "</span>";
        b.appendChild(document.createTextNode(mAct.label));
        b.addEventListener("click", function () {
          if (mAct.value === "__compose__") {
            // 2026-09-10 fix: focus must happen synchronously inside the click gesture and before
            // the chip bar is torn down — once the DOM changes, iOS/Android WebViews refuse to
            // open the soft keyboard ("tapping compose does nothing").
            var m = $("msg");
            if (m) {
              try { m.focus({ preventScroll: true }); m.setSelectionRange(m.value.length, m.value.length); }
              catch (e) { try { m.focus(); } catch (e2) {} }
            }
            clearChoices();
            try { if (m && m.scrollIntoView) m.scrollIntoView({ block: "center" }); } catch (e) {}
            return;
          }
          pick(mAct.value, true);
        });
        foot.appendChild(b);
      });
      bar.appendChild(foot);
    }

    // Insert above the composer (host's first child, same pattern as scene-strip).
    if (host.firstChild) host.insertBefore(bar, host.firstChild);
    else host.appendChild(bar);
    return bar;
  }

  function clearChoices() {
    var bar = $(BAR_ID);
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  }

  // One step: parse raw text and render (autopilot / app.js tail hooks call this directly).
  function parseAndRender(rawText, opts) {
    var r = parseChoices(rawText);
    if (r.options.length) renderChoices(r.options, opts);
    return r;
  }

  // Erase the raw [选项] tags from the rendered bubble — protocol blocks must not reach the user.
  // 2026-09-10 rewrite: slicing the innerHTML string broke in two ways — markdown rendering can
  // split or escape the markers ([ → &#91;) so indexOf misses them and the user sees the raw
  // tags, and even a hit could cut an HTML tag mid-open and destroy the whole paragraph on
  // reassignment (the periodic "bubble mangled / paragraphs missing" mobile report). A TreeWalker
  // over text nodes only ever touches pure-text ranges, never the tag structure.
  function stripBlockText(el) {
    try {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var nodes = [], offsets = [], total = 0, n;
      while ((n = walker.nextNode())) { nodes.push(n); offsets.push(total); total += n.nodeValue.length; }
      if (!nodes.length) return;
      var full = nodes.map(function (x) { return x.nodeValue; }).join("");
      var blk = chFindBlock(full);
      if (!blk) return;
      var from = blk.start, to = blk.end + blk.close.length;
      for (var i = nodes.length - 1; i >= 0; i--) {
        var s = offsets[i], e = s + nodes[i].nodeValue.length;
        if (e <= from || s >= to) continue;
        var a = Math.max(from, s) - s, b = Math.min(to, e) - s;
        nodes[i].nodeValue = nodes[i].nodeValue.slice(0, a) + nodes[i].nodeValue.slice(b);
      }
    } catch (e) {}
  }

  var api = {
    parseChoices: parseChoices,
    renderChoices: renderChoices,
    clearChoices: clearChoices,
    parseAndRender: parseAndRender,
    // 2026-09-10: cache of the most recently parsed options. Once the tags are stripped from the
    // bubble, re-parsing the bubble text yields nothing — autopilot's semi-auto pause reads its
    // real options back from this cache (see autopilot.js renderPauseExits).
    lastOptions: [],
    getLastOptions: function () { return (api.lastOptions || []).slice(); },
    autoScan: true
  };

  // ① autoScan fallback: watch #chat and scan the latest finished AI bubble (agents off).
  function scanLatestAiRow(chat) {
    if (!api.autoScan) return;
    var rows = chat.querySelectorAll(".row.ai");
    if (!rows.length) return;
    var row = rows[rows.length - 1];
    var bubble = row.querySelector(".bubble.ai");
    if (!bubble) return;
    var raw = bubble.textContent || "";
    if (chScanSkip(true, row.getAttribute("data-streaming") === "1", row.dataset.ocDone === "1", raw)) return;
    var r = parseChoices(raw);
    // 2026-09-10 fix: the old version stamped ocDone before checking the parse result, so a
    // bubble parsed as empty was permanently skipped — and the instant a stream finishes is
    // exactly when a half-delivered block gets seen. Empty parse → leave the row unmarked.
    if (!r.options.length) return;
    row.dataset.ocDone = "1";
    row.dataset.ocRaw = raw;   // keep the original text for rebuild/debug
    api.lastOptions = r.options;
    stripBlockText(bubble);
    renderChoices(r.options, {});
  }

  function wire() {
    var chat = $("chat");
    if (!chat) { setTimeout(wire, 600); return; }
    var t = null;
    var _streamClearedFor = null; // 2026-09-12: remember which streaming row was already cleared once
    new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(function () {
        // 2026-09-10 fix: as soon as a new reply starts streaming, drop the stale chip bar. Only
        // clearing on user send left an expired bar above the composer for autopilot / agent /
        // retry sends — tapping it sent garbage. 2026-09-12 fix: clear at most ONCE per streaming
        // row — in agent mode offer_choices renders chips while the row still carries
        // data-streaming="1" (the tool call precedes the final text stream), and clearing on every
        // mutation made chips flash and vanish. A new streaming row clears once at its start;
        // later mutations on the same row (including tool-rendered chips) do not.
        try {
          var streamingRow = chat.querySelector('.row.ai[data-streaming="1"]');
          if (streamingRow) {
            if (_streamClearedFor !== streamingRow) { _streamClearedFor = streamingRow; clearChoices(); }
            return;
          }
          _streamClearedFor = null;
        } catch (e) {}
        scanLatestAiRow(chat);
      }, 120);
    }).observe(chat, { childList: true, subtree: true, characterData: true });
    var sendBtn = $("sendBtn");
    if (sendBtn) sendBtn.addEventListener("click", clearChoices);
    var msg = $("msg");
    if (msg) msg.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) clearChoices(); });
  }

  window.__choices = api;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
