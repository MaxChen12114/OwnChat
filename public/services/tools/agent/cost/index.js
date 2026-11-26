(function () {
/**
 * `query_cost` — what the user has spent on model tokens.
 *
 * Two things this file exists to keep straight. First, billing mode: only the fast tier is metered,
 * and the note the model reads back has to say which tier it is looking at, or it reports "you have
 * spent ¥0" to someone on the free tier as if that were the whole story. Second, the book: this is
 * token spend, which is separate from reach spend (`reach_cost`, Exa searches), and conflating them
 * makes both numbers wrong.
 *
 * Amounts are formatted here rather than at the call site so every answer is ¥ with four decimals —
 * the stats are tiny (sub-cent), and rounding them to two would show ¥0.00 for a real charge.
 *
 * The mode is injected: this module does not read storage, because what counts as "fast" is the
 * host's definition and may move.
 *
 * @module services/tools/agent/cost
 */

                             
                          
 

                           
                                                                     
                            
                                                
                 
 

                            
                                                                                           
                  
 

                             
              
                
                 
                
                    
                 
                
                 
                 
                
                 
 

                          
                                               
 

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}
function text(v         )         {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function money(v         )         {
  const n = Number(v);
  return "¥" + (Number.isFinite(n) ? n : 0).toFixed(4);
}

function createCostTools(deps          )          {
  async function query(input           )                      {
    const args = recOf(input);
    const facade = deps.cost();
    if (!facade || typeof facade.getCostStats !== "function") {
      return { ok: false, error: "计费模块未就绪 (app.js / window.hostApi.cost)" };
    }

    const mode = deps.mode() === "fast" ? "fast" : "free";
    let stats                         ;
    try {
      stats = recOf(facade.getCostStats());
    } catch (e) {
      const err = recOf(e);
      return { ok: false, error: "读取费用统计失败: " + text(err.message || e) };
    }

    const all = {
      today: money(stats.today),
      week: money(stats.week),
      month: money(stats.month),
      total: money(stats.total),
    };
    const billing = mode === "fast";
    const note = billing
      ? "快速档按量计费（默认 DeepSeek 官方）。此为模型对话 token 费,不含联网搜索费(见 reach_cost)。"
      : "当前为免费档,对话不计费;以下为历史快速档累计。";

    const range = text(args.range) || "all";
    const bucket = all[range                    ];
    if (range !== "all" && bucket) {
      return { ok: true, mode: mode, range: range, cost: bucket, billing: billing, note: note };
    }
    return {
      ok: true,
      mode: mode,
      billing: billing,
      today: all.today,
      week: all.week,
      month: all.month,
      total: all.total,
      note: note,
    };
  }

  return { query };
}

// ── Cost tools (2026-11-21): the two books (token spend vs reach spend), the tier note and the
// ¥ formatting live in services/tools/agent/cost. No IO to inject: the tools bundle passes the
// facade lookup and the billing-mode reader, because it owns both globals.

globalThis.createCostTools = createCostTools;
})();
