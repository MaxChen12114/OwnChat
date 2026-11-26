-- 0003_workspace_versions.sql — T3-C: agent workspace history plus the one-time-import ledger.
--
-- Why this file exists instead of an edit to 0002_unified.sql: 0002 is already recorded in every
-- runtime's ledger (the node sidecar's `_migrations`, the Tauri shell's `_migrations`, and D1's
-- applied migrations), so editing it would leave existing installs without the new tables.
--
-- What the agent workspace actually stores (services/data/agent-workspace.ts, FileStore rows):
--   files    { id:"<convId>::<path>", convId, path, content, bytes, lines, ts }
--   versions { id:"<convId>::<path>#<seq>", scopeKey, convId, path, seq, ts, kind,
--              hash|null, bytes, lines, prevHash|null, fromVersion? }
--   blobs    { id:"<convId>::<hash>", convId, hash, content, bytes }
-- The 0002 `workspace(path PK, cid, content, lines, ts)` table can hold the current file row, but it
-- has no seq/hash/prev_hash/from_version columns and no content-addressed blob table, so the
-- append-only history cannot live there. Two tables are added; `workspace` itself is NOT altered:
-- its `path` column keeps the `<convId>::<path>` storage key that the service and the legacy
-- IndexedDB already use, `cid` holds the conversation id, and the byte count is derived from the
-- content length (no second copy of a number the text already answers).
--
-- `storage_marks` is the completion ledger for the one-time IndexedDB import in both wirings. A mark
-- is written only after every legacy row has been copied. Until then the import retries with
-- INSERT OR REPLACE, so the legacy store stays the source of truth for that data; after the mark the
-- old database is deleted. If deletion is blocked, the mark is what prevents a later retry from
-- resurrecting rows the user has since deleted.
--
-- Idempotent: every statement is CREATE ... IF NOT EXISTS, and this file carries no DML. Runtime
-- parity: the node sidecar scans migrations/*.sql, D1 applies the directory, and the Tauri shell
-- embeds an explicit filename list in src-tauri/src/db.rs. That list must gain this filename when
-- the desktop host batch touches it; until then both wirings probe for these tables, warn loudly
-- and keep using IndexedDB (old data stays visible) rather than writing into a half-built schema.

-- ── Append-only file versions (history) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_versions (
  id           TEXT PRIMARY KEY,          -- <convId>::<path>#<seq>
  scope_key    TEXT NOT NULL,             -- <convId>::<path> (the workspace storage key)
  conv_id      TEXT NOT NULL,
  path         TEXT NOT NULL,             -- real workspace path, no convId prefix
  seq          INTEGER NOT NULL,          -- 0 = baseline; strictly increasing per scope_key
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,             -- write / edit / delete / baseline / restore
  hash         TEXT,                      -- content hash; NULL on a delete record
  bytes        INTEGER NOT NULL,
  lines        INTEGER NOT NULL,
  prev_hash    TEXT,                      -- hash of the previous version of the same file
  from_version INTEGER                    -- restore: the seq this version was restored from
);
CREATE INDEX IF NOT EXISTS idx_wver_scope ON workspace_versions(scope_key, seq);
CREATE INDEX IF NOT EXISTS idx_wver_conv ON workspace_versions(conv_id);

-- ── Content-addressed snapshot texts (one row per distinct text per conversation) ────
CREATE TABLE IF NOT EXISTS workspace_blobs (
  id      TEXT PRIMARY KEY,               -- <convId>::<hash>
  conv_id TEXT NOT NULL,
  hash    TEXT NOT NULL,
  content TEXT NOT NULL,
  bytes   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wblob_conv ON workspace_blobs(conv_id);

-- ── One-time import ledger (workspace + attachments wirings share it) ────────────────
CREATE TABLE IF NOT EXISTS storage_marks (
  name TEXT PRIMARY KEY,                  -- e.g. workspace_idb_v1 / attachments_idb_v1
  ts   INTEGER NOT NULL                   -- when the import completed
);
