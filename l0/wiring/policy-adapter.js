// Browser wiring (injected by l0/emit.mjs): the registry→policy adapter's implementation lives in
// services/policy/registry-adapter.ts. Its exported names reach the browser through the emit
// globalThis bridge; the old frozen namespace is retired (no readers remain).
