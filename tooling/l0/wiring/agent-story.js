// Browser wiring (injected by tooling/l0/emit.mjs): none yet.
//
// services/agent/story.ts is the pure Work/History model: trace records ->
// agents, places and terminal lines. It is loaded from the boot manifest since
// 2026-11-17 but publishes no window.__* contract; the Work/History panel will
// define the one frozen contract when it lands (a single --update-contracts
// run), so this file stays a comment instead of inventing a name now.
