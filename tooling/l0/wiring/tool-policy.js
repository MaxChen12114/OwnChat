// Browser wiring (injected by tooling/l0/emit.mjs): the policy compiler's implementation lives in
// services/policy/tool-policy.ts (pure, zero imports); its exported names bridge to globalThis
// automatically. The old frozen namespace is retired (no readers remain).
