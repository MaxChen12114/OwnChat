// Browser wiring (injected by l0/emit.mjs): none yet.
//
// services/agent/playback.ts is the pure time-ordered playback: due times,
// catch-up, the unplayed set and stop. It owns no clock or timer; a host passes
// `now`/`setTimer`/`clearTimer`. Loaded from the boot manifest since 2026-11-17;
// no window.__* contract because the Work/History panel that will consume it is
// still unbuilt (see docs/pending-wiring.md, 2026-11-26 decision).
