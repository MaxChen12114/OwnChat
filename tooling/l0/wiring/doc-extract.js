// Browser wiring retired with the frozen global: no product-side reader remains.
// The engine in services/chat/doc-extract.ts stays a factory; consumers construct it with a
// readZip port (see tooling/scripts/test-doc-extract.mjs), so no window name is mounted here.
