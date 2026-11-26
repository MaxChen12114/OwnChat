# Bundled Node runtime (placeholder)

The Windows installer ships its own Node 24 runtime so end users never install Node.

CI (`.github/workflows/tauri-build.yml`) copies the runner's `node.exe` to this folder before
`tauri build`, and `tauri.conf.json` bundles `runtime/**/*` as an app resource. The app resolves it
in `src-tauri/src/runtime.rs` (data-dir copy → this resource copy → system PATH).

This placeholder keeps the resource glob valid for source builds that do not stage a runtime; the
real `node.exe` is git-ignored and never committed.
