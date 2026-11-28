(function () {
/**
 * The status panel's brain, minus the DOM: number formatting, the context-window lookup, the manual
 * limit parser, the context snapshot (how many tokens each payload block costs), and the HTML for the
 * four sections.
 *
 * The snapshot math is the part worth locking: it must agree with what actually gets sent, or the
 * capacity card lies. Three rules carry history:
 *  - Uploaded documents count through the app's own `attFileTokens` — the truncated amount is what
 *    actually goes out. Pending (not yet sent) attachments are estimated here with the same shape, and
 *    the two never overlap: after sending, `takePending` moves the text into the session.
 *  - Lorebook entries are matched against the last 6 messages — the same input the send path uses, or
 *    the panel would disagree with the request.
 *  - The context window is only ever detected from the worker's `APP_CTX_EXACT` / `APP_CTX_HINTS`
 *    (upstream /v1/models responses do not carry window sizes). No local fallback table: a copied
 *    table drifts from the worker config silently, which is why this used to be wrong.
 *
 * The manual-limit parser accepts what people actually type — `1000000`, `100万`, `1m`, `128k` —
 * because a number input silently swallowed `100万` and the user's value vanished.
 * @module services/ui/status-panel
 */

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

const DEFAULT_CTX = 131072;

/** Section categories, in the order the card lists them. Labels are panel copy. */
                      
              
               
                
                 
 

function makeCats(accent        )        {
  return [
    { key: "msgTokens", name: "消息历史", color: accent },
    { key: "attTokens", name: "上传文档", color: accent },
    { key: "sumTokens", name: "记忆摘要", color: accent },
    { key: "loreTokens", name: "设定集", color: accent, lore: true },
    { key: "cardTokens", name: "角色卡·人设", color: accent },
    { key: "presetTokens", name: "预设·技能", color: accent },
    { key: "reasoningTokens", name: "思考归档", color: accent },
  ];
}

/** Numbers as k/M abbreviations; `—` for anything that is not a finite number. Numeric strings pass. */
function fmtTok(n         )         {
  if (n == null) return "—";
  const num = Number(n);
  if (isNaN(num)) return "—";
  const v = Math.round(num);
  if (v >= 1e6) {
    const m = v / 1e6;
    return (m < 10 ? m.toFixed(1) : String(Math.round(m))) + "M";
  }
  if (v >= 1e3) {
    const k = v / 1e3;
    return (k < 10 ? k.toFixed(1) : String(Math.round(k))) + "k";
  }
  return String(v);
}

function fmtPct(p        )         {
  return (p * 100).toFixed(p > 0 && p < 0.01 ? 2 : 1) + "%";
}

/** `42 秒前` / `3 分钟前` / `2 小时前`; empty timestamp reads `—`. */
function fmtAgo(ts         , now        )         {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((now - Number(ts)) / 1000));
  return s < 60 ? s + " 秒前" : s < 3600 ? Math.round(s / 60) + " 分钟前" : Math.round(s / 3600) + " 小时前";
}

/** Look up the window for a model id: exact id first, then hint regexes; 0 means "unknown". */
function detectCtx(modelId         , exact         , hints         )         {
  const s = String(modelId || "");
  if (!s) return 0;
  const ex = recOf(exact);
  const hit = ex[s];
  if (typeof hit === "number") return hit;
  const hs = Array.isArray(hints) ? hints : [];
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    if (!Array.isArray(h) || h.length < 2) continue;
    try {
      if (new RegExp(String(h[0]), "i").test(s)) return Number(h[1]);
    } catch (e) {}
  }
  return 0;
}

/** manual > detected > default; a manual value below 1024 is treated as not set. */
function resolveCtxWindow(manual        , detected        )         {
  if (manual && manual >= 1024) return manual;
  return detected || DEFAULT_CTX;
}

/**
 * Parse the manual limit field. Accepts `1000000`, `100万`, `1m`, `128k`, `2千`, `5w` and plain
 * numbers with spaces/commas; anything else is NaN and the caller restores the effective value.
 */
function parseCtxInput(raw         )         {
  const s = String(raw == null ? "" : raw).trim().toLowerCase().replace(/[\s,_]/g, "");
  if (!s) return NaN;
  const m = s.match(/^([0-9]*\.?[0-9]+)(万|千|m|k|w)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return NaN;
  const u = m[2];
  const mult = u === "万" || u === "w" ? 1e4 : u === "m" ? 1e6 : u === "千" || u === "k" ? 1e3 : 1;
  return Math.round(n * mult);
}

                                 
                                         
                                              
                                      
                                                
 

                                 
                       
                                                                     
                                                 
                                                
                                             
                                                                         
                                       
                                                 
                                                                                                
                                                                                                  
                            
                  
                     
 

                              
                
               
                    
                          
                    
                     
                    
                    
                     
                       
                      
                         
                   
                 
                
                
               
                
 

/** One snapshot for both hosts. Every source read is guarded: a missing module costs 0, not a crash. */
function collectSnapshot(src                )              {
  const app = src.app || {};
  const est = (t         )         => {
    try {
      return app.estimateTokens ? app.estimateTokens(String(t || "")) : 0;
    } catch (e) {
      return 0;
    }
  };
  const msgs = app.getSessionMessages ? app.getSessionMessages() || [] : [];
  const card = src.character && src.character.getActiveCard ? src.character.getActiveCard() : null;
  const last6 = msgs.slice(-6).map((m) => String(recOf(m).content || "")).join("\n");

  let loreTokens = 0;
  let loreCount = 0;
  try {
    const entries = src.lorebook && src.lorebook.getActiveEntries
      ? src.lorebook.getActiveEntries({ text: last6, cardId: String(recOf(card).id || "") })
      : [];
    loreCount = entries.length;
    loreTokens = est(entries.map((e) => recOf(e).name ? String(recOf(e).name) + "\n" + String(recOf(e).content || "") : String(recOf(e).content || "")).join("\n"));
  } catch (e) {}

  let skillsText = "";
  try {
    skillsText = src.skills && src.skills.buildCatalogPrompt ? src.skills.buildCatalogPrompt() : "";
  } catch (e) {}

  let presetsText = "";
  try {
    const arr = JSON.parse(src.storage.getItem("cfw_prompt_presets_v1") || "[]");
    presetsText = (Array.isArray(arr) ? arr : [])
      .filter((p) => p && recOf(p).enabled)
      .map((p) => String(recOf(p).content || ""))
      .join("\n");
  } catch (e) {}

  let msgTokens = 0;
  let reasoningTokens = 0;
  let attTokens = 0;
  const attTk = app.attFileTokens || null;
  msgs.forEach((m) => {
    const rec = recOf(m);
    msgTokens += est(rec.content);
    if (typeof rec.reasoning_content === "string") reasoningTokens += est(rec.reasoning_content);
    if (attTk) {
      try {
        attTokens += attTk(m) || 0;
      } catch (e) {}
    }
  });
  try {
    const pend = src.attach && src.attach.list ? src.attach.list() || [] : [];
    pend.forEach((p) => {
      const rec = recOf(p);
      if (rec.kind === "text") attTokens += est("【文件:" + String(rec.name || "") + "】" + String(rec.text || ""));
    });
  } catch (e) {}

  const sumText = String(src.summaryText() || "");
  const sumTokens = est(sumText);
  const cardTokens = est(card ? JSON.stringify(card) : "");
  const presetTokens = est(presetsText);
  const skillTokens = est(skillsText);
  const total = msgTokens + attTokens + sumTokens + loreTokens + cardTokens + presetTokens + skillTokens + reasoningTokens;

  let cost          = null;
  try {
    cost = src.cost && src.cost.getCostStats ? src.cost.getCostStats() : null;
  } catch (e) {}
  let usage          = null;
  try {
    usage = src.cost && src.cost.getUsageStats ? src.cost.getUsageStats() : null;
  } catch (e) {}
  let sync          = null;
  try {
    sync = src.sync && src.sync.getStatus ? src.sync.getStatus() : null;
  } catch (e) {}

  return {
    total: total,
    msgs: msgs.length,
    msgTokens: msgTokens,
    reasoningTokens: reasoningTokens,
    sumTokens: sumTokens,
    loreTokens: loreTokens,
    loreCount: loreCount,
    attTokens: attTokens,
    cardTokens: cardTokens,
    presetTokens: presetTokens,
    skillTokens: skillTokens,
    summaryTrigger: parseInt(src.storage.getItem("cfw_summary_trigger") || "30", 10) || 30,
    lastReq: app.getLastRequestStats ? app.getLastRequestStats() : null,
    usage: usage,
    sync: sync,
    cost: cost,
    mode: src.storage.getItem("cfw_mode") === "fast" ? "快速" : "免费",
    model: src.modelId || "—",
  };
}

                                 
                                           
                                                              
                                                                                  
                                                               
 

const TREND_COLORS = ["var(--accent, #7fa4c9)", "#5aa9a3", "#d08a4a", "#9b7fd1"];
const TREND_W = 300;
const TREND_H = 92;
const TREND_PAD_Y = 8;

/** The usage card: five numbers, the 26-week heatmap, the 7/30-day trend, and the estimate note. */
function usageHtml(u                       , rangeIn        , esc                        )         {
  if (!u || !u.summary) return '<div class="sp-empty">用量模块未加载。</div>';
  const range = rangeIn === 30 ? 30 : 7;
  const sum = recOf(u.summary);
  const series = u.series(range);
  const models = u.modelSeries(range, 4);
  const totalTokens = Number(sum.totalTokens) || 0;
  const totalRequests = Number(sum.totalRequests) || 0;
  const hasData = totalTokens > 0 || totalRequests > 0;
  const max = Math.max(1, ...series.map((s) => Number(s.total) || 0));
  const x = (i        ) => (series.length <= 1 ? TREND_W / 2 : i * (TREND_W / (series.length - 1)));
  const y = (v        ) => TREND_H - TREND_PAD_Y - (v / max) * (TREND_H - TREND_PAD_Y * 2);
  const linePath = (pts          ) => pts.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
  const lines = (models.length ? models : [{ name: "全部模型", points: series.map((s) => Number(s.total) || 0) }])
    .map((m, i) => ({ name: m.name || "", points: m.points || [], color: TREND_COLORS[i % TREND_COLORS.length] }));
  const heat = u.heatmap(26);
  const heatHtml = heat.map((c) => '<i class="sp-heat-i l' + (c.level || 0) + '" title="' + esc(c.label) + '"></i>').join("");
  const rangeBtn = (n        ) => '<button type="button" class="sp-range-btn' + (range === n ? " on" : "") + '" data-sp-range="' + n + '">' + n + "日</button>";
  const peakLabel = sum.peakDate ? String(sum.peakDate).slice(5) : "—";
  const totalCost = Number(sum.totalCost) || 0;
  const costText = totalCost > 0 ? " · ¥" + totalCost.toFixed(4) : "";
  const gridLines = [0.25, 0.5, 0.75]
    .map((r) => '<line x1="0" y1="' + (TREND_H * r).toFixed(1) + '" x2="' + TREND_W + '" y2="' + (TREND_H * r).toFixed(1) + '"/>')
    .join("");
  const first = series[0] || {};
  const last = series[series.length - 1] || {};
  return (
    '<div class="sp-row sp-head"><span class="sp-title">使用统计</span><span class="sp-range">' + rangeBtn(7) + rangeBtn(30) + "</span></div>" +
    '<div class="sp-stats">' +
    '<div class="sp-stat wide"><b>' + fmtTok(totalTokens) + "</b><span>累计 Token · " + totalRequests + " 次请求" + costText + "</span></div>" +
    '<div class="sp-stat"><b>' + fmtTok(sum.peakTokens) + "</b><span>峰值 · " + esc(peakLabel) + "</span></div>" +
    '<div class="sp-stat"><b>' + (Number(sum.activeDays) || 0) + " 天</b><span>活跃天数</span></div>" +
    '<div class="sp-stat"><b>' + (Number(sum.currentStreak) || 0) + " 天</b><span>当前连续</span></div>" +
    '<div class="sp-stat"><b>' + (Number(sum.longestStreak) || 0) + " 天</b><span>最长连续</span></div>" +
    "</div>" +
    '<div class="sp-heat">' + heatHtml + "</div>" +
    '<div class="sp-heat-legend">少 <i style="opacity:.2"></i><i style="opacity:.4"></i><i style="opacity:.68"></i><i></i> 多</div>' +
    (hasData
      ? '<svg class="sp-trend" viewBox="0 0 ' + TREND_W + " " + TREND_H + '" preserveAspectRatio="none" role="img" aria-label="每日 Token 趋势">' +
        '<g class="sp-trend-grid">' + gridLines + "</g>" +
        lines.map((l) => '<path d="' + linePath(l.points) + '" fill="none" stroke="' + l.color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>').join("") +
        "</svg>" +
        '<div class="sp-trend-x"><span>' + esc(first.label || "") + "</span><span>" + esc(last.label || "") + "</span></div>" +
        '<div class="sp-legend">' + lines.map((l) => '<span><i style="background:' + l.color + '"></i>' + esc(l.name) + "</span>").join("") + "</div>"
      : '<div class="sp-empty">还没有用量记录。发一条消息后开始统计。</div>') +
    ((Number(sum.totalEstimated) || 0) ? '<div class="sp-note">含 ' + sum.totalEstimated + ' 次估算（上游未回 usage，免费档常见）。</div>' : "")
  );
}

/** The seven capacity rows; the share is measured against the effective window. */
function catRowsHtml(s             , ctx        , accent        , esc                        )         {
  return makeCats(accent)
    .map((c) => {
      const v = Number(recOf(s)[c.key]) || 0;
      const sub = c.lore && s.loreCount ? " · " + s.loreCount + "条" : "";
      return (
        '<div class="sp-cat"><span class="sp-dot" style="background:' + c.color + '"></span>' +
        '<span class="sp-cat-name">' + esc(c.name) + sub + "</span>" +
        '<span class="sp-cat-val">' + fmtTok(v) + " · " + fmtPct(ctx ? v / ctx : 0) + "</span></div>"
      );
    })
    .join("");
}

/** The last-request block: estimated output vs real usage are different rows on purpose. */
function lastReqHtml(lr         , esc                        , now        )         {
  if (!lr) return '<div class="sp-empty">发送一条消息后显示真实 usage / 耗时。</div>';
  const r = recOf(lr);
  const rows                     = [];
  rows.push(["模型", esc(r.model || "—") + " · " + esc(r.mode || "—")]);
  if (r.est) {
    rows.push(["输出", fmtTok(r.outEstimate) + " tok(估算)"]);
    rows.push(["Prompt/Completion", "上游未回 usage"]);
  } else {
    rows.push(["Prompt / Completion", fmtTok(r.prompt) + " / " + fmtTok(r.completion)]);
    rows.push(["Total", fmtTok(r.total) + " tok"]);
    if (r.cacheHit != null && r.prompt) {
      rows.push(["缓存命中", Math.round((Number(r.cacheHit) / Math.max(1, Number(r.prompt))) * 100) + "%"]);
    }
  }
  if (r.ms) rows.push(["耗时", r.ms + " ms"]);
  rows.push(["时间", fmtAgo(r.at, now)]);
  return rows.map((row) => '<div class="sp-kv"><span class="k">' + row[0] + '</span><span class="v">' + row[1] + "</span></div>").join("");
}

/** The system block: sync state, today's cost (fast mode only), and the summary countdown. */
function sysHtml(s             , esc                        )         {
  const rows                     = [];
  const sc = recOf(s.sync);
  if (sc) {
    const enabled = !!sc.enabled;
    const st = !enabled ? "关" : sc.paused ? "已暂停" : "开启";
    rows.push(["云同步", esc(st) + (enabled ? " · push " + (Number(sc.pushCount) || 0) + "/1000" : "")]);
    if (enabled && sc.lastPush) rows.push(["上次推送", fmtAgo(sc.lastPush, Date.now())]);
  }
  const cost = recOf(s.cost);
  rows.push(["今日费用", s.mode === "快速" && cost ? "¥" + Number(cost.today || 0).toFixed(4) : "免费模式 · 不计费"]);
  rows.push(["会话消息", s.msgs + " 条"]);
  const left = s.summaryTrigger - s.msgs;
  rows.push(["历史压缩", s.msgs + "/" + s.summaryTrigger + " 条" + (left <= 0 ? ' <span class="sp-warn">将触发摘要</span>' : "")]);
  return rows.map((row) => '<div class="sp-kv"><span class="k">' + row[0] + '</span><span class="v">' + row[1] + "</span></div>").join("");
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/status-panel.ts; this file owns the
// stylesheet, the skeleton markup, the host, the input wiring and the refresh loop.
//
// One host by design: #statusPanelDesktop lives in the right rail, and the mobile shell moves that
// whole rail into its console. The refresh strategy is the cost-widget pattern: a 2s interval that
// only recomputes while the host is visible, plus immediate refresh on storage/focus/visibility/tab
// changes.
//
// The estimation note is honest by construction: the client only sees the payload blocks it assembles;
// the worker's system base and compliance layers are invisible, and the card says so.
(function(){
  "use strict";

  const LS_CTX_WINDOW = "cfw_ctx_window_v1";
  const REFRESH_MS = 2000;
  const STYLE_ID = "statusPanelStyles";

  const CSS_TEXT = `
/* The injected stylesheet sits at the end of head, so the host declares its own display rather
   than relying on the old mobile bottom-sheet rules. */
.sp-host{padding:10px 12px calc(12px + env(safe-area-inset-bottom,0px));box-sizing:border-box;font-family:var(--chat-font-family,ui-sans-serif,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);}
#statusPanelDesktop{display:flex;flex-direction:column;gap:10px;}
.sp-card{background:var(--bubble-ai,#141414);border:1px solid var(--border,#222);border-radius:14px;padding:12px 14px;box-sizing:border-box;}
.sp-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.sp-title{font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--muted,#9a9a9a);text-transform:uppercase;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.sp-head{margin-bottom:1px;}
.sp-pct{font-size:11px;font-weight:600;color:var(--muted,#9a9a9a);font-variant-numeric:tabular-nums;}
.sp-big{font-size:19px;font-weight:800;color:inherit;font-variant-numeric:tabular-nums;letter-spacing:.01em;margin:2px 0 0;white-space:nowrap;}
.sp-ctxline{display:flex;align-items:center;gap:6px;margin-top:11px;padding-top:10px;border-top:1px solid var(--border,rgba(127,127,127,.16));}
.sp-ctx-lb{flex:none;font-size:10.5px;color:var(--muted,#9a9a9a);}
.sp-ctxline .sp-ctx-input{flex:1;min-width:0;}
.sp-ctxline .sp-ctx-auto{flex:none;}
.sp-bar{height:8px;border-radius:6px;background:rgba(127,127,127,.16);overflow:hidden;margin:8px 0 10px;}
.sp-bar-fill{height:100%;border-radius:6px;background:var(--accent,#7fa4c9);width:0;transition:width .5s ease,background .3s ease;}
.sp-cat{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;line-height:1.4;}
.sp-dot{width:8px;height:8px;border-radius:50%;flex:none;}
.sp-cat-name{opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sp-cat-val{margin-left:auto;color:var(--muted,#9a9a9a);font-variant-numeric:tabular-nums;white-space:nowrap;}
.sp-kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px;line-height:1.5;}
.sp-kv .k{color:var(--muted,#9a9a9a);white-space:nowrap;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.sp-kv .v{font-variant-numeric:tabular-nums;text-align:right;word-break:break-word;flex:none;max-width:62%;}
.sp-note{font-size:10.5px;line-height:1.55;color:var(--muted,#9a9a9a);margin-top:9px;opacity:.85;}
.sp-ctx-auto{background:transparent;border:none;color:var(--muted,#9a9a9a);cursor:pointer;font:inherit;font-size:10.5px;padding:2px 4px;border-radius:5px;text-decoration:underline;text-underline-offset:2px;}
.sp-ctx-auto:hover{color:inherit;background:rgba(127,127,127,.14);}
.sp-note code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;background:rgba(127,127,127,.14);padding:1px 4px;border-radius:4px;word-break:break-all;}
.sp-empty{font-size:12px;color:var(--muted,#9a9a9a);padding:6px 0 2px;line-height:1.6;}
.sp-warn{color:var(--danger,#e8607d);}
/* Usage statistics: numbers, heatmap and trend. */
.sp-range{display:flex;gap:0;border:1px solid var(--border,rgba(127,127,127,.18));border-radius:7px;overflow:hidden;flex:none;}
.sp-range-btn{border:0;background:transparent;color:var(--muted,#9a9a9a);font:inherit;font-size:9.5px;line-height:1;padding:4px 7px;cursor:pointer;}
.sp-range-btn.on{background:rgba(127,127,127,.16);color:inherit;}
.sp-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:10px;}
.sp-stat{min-width:0;background:rgba(127,127,127,.08);border-radius:9px;padding:7px 8px;box-sizing:border-box;}
.sp-stat.wide{grid-column:1/-1;}
.sp-stat b{display:block;font-size:15px;font-weight:800;line-height:1.2;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sp-stat span{display:block;margin-top:2px;font-size:9.5px;line-height:1.3;color:var(--muted,#9a9a9a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sp-heat{display:grid;grid-template-rows:repeat(7,4px);grid-auto-flow:column;grid-auto-columns:4px;gap:2px;margin-top:11px;overflow:hidden;}
.sp-heat-i{width:4px;height:4px;border-radius:1px;background:rgba(127,127,127,.13);}
.sp-heat-i.l1{background:var(--accent,#7fa4c9);opacity:.2;}
.sp-heat-i.l2{background:var(--accent,#7fa4c9);opacity:.4;}
.sp-heat-i.l3{background:var(--accent,#7fa4c9);opacity:.68;}
.sp-heat-i.l4{background:var(--accent,#7fa4c9);opacity:1;}
.sp-heat-legend{display:flex;align-items:center;justify-content:flex-end;gap:3px;margin-top:4px;font-size:9px;color:var(--muted,#9a9a9a);}
.sp-heat-legend i{width:4px;height:4px;border-radius:1px;background:var(--accent,#7fa4c9);}
.sp-trend{display:block;width:100%;height:92px;margin-top:8px;overflow:visible;}
.sp-trend-grid{stroke:var(--border,rgba(127,127,127,.18));stroke-width:1;opacity:.55;}
.sp-trend-x{display:flex;justify-content:space-between;margin-top:2px;font-size:9px;color:var(--muted,#9a9a9a);}
.sp-legend{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:4px;font-size:9.5px;color:var(--muted,#9a9a9a);}
.sp-legend i{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:3px;vertical-align:middle;}
.sp-sys summary{cursor:pointer;list-style:none;font-size:10.5px;color:var(--muted,#9a9a9a);}
.sp-sys summary::-webkit-details-marker{display:none;}
.sp-sys summary:before{content:"▸ ";}
.sp-sys[open] summary:before{content:"▾ ";}
.sp-sys .sp-kv{padding:2px 0;font-size:11px;}

@media (prefers-reduced-motion:reduce){.sp-bar-fill{transition:none;}}
`;

  function ensureCss(){
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(s);
  }

  var esc = window.escapeSvc.esc;

  // The manual limit beats detection, detection beats the default; the manual value lives in
  // localStorage and only the wiring touches that key.
  function detectCtxHere(modelId) {
    return detectCtx(modelId, window.APP_CTX_EXACT || {}, window.APP_CTX_HINTS || []);
  }
  function currentModelId() {
    const sel = document.getElementById("modelSel");
    if (sel && sel.value) return sel.value;
    try { return localStorage.getItem("cfw_model") || ""; } catch (e) { return ""; }
  }
  function ctxManual() { const v = parseInt(localStorage.getItem(LS_CTX_WINDOW), 10); return (v && v >= 1024) ? v : 0; }
  function ctxWindow(){
    return resolveCtxWindow(ctxManual(), detectCtxHere(currentModelId()));
  }

  // One snapshot per tick, shared by both hosts. Each source read is guarded in the service: a
  // missing module costs one number, not the whole card.
  function collect(){
    return collectSnapshot({
      app: window.appSvc || {},
      lorebook: window.lorebookSvc || {},
      skills: window.skillsSvc || {},
      character: window.characterSvc || {},
      attach: window.attachSvc || {},
      cost: (window.hostApi && window.hostApi.cost) || {},
      sync: window.syncSvc || {},
      storage: localStorage,
      summaryText: function () {
        try {
          var app = window.appSvc;
          var id = (app && app.getActiveConvId) ? app.getActiveConvId() : "";
          return (window.convSummarySvc && id) ? window.convSummarySvc.load(id) : "";
        } catch (e) { return ""; }
      },
      modelId: (document.getElementById("modelSel") || {}).value || "",
    });
  }

  const SKELETON = `
    <div class="sp-card">
      <div class="sp-row sp-head"><span class="sp-title">上下文容量</span><span class="sp-pct" data-sp="bigSub"></span></div>
      <div class="sp-big" data-sp="big">—</div>
      <div class="sp-bar"><div class="sp-bar-fill" data-sp="bar"></div></div>
      <div data-sp="cats"></div>
      <div class="sp-ctxline">
        <span class="sp-ctx-lb">上限</span>
        <input class="sp-ctx-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="131k" title="上下文窗口上限(tokens)。默认按当前模型自动识别;想手动指定可直接改(可用 1000000 / 1m / 128k 等写法),改后点「自动」恢复识别">
        <button class="sp-ctx-auto" type="button" title="恢复按当前模型自动识别">自动</button>
      </div>
      <div class="sp-note" data-sp="ctxsrc"></div>
      <div class="sp-note">估算仅含客户端可见的 payload 组成块,服务端系统底座与合规层不计入;实际以发送时 worker 装配为准。</div>
    </div>
    <div class="sp-card">
      <div data-sp="usage"></div>
    </div>
    <div class="sp-card">
      <details class="sp-sys">
        <summary>系统状态</summary>
        <div data-sp="lastreq"><div class="sp-empty">发送一条消息后显示真实 usage / 耗时。</div></div>
        <div data-sp="sys"></div>
        <div data-sp="runtime"></div>
      </details>
    </div>`;

  // Section HTML is produced by the service; the wiring only feeds esc and the host-local range.
  function catRows(s) { return catRowsHtml(s, ctxWindow(), "var(--accent, #7fa4c9)", esc); }
  function lastReq(lr) { return lastReqHtml(lr, esc, Date.now()); }

  // T4-A: the runtime container's own read-out. `ctx.explain` is reachable per plugin through the
  // host's status snapshot: names, activation state, which services are missing for a PENDING
  // plugin, and why the last one was unmounted. Anything unavailable prints as "未接线" — an empty
  // section would hide a broken container, which is exactly the failure this panel must surface.
  function runtimeHtml() {
    var host = window.runtimeCore && window.runtimeCore.host;
    if (!host || typeof host.status !== "function") {
      return '<div class="sp-kv"><span class="k">运行时容器</span><span class="v sp-warn">未接线</span></div>';
    }
    var s;
    try { s = host.status(); } catch (e) { return '<div class="sp-kv"><span class="k">运行时容器</span><span class="v sp-warn">读取失败</span></div>'; }
    if (!s) return "";
    var plugins = Array.isArray(s.plugins) ? s.plugins : [];
    var pending = Array.isArray(s.pending) ? s.pending : [];
    var rows = [];
    rows.push('<div class="sp-kv"><span class="k">插件</span><span class="v">' +
      plugins.length + ' 个 · ' + (pending.length ? pending.length + " PENDING" : "全部就绪") + '</span></div>');
    rows.push('<div class="sp-kv"><span class="k">服务</span><span class="v">' +
      (Array.isArray(s.services) && s.services.length ? esc(s.services.join(", ")) : '<span class="sp-warn">无</span>') + '</span></div>');
    if (Array.isArray(s.missingServices) && s.missingServices.length) {
      rows.push('<div class="sp-kv"><span class="k">缺失服务</span><span class="v sp-warn">' + esc(s.missingServices.join(", ")) + '</span></div>');
    }
    for (var i = 0; i < pending.length; i++) {
      var p = pending[i] || {};
      var need = Array.isArray(p.missing) && p.missing.length ? p.missing.join(", ") : "未知";
      rows.push('<div class="sp-kv"><span class="k">PENDING</span><span class="v">' + esc(p.name || "?") + ' ← ' + esc(need) + '</span></div>');
    }
    var last = s.lastDispose;
    rows.push('<div class="sp-kv"><span class="k">最近卸载</span><span class="v">' +
      (last ? esc(String(last.name || "?")) + " · " + esc(String(last.reason || "")) : "无") + '</span></div>');
    return rows.join("");
  }

  // Unconditionally rewriting the sections every tick made the panel flicker: DOM rebuilds re-ran
  // i18n and scrollbar math, and in a narrow rail the content height visibly oscillated. Sections are
  // skipped when their HTML signature is unchanged — data only changes after a send or a sync.
  function setSection(host, key, html) {
    const el = host.querySelector('[data-sp="' + key + '"]');
    if (!el) return;
    if (el.__spLast === html) return;
    el.__spLast = html;
    el.innerHTML = html;
  }
  function renderInto(host, s){
    if (!host || !host.__spDone) return;
    const ctx = ctxWindow();
    const pct = ctx ? Math.min(1, s.total / ctx) : 0;
    host.querySelector("[data-sp=\"big\"]").textContent = fmtTok(s.total) + " / " + fmtTok(ctx);
    host.querySelector("[data-sp=\"bigSub\"]").textContent = "(" + fmtPct(s.total / (ctx || 1)) + ")";
    const bar = host.querySelector("[data-sp=\"bar\"]");
    bar.style.width = Math.min(100, pct * 100) + "%";
    bar.style.background = pct > 0.9 ? "var(--danger, #e8607d)" : "var(--accent, #7fa4c9)";
    setSection(host, "cats", catRows(s));
    setSection(host, "usage", usageHtml(s.usage, host.__spRange, esc));
    setSection(host, "lastreq", lastReq(s.lastReq));
    setSection(host, "sys", sysHtml(s, esc));
    // The container read-out changes only on mount/unmount, but the 2s tick is cheap and the
    // signature guard already skips the DOM write when nothing moved.
    setSection(host, "runtime", runtimeHtml());
    // Where the limit came from: which model was matched, or that a manual value can be cleared.
    const srcEl = host.querySelector("[data-sp=\"ctxsrc\"]");
    if (srcEl) {
      const mid = currentModelId();
      if (ctxManual()) {
        srcEl.innerHTML = '上限为手动指定 · 点右上「自动」改回按模型识别';
      } else {
        const hit = detectCtxHere(mid);
        srcEl.innerHTML = hit
          ? '上限按当前模型自动识别:<code>' + esc(mid) + '</code> → ' + fmtTok(hit)
          : '未能识别当前模型 <code>' + esc(mid || "—") + '</code> 的窗口,暂用默认值 ' + fmtTok(DEFAULT_CTX) + '(可手动指定)';
      }
      // The input follows the effective value — unless the user is editing it right now.
      const inp = host.querySelector(".sp-ctx-input");
      if (inp && document.activeElement !== inp) inp.value = ctx;
    }
  }

  // Mounting and the refresh loop. The mobile shell moves this host into its console.
  let hosts = [];
  function mountAll(){
    ensureCss();
    hosts = [document.getElementById("statusPanelDesktop")].filter(Boolean);
    hosts.forEach(h => {
      if (h.__spDone) return;
      h.__spDone = true;
      h.classList.add("sp-host");
      h.innerHTML = SKELETON;
      const input = h.querySelector(".sp-ctx-input");
      input.value = ctxWindow();
      const commit = () => {
        const v = parseCtxInput(input.value);
        if (isFinite(v) && v >= 1024) {
          input.value = v;
          try { localStorage.setItem(LS_CTX_WINDOW, String(v)); } catch (e) {}
        } else {
          // Parse failure restores the effective value: silently swapping in the default is how
          // user-entered numbers used to vanish.
          input.value = ctxWindow();
        }
        tick();
      };
      input.addEventListener("change", commit);
      // Enter commits (a text field has no number input's native commit).
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
      // "Auto" clears the manual value and falls back to per-model detection.
      const autoBtn = h.querySelector(".sp-ctx-auto");
      if (autoBtn) autoBtn.addEventListener("click", () => {
        try { localStorage.removeItem(LS_CTX_WINDOW); } catch (e) {}
        input.value = ctxWindow();
        tick();
      });
      // Each host remembers its own 7/30-day range; not written to localStorage.
      h.addEventListener("click", (e) => {
        const btn = e.target && e.target.closest ? e.target.closest("[data-sp-range]") : null;
        if (!btn) return;
        const n = Number(btn.getAttribute("data-sp-range"));
        if (n !== 7 && n !== 30) return;
        h.__spRange = n;
        renderInto(h, collect());
      });
    });
  }

  // offsetParent is always null for position:fixed elements, so the mobile panel (a fixed drawer)
  // would read as invisible forever and tick would never render. getClientRects is the honest check.
  function hostVisible(h){ return !!(h && h.getClientRects && h.getClientRects().length > 0); }
  function anyVisible(){ return hosts.some(hostVisible); }
  function tick(){
    if (document.hidden) return; // zero work while the page is hidden
    if (!anyVisible()) return;
    const s = collect();
    hosts.forEach(h => { if (hostVisible(h)) renderInto(h, s); });
  }

  function start(){
    mountAll();
    tick();
    setInterval(tick, REFRESH_MS);
    window.addEventListener("storage", tick);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    // Tab switches and panel visibility refresh immediately (desktop hidden attr, mobile .active
    // class) instead of waiting for the next tick.
    const seen = new Set();
    hosts.forEach(h => {
      [h, h.parentElement].forEach(t => {
        if (!t || seen.has(t)) return;
        seen.add(t);
        new MutationObserver(tick).observe(t, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

globalThis.DEFAULT_CTX = DEFAULT_CTX;
globalThis.makeCats = makeCats;
globalThis.fmtTok = fmtTok;
globalThis.fmtPct = fmtPct;
globalThis.fmtAgo = fmtAgo;
globalThis.detectCtx = detectCtx;
globalThis.resolveCtxWindow = resolveCtxWindow;
globalThis.parseCtxInput = parseCtxInput;
globalThis.collectSnapshot = collectSnapshot;
globalThis.usageHtml = usageHtml;
globalThis.catRowsHtml = catRowsHtml;
globalThis.lastReqHtml = lastReqHtml;
globalThis.sysHtml = sysHtml;
})();
