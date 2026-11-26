-- 0002_unified.sql — 唯一持久层（D1 / Node sidecar / Tauri rusqlite 三运行时同构）。
--
-- 真源与投影：`session_events` 是会话的唯一真源，`messages` 是它的投影/检索物化；写入必须在
-- 同一事务里完成（先事件、后投影）。`summaries` 是摘要投影（真源仍是 summary 事件）。
--
-- 相对施工单 §二 的四处修正（T3 的真实代码形状倒逼）：
--   1) epi 增加 vec TEXT：services/memory/core.ts 的向量腿读 row.vec，施工单漏了这列；
--   2) entities 改为通用引用表 (cid, name, kind, ref_id)：现有 ST_ENTS 是「实体 → KB chunkId」，
--      施工单写成 epi_id 对不上；kind='kb' 指 kb_chunks.id，'epi' 保留；
--   3) 补 char_kv：char-memory 的 L3 小本子（char_db_get/set/delete）需要它，施工单的架构图有、
--      schema 段漏；
--   4) 施工单的 `kv` 改名 `native_kv`：server/local.mjs 已经用 `kv` 存 TAVERN_SYNC（key/value 形状
--      不同），同名会撞表；T4-B 的原生 KV 后端用 native_kv。
--   另补 kb_chunks.ord / kb_docs.chars / summaries：都是现有存储的行字段，迁移时不必再拼。
--
-- 单租户假设：不建 user 列，与 /sync 的 default 用户、现有 chat_events 表一致；多账号是后续
-- 的部署形态升级，不是本迁移的事。
--
-- FTS5 tokenizer='trigram' 已在本地 D1（wrangler dev 的 SQLite）与 node:sqlite 双端实测：
-- 外部内容表 / 三个触发器 / bm25() 全部可用。trigram 对 <3 个码点的查询零命中是 SQLite 官方
-- 行为，短查询由 src/data-api.js 的 LIKE 回退承担（同一作用域列 + ESCAPE 转义），不是自造索引。
--
-- 全部 DDL 幂等（IF NOT EXISTS），可重复执行。

-- ── 冷消息：会话正文的投影与检索物化 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id       TEXT PRIMARY KEY,          -- 与客户端 ensureMessageIds 一致（m_<device>_<seq>）
  conv_id  TEXT NOT NULL,
  seq      INTEGER NOT NULL,          -- 会话内序号（单调递增）
  role     TEXT NOT NULL,             -- user / assistant / tool / system
  content  TEXT,                      -- 正文（string，或 vision 的 JSON 数组）
  tool_calls TEXT,                    -- JSON（assistant 工具调用）
  tool_call_id TEXT,                  -- tool 结果的配对 id
  reasoning_content TEXT,
  sc       TEXT,                      -- 场景键：group / char:<id> / free
  speaker_name TEXT,
  ts       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conv_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content=messages,
  content_rowid=rowid,
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- ── 会话事件日志（真源）─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_events (
  id       TEXT PRIMARY KEY,          -- evt_<conv>_<seq>
  conv_id  TEXT NOT NULL,
  seq      INTEGER NOT NULL,          -- 会话内单调递增
  type     TEXT NOT NULL,             -- turn/start | user/message | assistant/message | tool/result | turn/end | summary
  payload  TEXT NOT NULL,             -- JSON（不存密钥 / 不存 UI 临时态）
  ts       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evt_conv_seq ON session_events(conv_id, seq);

-- ── 摘要投影（真源是 summary 事件；这张表供注入/备份/跨设备读取）─────────────────
CREATE TABLE IF NOT EXISTS summaries (
  conv_id  TEXT PRIMARY KEY,
  text     TEXT NOT NULL,
  ts       INTEGER NOT NULL
);

-- ── 角色卡（替代 IDB tavern_chars_v2）──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chars (
  id   TEXT PRIMARY KEY,              -- u_<base36>
  name TEXT NOT NULL,
  data TEXT NOT NULL                  -- 完整 JSON（含 spec / avatar / thresholds）
);
CREATE INDEX IF NOT EXISTS idx_chars_name ON chars(name);

-- ── 记忆 L1/L2（替代 IDB epi store）────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS epi (
  id       TEXT PRIMARY KEY,
  cid      TEXT NOT NULL,             -- 角色 id
  what     TEXT NOT NULL,
  kind     TEXT,                      -- said / heard / whisper / saw / consolidated
  fact_type TEXT,
  fact_kind TEXT,
  entities TEXT,                      -- JSON string[]
  terms    TEXT,                      -- JSON string[]（策略层读取）
  ts       INTEGER NOT NULL,
  "when"   TEXT,
  "where"  TEXT,
  who      TEXT,
  why      TEXT,
  scene    TEXT,
  vec      TEXT                       -- JSON number[]（向量腿；默认关）
);
CREATE INDEX IF NOT EXISTS idx_epi_cid ON epi(cid, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  what,
  content=epi,
  content_rowid=rowid,
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS epi_ai AFTER INSERT ON epi BEGIN
  INSERT INTO memory_fts(rowid, what) VALUES (new.rowid, new.what);
END;
CREATE TRIGGER IF NOT EXISTS epi_ad AFTER DELETE ON epi BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, what) VALUES ('delete', old.rowid, old.what);
END;
CREATE TRIGGER IF NOT EXISTS epi_au AFTER UPDATE ON epi BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, what) VALUES ('delete', old.rowid, old.what);
  INSERT INTO memory_fts(rowid, what) VALUES (new.rowid, new.what);
END;

-- ── 知识库 L4（替代 IDB ST_DOCS / ST_CHUNKS / ST_POSTINGS）──────────────────────
CREATE TABLE IF NOT EXISTS kb_docs (
  id     TEXT PRIMARY KEY,
  cid    TEXT NOT NULL,               -- 角色 id
  title  TEXT,
  size   INTEGER,
  chars  INTEGER,
  ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_docs_cid ON kb_docs(cid);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id      TEXT PRIMARY KEY,           -- <docId>#<ord>
  doc_id  TEXT NOT NULL,
  cid     TEXT NOT NULL,
  chunk   TEXT NOT NULL,              -- ~500 字带重叠
  offset  INTEGER,
  ord     INTEGER,
  FOREIGN KEY (doc_id) REFERENCES kb_docs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kb_cid ON kb_chunks(cid);
CREATE INDEX IF NOT EXISTS idx_kb_doc ON kb_chunks(doc_id, ord);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  chunk,
  content=kb_chunks,
  content_rowid=rowid,
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS kb_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_fts(rowid, chunk) VALUES (new.rowid, new.chunk);
END;
CREATE TRIGGER IF NOT EXISTS kb_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, chunk) VALUES ('delete', old.rowid, old.chunk);
END;
CREATE TRIGGER IF NOT EXISTS kb_au AFTER UPDATE ON kb_chunks BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, chunk) VALUES ('delete', old.rowid, old.chunk);
  INSERT INTO kb_fts(rowid, chunk) VALUES (new.rowid, new.chunk);
END;

-- ── 实体索引（KB 实体扩展用；替代 IDB ST_ENTS）──────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  cid     TEXT NOT NULL,
  name    TEXT NOT NULL,
  kind    TEXT NOT NULL DEFAULT 'kb', -- 'kb' → ref_id=kb_chunks.id；'epi' 保留
  ref_id  TEXT NOT NULL,
  PRIMARY KEY (cid, name, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_ent_cid ON entities(cid, name);

-- ── L3 小本子（替代 IDB kv store；char_db_get/set/delete）──────────────────────
CREATE TABLE IF NOT EXISTS char_kv (
  cid    TEXT NOT NULL,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  PRIMARY KEY (cid, key)
);

-- ── agent 工作区（替代 IDB agent-workspace）─────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace (
  path    TEXT PRIMARY KEY,
  cid     TEXT,                       -- 可空 = 全局
  content TEXT NOT NULL,
  lines   INTEGER,
  ts      INTEGER NOT NULL
);

-- ── 附件（替代 IDB attachment store）───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  mime  TEXT,
  size  INTEGER,
  body  BLOB,                         -- 二进制（图片等）
  text  TEXT,                         -- 文本正文
  ts    INTEGER NOT NULL
);

-- ── 画廊（替代 IDB album store 的索引半边）─────────────────────────────────────
CREATE TABLE IF NOT EXISTS gallery (
  url    TEXT PRIMARY KEY,
  source TEXT,
  ts     INTEGER NOT NULL
);

-- ── 热窗口镜像（桌面/手机 nativeKV 底层；Web 用 localStorage，不入库）─────────────
-- 注意：不叫 kv —— server/local.mjs 的 /sync 模拟已经占用了 kv(key,value,updated_at)。
CREATE TABLE IF NOT EXISTS native_kv (
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (namespace, key)
);
