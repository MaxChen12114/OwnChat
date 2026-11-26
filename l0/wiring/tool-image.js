// ── Image tools (2026-11-21): the generation call, its hard 150s ceiling and the result shape
// live in services/agent/tools/image. No IO to inject from here: the tools bundle supplies both
// the facade lookup and the transcript renderer, because it owns the globals and the bubble.
