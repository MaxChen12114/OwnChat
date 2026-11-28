(function () {
/**
 * `history_search`: the model's way back into the archive.
 *
 * Compaction replaces the early transcript with a summary and a seq anchor ("原文 seq 1-328 在归档").
 * This tool searches the `messages` projection for the current conversation — the same rows the
 * FTS/`LIKE` surface serves — and returns the matched originals with their seq so the model can
 * cite them or narrow a follow-up query. It never reads `session_events` directly: the projection
 * is the search contract, and one SQL surface keeps ranking identical to `/api/data/search`.
 *
 * The tool is read-only and scoped: only the active conversation (or the kernel context's
 * `__convId` for a background turn) is searchable, so one role's plot never leaks into another.
 * Absent data plane (pure browser, first boot) answers `{ok:false,error}` — a refused tool, not a
 * silent empty list.
 * @module services/tools/agent/history
 */

                                   
                                                                                                 
                                                                       
                                                                                     
                          
 

                               
                                                                                
 

const HISTORY_SEARCH_DEFAULT = 5;
const HISTORY_SEARCH_MAX = 20;
const HIT_TEXT_MAX = 1200;

function recOf(value         )                          {
  const out                          = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) out[k] = v;
  return out;
}

function strOf(value         )         {
  return value == null ? "" : String(value);
}

function numOf(value         )         {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function errText(e         )         {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return String(e);
}

/** `limit` clamp: blank/invalid → 5, floor, 1..20. */
function clampHistoryLimit(value         )         {
  if (value === null || value === undefined || String(value).trim() === "") return HISTORY_SEARCH_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return HISTORY_SEARCH_DEFAULT;
  return Math.max(1, Math.min(HISTORY_SEARCH_MAX, Math.floor(n)));
}

/** One projected row → the hit shape the model reads (content clipped, speaker materialised). */
function hitOf(rowValue         )                          {
  const row = recOf(rowValue);
  const content = strOf(row["content"]);
  return {
    seq: numOf(row["seq"]) || 0,
    role: strOf(row["role"]),
    speaker: strOf(row["speaker_name"]),
    ts: numOf(row["ts"]) || 0,
    text: content.length > HIT_TEXT_MAX ? content.slice(0, HIT_TEXT_MAX) + "…" : content,
  };
}

function createHistoryTools(ports                  )               {
  function convOf(ctx         )         {
    const fromCtx = strOf(recOf(ctx)["__convId"]);
    if (fromCtx) return fromCtx;
    try {
      return typeof ports.activeConvId === "function" ? strOf(ports.activeConvId()) : "";
    } catch (e) {
      return "";
    }
  }

  async function historySearch(args         , ctx          )                                   {
    const convId = convOf(ctx);
    if (!convId) return { ok: false, error: "没有当前会话（先打开一个对话再检索归档）" };
    const a = recOf(args);
    const query = strOf(a["query"]).trim();
    if (!query) return { ok: false, error: "缺少 query（要回捞的关键词或原句片段）" };
    const limit = clampHistoryLimit(a["limit"]);
    let rows           ;
    try {
      rows = await ports.search(convId, query, limit);
    } catch (e) {
      return { ok: false, error: "历史检索不可用（数据面未连接）：" + errText(e) };
    }
    const hits = (Array.isArray(rows) ? rows : []).map(hitOf);
    if (!hits.length) {
      return {
        ok: true, query: query, hits: [],
        note: "归档里没有命中（不是失败：该会话可能还没压缩过，或原文没有这个词）",
      };
    }
    return {
      ok: true, query: query, hits: hits,
      note: "以上是压缩时归档的原文片段（按相关度排序）。需要更多换关键词再搜。",
    };
  }

  return { historySearch };
}

// ── History archive tool (T3-D, 2026-11-28): query shaping and clipping live in
// services/tools/agent/history. The tools bundle passes the DbPort search and the active
// conversation lookup, so this file stays a marker for the emit map.

globalThis.createHistoryTools = createHistoryTools;
})();
