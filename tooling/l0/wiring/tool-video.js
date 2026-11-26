// ── Video story tools (2026-11-25): the 1-5 segment cap, tail-frame relay, Gitee key fallback and
// per-segment fetch/poll live in services/tools/agent/video. No IO to inject from here: the tools
// bundle passes document, storage, image channels, fetch, onEvent and the DOM factories, because it
// owns every host global. Emit's global bridge publishes createVideoStoryTools for that caller.
