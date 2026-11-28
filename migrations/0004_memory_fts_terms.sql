-- 0004_memory_fts_terms.sql — index the extracted terms, not just the sentence.
--
-- Why: the pre-SQL engine scored `what` and `terms` together (BM25 over both). 0002 built
-- `memory_fts` with one column (`what`), so a fact whose useful keywords live only in `terms`
-- became unreachable by the lexical arm — the query windows can miss it and the entity arm only
-- helps when an entity name is in the query. This migration restores the old recall surface:
--
--   · the FTS5 table gets a second column, `terms`, of the same external-content table (`epi`);
--   · the three triggers insert/remove both columns, so the index stays in sync on writes;
--   · `rebuild` re-reads every existing epi row through the declared columns, so no separate
--     backfill statement is needed and no row is left behind.
--
-- `terms` is the JSON-string array written by putFacts (`["粮道","西谷"]`). Tokenising the JSON
-- punctuation adds a few harmless trigrams; the words themselves become searchable, which is the
-- point. Ranking keeps the default bm25 weights over both columns.
--
-- Idempotent: the DROP/CREATE sequence runs once per database (the ledger records it), and a manual
-- re-run simply rebuilds the same two-column index.

DROP TRIGGER IF EXISTS epi_ai;
DROP TRIGGER IF EXISTS epi_ad;
DROP TRIGGER IF EXISTS epi_au;
DROP TABLE IF EXISTS memory_fts;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  what,
  terms,
  content=epi,
  content_rowid=rowid,
  tokenize='trigram'
);

CREATE TRIGGER epi_ai AFTER INSERT ON epi BEGIN
  INSERT INTO memory_fts(rowid, what, terms) VALUES (new.rowid, new.what, new.terms);
END;
CREATE TRIGGER epi_ad AFTER DELETE ON epi BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, what, terms) VALUES ('delete', old.rowid, old.what, old.terms);
END;
CREATE TRIGGER epi_au AFTER UPDATE ON epi BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, what, terms) VALUES ('delete', old.rowid, old.what, old.terms);
  INSERT INTO memory_fts(rowid, what, terms) VALUES (new.rowid, new.what, new.terms);
END;

INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');
