// Browser wiring (injected by tooling/l0/emit.mjs): the tool_search runtime's implementation lives in
// services/policy/tool-search.ts; toolSearchSchema arrives through the tool-policy product's emit
// globalThis bridge. The old frozen namespace is retired (no readers remain).
