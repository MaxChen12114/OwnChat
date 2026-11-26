// ── Sub-agent delegation (2026-11-21): the recursion policy and the child's least-privilege set
// live in services/agent/subagent.ts. There is no IO to inject — the tools bundle constructs the
// instance, because it is the side that owns the registry factory, and injecting the factory the
// other way round would be a cycle. Emit's global bridge publishes createSubagent for that caller.
