// Browser wiring (injected by l0/emit.mjs): none yet.
//
// services/agent/playback.ts is the pure time-ordered playback: due times,
// catch-up, the unplayed set and stop. It owns no clock or timer; a host passes
// `now`/`setTimer`/`clearTimer`. No window.__* contract and no boot row until
// the Work/History panel consumes it.
