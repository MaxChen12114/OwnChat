(function () {
/**
 * The agent workflow panel's rules, minus the DOM: how a tool call is briefed, which state a step and
 * the whole panel end in, the one-line summary text, and how a background turn's recorded rounds are
 * replayed onto a live handle.
 *
 * The replay contract is the reason this module exists at all: when the user switches away mid-run,
 * the row (and the live panel) is destroyed, but the turn keeps recording rounds. Switching back
 * replays those rounds through the same handle methods a live run would call — one rendering path,
 * no duplicates. `ok === true/false/undefined` means done / failed / still running; a replay must
 * leave an in-flight card in the running state, because that is exactly what the user should see.
 *
 * The summary never says "已完成 · 0 步": a panel without tool calls was pure thinking, and calling
 * that a workflow is a lie. Aborts are also an ending — the old version kept spinning "运行中" after
 * the user pressed stop, while the truth was "interrupted, result unknown".
 * @module services/agent/steps
 */

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Argument keys worth showing in the brief line, in priority order. */
const STEP_BRIEF_KEYS = ["path", "file", "file_path", "filename", "url", "query", "q", "keyword", "name", "pattern", "id", "topic", "text", "content"];

/** One-line argument brief: the first known key wins, else the remaining pairs, truncated. */
function briefArgs(name         , args         )         {
  void name;
  if (!args || typeof args !== "object") return "";
  const a = recOf(args);
  for (let i = 0; i < STEP_BRIEF_KEYS.length; i++) {
    const v = a[STEP_BRIEF_KEYS[i]];
    if (typeof v === "string" && v) return v.length > 90 ? v.slice(0, 90) + "…" : v;
  }
  const rest = Object.keys(a)
    .filter((k) => STEP_BRIEF_KEYS.indexOf(k) < 0 && a[k] != null && a[k] !== "")
    .map((k) => k + "=" + String(a[k]).slice(0, 40));
  return rest.length ? rest.join(" ") : "";
}

                                               

/** denied or ok===false is a failure; ok===true done; anything else still running. */
function stepState(info         )            {
  const i = recOf(info);
  return i.denied || i.ok === false ? "err" : i.ok === true ? "done" : "run";
}

                            
                                    
                                                                                           
                
                                                                                             
                
                   
 

/** Decide the collapsed summary of a finished panel from its step elements' name/state pairs. */
function panelDone(steps         , ms               , reason         , enLabels         )            {
  const list = Array.isArray(steps) ? steps : [];
  const names           = [];
  let err = 0;
  list.forEach((el) => {
    const s = recOf(el);
    const n = String(s.name || "");
    if (names.indexOf(n) < 0) names.push(n);
    if (s.state === "err") err++;
  });
  const hasSteps = list.length > 0;
  // An abort is also an ending; conflating it with "done" hid the fact that the result is unknown.
  const aborted = reason === "aborted";
  const suffix = enLabels ? " +" : " 等";
  return {
    state: aborted ? "aborted" : err ? "err" : "done",
    title: aborted
      ? "已中断" + (hasSteps ? " · " + list.length + " 步" : "")
      : hasSteps
        ? (err ? "已结束" : "已完成") + " · " + list.length + " 步"
        : "思考过程",
    names: names.slice(0, 4).join(", ") + (names.length > 4 ? suffix : ""),
    errored: err > 0,
  };
}

/** Milliseconds as the header shows them: >=1s gets one decimal + "s", else raw + "ms". */
function panelMs(ms               )                {
  if (ms == null) return null;
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
}

/** The recorded round shape (documentation of the wire format; access goes through recOf). */
                              
                    
                    
                       
                               
 

                             
                
                 
               
              
                 
                   
                   
 

                              
                    
                    
                       
                               
 

                               
                          
                                         
                                    
                                                   
                                                    
                                                     
                                                      
                        
 

/** The meeting/turn-card prefix both live and replay use. */
function meetingLabel(ev         )         {
  const e = recOf(ev);
  const participants = Array.isArray(e.participants) ? e.participants.join("、") : "";
  return "私下小会 · " + String(e.topic || "").slice(0, 80) + "（" + (participants || "—") + " · 共 " + (Number(e.rounds) || 1) + " 轮）";
}

function peerStepKey(kind        , who         , round         )         {
  const r = Number(round) || 1;
  return kind === "meeting" ? "小会 · " + String(who || "") + "（第 " + r + " 轮）" : "上台 · " + String(who || "");
}

function strField(v         , k        )         {
  const x = recOf(v)[k];
  return typeof x === "string" ? x : "";
}

function arrField(v         , k        )            {
  const x = recOf(v)[k];
  return Array.isArray(x) ? x : [];
}

/**
 * Replay recorded rounds onto a live handle. Returns the number of tool cards replayed (0 means
 * "nothing worth drawing"). Unknown event types are skipped, not fatal.
 */
function replayTurn(handle                     , rounds         )         {
  if (!handle || !Array.isArray(rounds)) return 0;
  let played = 0;
  rounds.forEach((r) => {
    if (!r) return;
    if (typeof handle.model_call === "function") handle.model_call();
    const thinking = strField(r, "thinking");
    if (thinking && typeof handle.roundThinking === "function") handle.roundThinking(thinking);
    const preamble = strField(r, "preamble");
    if (preamble && typeof handle.preamble === "function") handle.preamble(preamble);
    arrField(r, "calls").forEach((raw) => {
      const c = recOf(raw);
      const name = typeof c.name === "string" ? c.name : "";
      if (!name) return;
      if (typeof handle.tool_run === "function") handle.tool_run(name, c.args || {});
      played++;
      if (c.denied) {
        if (typeof handle.tool_denied === "function") handle.tool_denied(name, c.args || {});
      } else if (c.ok === false) {
        if (typeof handle.tool_error === "function") handle.tool_error(name, { error: typeof c.error === "string" ? c.error : "调用失败", ms: c.ms });
      } else if (c.ok === true) {
        if (typeof handle.tool_done === "function") handle.tool_done(name, { ok: true, ms: c.ms, summary: c.summary });
      }
      // ok neither true nor false: the card was still running -- replay keeps it running.
    });
    arrField(r, "events").forEach((ev) => {
      try {
        const type = strField(ev, "type");
        const fn = handle[type];
        if (typeof fn === "function") fn(ev);
      } catch (e) {}
    });
  });
  return played;
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/agent/steps.ts (brief line, step and
// panel states, the summary text, the replay dispatch); this file owns the CSS, the DOM builders, the
// anchor placement and the live controller.
//
// One reply = one collapsible panel containing one continuous timeline: round 1 (thinking, preamble,
// tool cards), round 2, ...; when it finishes the panel collapses into a one-line summary and the
// actual answer lives below it. Shaped after ZCode.
//
// Three invariants users paid for:
//   - thinking is NOT a standalone top block; it is split into the round it belongs to (the model's
//     round-N thoughts show inside round N, next to the calls they precede).
//   - one reply gets exactly ONE panel; rounds merge into it.
//   - thinking / preambles / tool results go into the panel only, never into a content bubble.
//
// Three entries share the DOM: renderTurn (history, collapsed), mountLive (live, auto-collapses when
// done) and replay (switching back to a background conversation feeds the recorded rounds through the
// same live handle).
(function () {
  "use strict";
  if (window.__agentSteps) return;

  var STYLE_ID = "agentStepsStyles";
  var CSS_TEXT = `
.ags-wrap{display:flex;flex-direction:column;gap:6px;max-width:100%;margin:0 0 8px;}
.ags-panel{border:1px solid var(--border,rgba(127,127,127,.22));border-radius:12px;background:var(--ag-hover,rgba(127,127,127,.05));overflow:hidden;}
.ags-hd{display:flex;align-items:center;gap:8px;padding:8px 11px;cursor:pointer;user-select:none;font-size:12.5px;}
.ags-hd:hover{background:var(--ag-hover,rgba(127,127,127,.09));}
.ags-hico{flex:none;display:inline-flex;width:14px;height:14px;align-items:center;justify-content:center;}
.ags-hico svg{width:14px;height:14px;}
.ags-panel[data-state="run"] .ags-hico{color:#7fb3d5;animation:agsSpin 1.1s linear infinite;}
.ags-panel[data-state="done"] .ags-hico{color:#5ec98a;}
.ags-panel[data-state="err"] .ags-hico{color:#e8607d;}
.ags-panel[data-state="aborted"] .ags-hico{color:#f5a524;}
.ags-htx{flex:none;font-weight:600;color:inherit;}
.ags-hnames{flex:1;min-width:0;color:var(--muted,#9a9a9a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;opacity:.9;}
.ags-hms{flex:none;color:var(--muted,#9a9a9a);font-size:11px;font-variant-numeric:tabular-nums;opacity:.9;}
.ags-hchev{flex:none;display:inline-flex;align-items:center;color:var(--muted,#9a9a9a);transition:transform .18s ease;}
.ags-hchev svg{width:12px;height:12px;display:block;}
.ags-panel.open .ags-hchev{transform:rotate(90deg);}
.ags-bd{display:none;padding:2px 11px 10px;border-top:1px solid var(--border,rgba(127,127,127,.16));}
.ags-panel.open .ags-bd{display:block;}
/* A round = one wrapper block: the round label, that round's thinking, preamble and tool rows, in
   timeline order. */
.ags-rw{padding:5px 0 2px;}
.ags-rw + .ags-rw{border-top:1px dashed var(--border,rgba(127,127,127,.16));margin-top:3px;}
.ags-round{font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--muted,#9a9a9a);opacity:.7;text-transform:uppercase;}
/* Thinking: collapsible via its title row; open while running, collapsed by setPanelDone. */
.ags-think{padding:4px 0 2px;}
.ags-think-hd{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:3px 2px;border-radius:6px;}
.ags-think-hd:hover{background:var(--ag-hover,rgba(127,127,127,.09));}
.ags-think-lb{font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--muted,#9a9a9a);opacity:.7;text-transform:uppercase;}
.ags-think-hd .ags-caret{flex:none;display:inline-flex;align-items:center;color:var(--muted,#9a9a9a);transition:transform .15s;}
.ags-think-hd .ags-caret svg{width:11px;height:11px;display:block;}
.ags-think.open .ags-think-hd .ags-caret{transform:rotate(90deg);}
.ags-think-tx{display:none;font-size:12.5px;line-height:1.62;color:inherit;opacity:.78;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;padding:3px 2px 0;border-left:2px solid var(--border,rgba(127,127,127,.18));margin:2px 0 2px 3px;padding-left:9px;}
.ags-think.open .ags-think-tx{display:block;}
.ags-preamble{font-size:12.5px;line-height:1.62;color:inherit;opacity:.88;padding:5px 0 3px;white-space:pre-wrap;}
/* A tool call is one flat row (a bordered box here was the "bubble inside a bubble"); hover tint. */
.ags-step{border-radius:7px;font-size:12.5px;margin:2px 0;}
.ags-head{display:flex;align-items:center;gap:7px;padding:5px 6px;cursor:pointer;user-select:none;border-radius:7px;}
.ags-head:hover{background:var(--ag-surface,rgba(127,127,127,.10));}
.ags-ico{flex:none;display:inline-flex;width:13px;height:13px;align-items:center;justify-content:center;opacity:.85;}
.ags-ico svg{width:13px;height:13px;}
.ags-step[data-state="run"] .ags-ico{color:#7fb3d5;animation:agsSpin 1.1s linear infinite;}
.ags-step[data-state="done"] .ags-ico{color:#5ec98a;}
.ags-step[data-state="err"] .ags-ico{color:#e8607d;}
.ags-name{flex:none;font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace;}
.ags-brief{flex:1;min-width:0;color:var(--muted,#9a9a9a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;}
.ags-meta{flex:none;color:var(--muted,#9a9a9a);font-size:11px;font-variant-numeric:tabular-nums;opacity:.9;}
.ags-caret{flex:none;display:inline-flex;align-items:center;color:var(--muted,#9a9a9a);transition:transform .15s;}
.ags-caret svg{width:11px;height:11px;display:block;}
.ags-step.open .ags-caret{transform:rotate(90deg);}
/* Expanded detail: a thin left rule plus indent, still flat -- no nested box. */
.ags-body{display:none;padding:2px 0 6px 22px;}
.ags-step.open .ags-body{display:block;}
.ags-label{font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--muted,#9a9a9a);opacity:.7;margin:7px 0 4px;text-transform:uppercase;}
.ags-body pre{margin:0;padding:8px 10px;border-radius:8px;background:var(--ag-surface,rgba(127,127,127,.10));max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:11.5px/1.6 ui-monospace,Menlo,Consolas,monospace;color:inherit;border-left:2px solid var(--border,rgba(127,127,127,.18));}
.ags-body pre code{background:none;border:0;padding:0;font:inherit;}
.ags-errtx{color:#e8607d;}
@keyframes agsSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ags-panel[data-state="run"] .ags-ico,.ags-step[data-state="run"] .ags-ico{animation:none;}.ags-hchev,.ags-caret{transition:none;}}
`;
  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(s);
  }

  var ICON_SPIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
  var ICON_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  var ICON_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
 // Line SVG for the caret -- bare text glyphs like U+25B6 render as emoji on some platforms.
  var ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  var ICON_STOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

  var esc = window.escapeSvc.esc;
  function fmtResult(text) {
    var t = String(text == null ? "" : text);
    try {
      var j = JSON.parse(t);
      var pretty = JSON.stringify(j, null, 2);
      if (window.hljs && pretty.length < 40000) {
        try { return window.hljs.highlight(pretty, { language: "json", ignoreIllegals: true }).value; } catch (e) {}
      }
      return esc(pretty);
    } catch (e) {}
    return esc(t);
  }

  // ── one tool card ──
  function makeStepEl(name) {
    var el = document.createElement("div");
    el.className = "ags-step";
    el.dataset.state = "run";
    el.dataset.tool = name || "";
    el.innerHTML =
      '<div class="ags-head">' +
        '<span class="ags-ico">' + ICON_SPIN + "</span>" +
        '<span class="ags-name">' + esc(name || "tool") + "</span>" +
        '<span class="ags-brief"></span>' +
        '<span class="ags-meta"></span>' +
        '<span class="ags-caret">' + ICON_CHEV + "</span>" +
      "</div>" +
      '<div class="ags-body"></div>';
    el.querySelector(".ags-head").addEventListener("click", function () { el.classList.toggle("open"); });
    return el;
  }
  function fillStep(el, info) {
    if (!el) return;
    var brief = el.querySelector(".ags-brief");
    var meta = el.querySelector(".ags-meta");
    var body = el.querySelector(".ags-body");
    var ico = el.querySelector(".ags-ico");
    var b = briefArgs(info.name, info.args);
    if (b) brief.textContent = b;
    if (info.ms != null) meta.textContent = info.ms + "ms";
    var st = stepState(info);
    el.dataset.state = st;
    ico.innerHTML = st === "done" ? ICON_DONE : (st === "err" ? ICON_ERR : ICON_SPIN);
    if (st === "err") el.classList.add("open"); // failures start open; never make the user guess
    var html = "";
    if (info.args) html += '<div class="ags-label">参数</div><pre><code>' + esc(JSON.stringify(info.args, null, 2)) + "</code></pre>";
    if (info.error) html += '<div class="ags-label">错误</div><pre><code class="ags-errtx">' + esc(info.error) + "</code></pre>";
    else if (info.result != null && info.result !== "") html += '<div class="ags-label">结果</div><pre><code>' + fmtResult(info.result) + "</code></pre>";
    body.innerHTML = html;
  }

  // ── a round wrapper: label + that round's thinking + preamble + tool cards ──
  function makeRoundEl(n) {
    var rw = document.createElement("div");
    rw.className = "ags-rw";
    rw.dataset.round = String(n);
    var lb = document.createElement("div");
    lb.className = "ags-round";
    lb.textContent = "第 " + n + " 轮";
    rw.appendChild(lb);
    return rw;
  }
  // The thinking block; open while running, collapsed when the panel finishes.
  function thinkBlock(text) {
    var t = document.createElement("div");
    t.className = "ags-think open";
    var hd = document.createElement("div");
    hd.className = "ags-think-hd";
    var lb = document.createElement("span");
    lb.className = "ags-think-lb";
    lb.textContent = "思考";
    var chev = document.createElement("span");
    chev.className = "ags-caret";
    chev.innerHTML = ICON_CHEV;
    hd.appendChild(lb); hd.appendChild(chev);
    var tx = document.createElement("div");
    tx.className = "ags-think-tx";
    tx.textContent = String(text == null ? "" : text);
    hd.addEventListener("click", function () { t.classList.toggle("open"); });
    t.appendChild(hd); t.appendChild(tx);
    return t;
  }
  function preambleEl(text) {
    var p = document.createElement("div");
    p.className = "ags-preamble";
    p.textContent = String(text == null ? "" : text);
    return p;
  }
  // Write a chunk into a round's thinking block (called repeatedly while streaming).
  function setRoundThinking(rw, text) {
    var val = String(text == null ? "" : text).trim();
    var cur = rw.querySelector(".ags-think");
    if (!val) { if (cur) cur.remove(); return; }
    if (!cur) { cur = thinkBlock(val); rw.insertBefore(cur, rw.querySelector(".ags-step")); }
    else cur.querySelector(".ags-think-tx").textContent = val;
  }

  // ── the panel shell ──
  function makePanel() {
    var p = document.createElement("div");
    p.className = "ags-panel open";
    p.dataset.state = "run";
    p.innerHTML =
      '<div class="ags-hd">' +
        '<span class="ags-hico">' + ICON_SPIN + "</span>" +
        '<span class="ags-htx">运行中…</span>' +
        '<span class="ags-hnames"></span>' +
        '<span class="ags-hms"></span>' +
        '<span class="ags-hchev">' + ICON_CHEV + "</span>" +
      "</div>" +
      '<div class="ags-bd"></div>';
    p.querySelector(".ags-hd").addEventListener("click", function () { p.classList.toggle("open"); });
    return p;
  }
  function ensureWrap(anchor) {
    if (!anchor) return null;
    // Anchor normalization: the panel must land inside a row's .content (AI row preferred). Taking
    // anchor.parentNode directly degenerated to a chat-level bare block whenever the anchor was not
    // inside a row (synthetic rows, detached nodes) -- "tool calls on top of the user's message".
    var host = null;
    try {
      if (document.contains(anchor)) {
        var row = anchor.closest ? anchor.closest(".row") : null;
        if (row) {
          host = row.querySelector(".content") || null;
          anchor = (host && host.querySelector(".bubble")) || anchor;
        }
      }
    } catch (e) {}
    if (!host) {
      // Detached anchor: fall back to the last AI row's content. No AI row at all -> give up; a
      // bare block is worse than no panel.
      var rows = document.querySelectorAll("#chat .row.ai");
      var last = rows.length ? rows[rows.length - 1] : null;
      host = last ? last.querySelector(".content") : null;
      anchor = host ? (host.querySelector(".bubble") || null) : null;
    }
    if (!host) return null;
    var wrap = host.querySelector(":scope > .ags-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "ags-wrap";
      if (anchor && anchor.parentNode === host) host.insertBefore(wrap, anchor); // above the bubble
      else host.appendChild(wrap);
    }
    return wrap;
  }
  function setPanelDone(p, ms, reason) {
    if (!p) return;
    var steps = [];
    Array.prototype.forEach.call(p.querySelectorAll(".ags-step"), function (el) {
      steps.push({ name: el.querySelector(".ags-name").textContent, state: el.dataset.state });
    });
    var done = panelDone(steps, null, reason, document.documentElement.classList.contains("i18n-en"));
    p.dataset.state = done.state;
    p.querySelector(".ags-hico").innerHTML = done.state === "aborted" ? ICON_STOP : (done.state === "err" ? ICON_ERR : ICON_DONE);
    p.querySelector(".ags-htx").textContent = done.title;
    p.querySelector(".ags-hnames").textContent = done.names;
    var msText = panelMs(ms);
    if (msText != null) p.querySelector(".ags-hms").textContent = msText;
    // Collapse the thinking blocks too: a long open thought buries the tool rows.
    Array.prototype.forEach.call(p.querySelectorAll(".ags-think.open"), function (t) { t.classList.remove("open"); });
    p.classList.remove("open"); // auto-collapse on finish; only the summary line remains
  }

  // ── history render (one panel per reply, collapsed by default) ──
  // turn = { rounds: [ { thinking, preamble, calls:[{name,args,ok,ms,error,result,denied}] } ] };
  // a bare round object (no rounds field) is treated as one round.
  function renderTurn(anchor, turn) {
    if (!anchor || !turn) return;
    var rounds = Array.isArray(turn.rounds) ? turn.rounds : [turn];
    var hasAny = rounds.some(function (r) { return r && ((r.calls || []).length || r.thinking || r.preamble); });
    if (!hasAny) return;
    ensureCss();
    var wrap = ensureWrap(anchor);
    if (!wrap) return;
    var p = makePanel();
    var bd = p.querySelector(".ags-bd");
    var totalMs = 0, hasErr = false;
    rounds.forEach(function (r, i) {
      if (!r) return;
      var rw = makeRoundEl(i + 1);
      if (r.thinking) rw.appendChild(thinkBlock(r.thinking));
      if (r.preamble) rw.appendChild(preambleEl(r.preamble));
      (r.calls || []).forEach(function (c) {
        var el = makeStepEl(c.name);
        fillStep(el, c);
        rw.appendChild(el);
        if (c.ms) totalMs += c.ms;
        if (c.denied || c.ok === false) hasErr = true;
      });
      bd.appendChild(rw);
    });
    setPanelDone(p, totalMs || null);
    if (hasErr) p.classList.add("open"); // keep failures visible at a glance
    wrap.appendChild(p);
  }

  // ── live controller ──
  function mountLive(anchor) {
    ensureCss();
    var wrap = ensureWrap(anchor);
    var panel = null, body = null, curRound = null, curStep = null, roundNo = 0;
    var started = Date.now();
    var _peers = {}; // meeting/stage cards keyed by who+round: created on start, filled when done
    function ensurePanel() {
      if (panel) return panel;
      panel = makePanel();
      body = panel.querySelector(".ags-bd");
      wrap.appendChild(panel);
      return panel;
    }
    function ensureRound() {
      if (curRound) return curRound;
      ensurePanel();
      roundNo++;
      curRound = makeRoundEl(roundNo);
      body.appendChild(curRound);
      return curRound;
    }
    return {
      element: wrap,
      // A new round begins (the kernel emits model_call before each model call).
      model_call: function () { curRound = null; curStep = null; ensureRound(); },
      // This round's thinking (repeatedly called while streaming; split into the owning round).
      roundThinking: function (text) { setRoundThinking(ensureRound(), text); },
      // The preamble: talking while calling tools in the same round.
      preamble: function (text) {
        if (!text || !String(text).trim()) return;
        ensureRound().appendChild(preambleEl(String(text).trim()));
      },
      tool_run: function (name, args) {
        var rw = ensureRound();
        curStep = makeStepEl(name);
        fillStep(curStep, { name: name, args: args });
        rw.appendChild(curStep);
      },
      tool_done: function (name, info) {
        var rw = curRound || ensureRound();
        if (!curStep || curStep.dataset.tool !== name) curStep = rw.querySelector('.ags-step[data-state="run"]');
        fillStep(curStep, Object.assign({ name: name }, info || {}));
        curStep = null;
      },
      tool_error: function (name, info) {
        var rw = curRound || ensureRound();
        if (!curStep || curStep.dataset.tool !== name) curStep = rw.querySelector('.ags-step[data-state="run"]');
        fillStep(curStep, Object.assign({ name: name, ok: false }, info || {}));
        curStep = null;
      },
      tool_denied: function (name, args) {
        var el = makeStepEl(name);
        fillStep(el, { name: name, args: args, ok: false, denied: true, error: "你拒绝了这次操作" });
        ensureRound().appendChild(el);
      },
      // Council meetings and staged appearances flow through the same panel -- the whole process is
      // visible on the bubble without faking character bubbles into the timeline.
      meeting_start: function (ev) {
        var lb = document.createElement("div");
        lb.className = "ags-preamble";
        lb.textContent = meetingLabel(ev);
        ensureRound().appendChild(lb);
      },
      meeting_speaker: function (ev) {
        if (!ev) return;
        var key = peerStepKey("meeting", ev.who, ev.round);
        var el = _peers[key];
        if (!el) { el = makeStepEl(key); ensureRound().appendChild(el); _peers[key] = el; }
        if (ev.phase === "start") return; // show it running first; fill the text when done
        if (ev.phase === "error") fillStep(el, { name: key, ok: false, error: String(ev.error || "出错") });
        else fillStep(el, { name: key, ok: true, result: ev.text || ev.summary || "" });
      },
      peer_invite: function (ev) {
        if (!ev) return;
        var key = peerStepKey("stage", ev.who);
        var el = _peers[key];
        if (!el) { el = makeStepEl(key); ensureRound().appendChild(el); _peers[key] = el; }
        if (ev.phase === "done") fillStep(el, { name: key, ok: true, result: ev.text || "（无内容）" });
      },
      // Round over: collapse to the summary line. reason: undefined=normal / "aborted" / "error".
      finish: function (reason) { if (panel) setPanelDone(panel, Date.now() - started, reason); },
      hasContent: function () { return !!(panel && panel.querySelectorAll(".ags-step").length); },
    };
  }

  // ── replay: feed the recorded rounds back through a live handle ──
  // Scenario: A is generating -> switch to B -> switch back. Leaving destroyed the row and the live
  // panel, so only "generating" survived. While in the background the events keep recording into
  // turn.rounds; on return they replay through the same handle methods onto the new row, and live
  // events keep writing into that same handle -- one rendering path, not two.
  // The rounds shape matches renderTurn's. Returns the number of tool cards replayed.
  function replay(handle, rounds) {
    return replayTurn(handle, rounds);
  }

  window.__agentSteps = { renderTurn: renderTurn, mountLive: mountLive, replay: replay, briefArgs: briefArgs };
})();

globalThis.STEP_BRIEF_KEYS = STEP_BRIEF_KEYS;
globalThis.briefArgs = briefArgs;
globalThis.stepState = stepState;
globalThis.panelDone = panelDone;
globalThis.panelMs = panelMs;
globalThis.meetingLabel = meetingLabel;
globalThis.peerStepKey = peerStepKey;
globalThis.replayTurn = replayTurn;
})();
