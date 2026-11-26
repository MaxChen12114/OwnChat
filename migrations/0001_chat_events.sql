-- 实时聊天事件表：/sync/chat/events 的持久化后端。
-- seq 由 D1 自增，作为全局顺序；user 固定 default，与现有 KV key 对齐。
CREATE TABLE IF NOT EXISTS chat_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL DEFAULT 'default',
  conv_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_events_event_id ON chat_events(user, event_id);
CREATE INDEX IF NOT EXISTS chat_events_seq ON chat_events(user, seq);
CREATE INDEX IF NOT EXISTS chat_events_conv ON chat_events(user, conv_id, seq);
