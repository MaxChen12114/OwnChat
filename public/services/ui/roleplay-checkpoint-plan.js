(function () {
/**
 * Roleplay checkpoint UI plan: the pure decisions behind the "save here / restore to here" entry.
 *
 * The store (`services/data/checkpoints.ts`) already sorts by time descending, so the plan only
 * re-sorts defensively (same rule) and shapes rows for rendering. A pre-restore checkpoint is a
 * normal checkpoint with kind `pre-restore`; undoing a restore is restoring to it, which is why
 * the plan only needs to produce its put arguments.
 * @module services/ui/roleplay-checkpoint-plan
 */

/** One checkpoint row as `__checkpoints.list` returns it (subset the UI renders). */
                                  
                      
                           
                        
                      
 

/** Rendering shape for the list panel. */
                                      
                      
                        
                           
                                                           
                        
                                                                                        
                                 
                                                    
                       
 

/** Text shown when `applyRoleplay` refuses (a turn is live). The wiring alerts with it verbatim. */
const RESTORE_REFUSAL = "有回复正在生成，先停止再回退";

/** unknown -> plain-object view; arrays, null and scalars all become null. */
function recOf(value         )                                 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out                          = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Defensive re-sort: time descending, id ascending as the tiebreak (mirrors the store). */
function sortEntries(rows           )                    {
  const out                    = [];
  for (let i = 0; i < rows.length; i++) {
    const rec = recOf(rows[i]);
    if (rec === null) continue;
    const id = typeof rec["id"] === "string" ? rec["id"] : "";
    const ts = typeof rec["ts"] === "number" && isFinite(rec["ts"]) ? rec["ts"] : 0;
    if (id === "") continue;
    out.push({
      id: id,
      subject: typeof rec["subject"] === "string" ? rec["subject"] : "",
      kind: typeof rec["kind"] === "string" && rec["kind"] ? rec["kind"] : "manual",
      ts: ts,
    });
  }
  out.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  return out;
}

/** Local `HH:MM:SS`; the date itself is not shown (the list covers today's session work). */
function formatTime(ts        )         {
  const d = new Date(ts);
  const two = (n        ) => (n < 10 ? "0" + n : String(n));
  return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
}

/** Shape one row for the list panel. */
function entryView(cp                 )                      {
  const isPreRestore = cp.kind === "pre-restore";
  return {
    id: cp.id,
    kind: cp.kind,
    subject: cp.subject,
    time: formatTime(cp.ts),
    isPreRestore: isPreRestore,
    tag: isPreRestore ? "恢复前自动存档" : cp.kind === "manual" ? "手动存档" : cp.kind,
  };
}

/** The arguments for `__checkpoints.put` that snapshot the state right before restoring. */
                                 
                             
                           
                            
                                                                                                 
 

/**
 * Build the pre-restore put arguments.
 * @param convId - the conversation the checkpoints belong to.
 * @param targetId - the checkpoint about to be restored; becomes the `before:` subject.
 * @param captured - the live `captureRoleplay()` payload (already taken by the caller).
 * @param now - the checkpoint timestamp.
 * @returns `{ ok, plan }`, or `{ ok: false, error }` when the target id is empty.
 */
function preRestorePlan(
  convId        ,
  targetId        ,
  captured         ,
  now        ,
)                                                                    {
  const sid = typeof convId === "string" ? convId.trim() : "";
  const tid = typeof targetId === "string" ? targetId.trim() : "";
  if (sid === "") return { ok: false, error: "当前没有会话，无法存档" };
  if (tid === "") return { ok: false, error: "回退目标缺失" };
  return {
    ok: true,
    plan: {
      scope: "roleplay",
      scopeId: sid,
      payload: captured,
      opts: { kind: "pre-restore", subject: "before:" + tid, at: now },
    },
  };
}

// Browser wiring for services/ui/roleplay-checkpoint-plan.ts: the plan functions are pure and
// bridge onto globalThis by emit (sortEntries / entryView / preRestorePlan / RESTORE_REFUSAL);
// the DOM consumer is public/js/text/ui/roleplay-checkpoint-ui.js. Nothing to bind here.
(function () {
  "use strict";
})();

globalThis.RESTORE_REFUSAL = RESTORE_REFUSAL;
globalThis.sortEntries = sortEntries;
globalThis.formatTime = formatTime;
globalThis.entryView = entryView;
globalThis.preRestorePlan = preRestorePlan;
})();
