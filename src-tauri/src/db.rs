// db.rs — the desktop side of the unified store: `db_migrate` / `db_exec` / `db_tx` over rusqlite.
//
// Shape notes that matter to the JS adapter (services/platform/db-tauri.ts):
//   · params arrive JSON-encoded. Scalars bind as-is, `{"__b64":"..."}` binds as a BLOB, and any
//     other object/array is refused: the TS port already normalises bindings, so a stray object here
//     is a bug, not a case to guess at.
//   · results are row objects; BLOB columns come back as `{"__b64":"..."}`, exactly the wire shape
//     src/data-api.js uses, so the three runtimes answer alike.
//   · `db_tx` runs every statement in one rusqlite transaction: any failure rolls all of them back.
//     Reads inside a transaction are refused with a clear message — the DbPort contract has no
//     interactive transactions (D1 has no way to express one), and silently allowing them here
//     would make Tauri the only host where a caller's read-inside-tx works.
//   · `db_migrate` is idempotent, recorded in `_migrations`, and refuses to build half a schema when
//     the SQLite build lacks FTS5 (the search surfaces would be missing while every other table
//     exists — a failure that would only surface as "search finds nothing").
//
// open_db() is lib.rs's (same data directory, same ownchat.db); this module never opens its own
// connection path.
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value as Json};

use crate::open_db;

/// Migration files, in application order. `include_str!` keeps them compiled into the binary: the
/// desktop app has no src/ tree at runtime, so reading them from disk would fail on a released build.
const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_chat_events.sql", include_str!("../../migrations/0001_chat_events.sql")),
    ("0002_unified.sql", include_str!("../../migrations/0002_unified.sql")),
    ("0003_workspace_versions.sql", include_str!("../../migrations/0003_workspace_versions.sql")),
    ("0004_memory_fts_terms.sql", include_str!("../../migrations/0004_memory_fts_terms.sql")),
];

/// One collected statement from `DbPort.transaction`.
#[derive(Deserialize)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Option<Vec<Json>>,
}

/// Milliseconds since the epoch, for the `_migrations` ledger only.
fn now_ms() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

/// JSON → SQLite binding. The TS port has already narrowed the domain; this is the second gate that
/// keeps an unrelated object from being stringified into a column by accident.
fn json_to_sql(value: Json) -> Result<rusqlite::types::Value, String> {
    use rusqlite::types::Value;
    Ok(match value {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(if b { 1 } else { 0 }),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                Value::Real(f)
            } else {
                return Err("number out of range".to_string());
            }
        }
        Json::String(s) => Value::Text(s),
        Json::Object(o) => {
            let b64 = o
                .get("__b64")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "only {\"__b64\":\"...\"} objects are bindable".to_string())?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("invalid base64: {e}"))?;
            Value::Blob(bytes)
        }
        Json::Array(_) => return Err("arrays are not bindable (serialise JSON yourself)".to_string()),
    })
}

/// Bind list for one statement, with the failing index named.
fn to_sql_values(params: Option<Vec<Json>>) -> Result<Vec<rusqlite::types::Value>, String> {
    let list = params.unwrap_or_default();
    let mut out = Vec::with_capacity(list.len());
    for (i, value) in list.into_iter().enumerate() {
        out.push(json_to_sql(value).map_err(|m| format!("params[{i}]: {m}"))?);
    }
    Ok(out)
}

/// SQLite value → the JSON wire shape (`{__b64}` for blobs).
fn sql_ref_to_json(value: rusqlite::types::ValueRef<'_>) -> Json {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({
            "__b64": base64::engine::general_purpose::STANDARD.encode(b)
        }),
    }
}

/// Apply every migration not yet in the ledger, in one transaction.
///
/// FTS5 is checked first: `0002_unified.sql` builds three FTS5 tables, and a build without FTS5
/// would fail halfway through the file. Refusing up front turns that into one clear error.
fn apply_migrations(conn: &mut rusqlite::Connection) -> Result<(), String> {
    let fts5: i64 = conn
        .query_row("SELECT sqlite_compileoption_used('ENABLE_FTS5')", [], |row| row.get(0))
        .map_err(|e| format!("db_migrate: cannot read compile options: {e}"))?;
    if fts5 != 1 {
        return Err(
            "db_migrate: this SQLite build has no FTS5 (ENABLE_FTS5=0); the search surfaces cannot be created, refusing to build a partial schema"
                .to_string(),
        );
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ts INTEGER NOT NULL)",
        [],
    )
    .map_err(|e| format!("db_migrate: ledger unavailable: {e}"))?;

    let tx = conn.transaction().map_err(|e| format!("db_migrate: {e}"))?;
    {
        let mut find = tx
            .prepare("SELECT COUNT(*) FROM _migrations WHERE name = ?1")
            .map_err(|e| format!("db_migrate: {e}"))?;
        let mut record = tx
            // OR IGNORE: the Node host may apply the same ledger concurrently (server/local.mjs); a
            // duplicate-key race must not roll back an otherwise successful migration.
            .prepare("INSERT OR IGNORE INTO _migrations (name, ts) VALUES (?1, ?2)")
            .map_err(|e| format!("db_migrate: {e}"))?;
        for &(name, sql) in MIGRATIONS {
            let applied: i64 = find
                .query_row(rusqlite::params![name], |row| row.get(0))
                .map_err(|e| format!("db_migrate: ledger read failed: {e}"))?;
            if applied > 0 {
                continue;
            }
            tx.execute_batch(sql).map_err(|e| format!("db_migrate: {name} failed: {e}"))?;
            record
                .execute(rusqlite::params![name, now_ms()])
                .map_err(|e| format!("db_migrate: ledger write failed: {e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("db_migrate: commit failed: {e}"))
}

/// Run one statement. Reads take the query path (rows out); writes take the execute path (no rows),
/// which is the same split src/data-api.js sees: `{rows:[]}` for writes.
fn exec_one(conn: &rusqlite::Connection, sql: &str, params: Option<Vec<Json>>) -> Result<Vec<Json>, String> {
    if sql.trim().is_empty() {
        return Err("db_exec: sql is required".to_string());
    }
    let binds = to_sql_values(params)?;
    let mut stmt = conn.prepare(sql).map_err(|e| format!("db_exec: {e}"))?;
    if stmt.column_count() == 0 {
        stmt.execute(rusqlite::params_from_iter(binds.iter()))
            .map_err(|e| format!("db_exec: {e}"))?;
        return Ok(Vec::new());
    }
    // Column names must be owned before `query` takes the statement mutably.
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(binds.iter()))
        .map_err(|e| format!("db_exec: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("db_exec: {e}"))? {
        let mut obj = serde_json::Map::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            let value = row.get_ref(i).map_err(|e| format!("db_exec: {e}"))?;
            obj.insert(name.clone(), sql_ref_to_json(value));
        }
        out.push(Json::Object(obj));
    }
    Ok(out)
}

/// Run the collected statements in one transaction and return the total change count.
fn tx_statements(conn: &mut rusqlite::Connection, statements: Vec<Statement>) -> Result<u64, String> {
    if statements.is_empty() {
        return Err("db_tx: statements is required".to_string());
    }
    let tx = conn.transaction().map_err(|e| format!("db_tx: {e}"))?;
    let mut changes: u64 = 0;
    for (i, statement) in statements.into_iter().enumerate() {
        let binds = to_sql_values(statement.params).map_err(|m| format!("statement[{i}] {m}"))?;
        let mut stmt = tx
            .prepare(&statement.sql)
            .map_err(|e| format!("statement[{i}] failed to prepare: {e}"))?;
        if stmt.column_count() > 0 {
            return Err(format!(
                "statement[{i}]: reads are not allowed inside a transaction (scope the read before the call)"
            ));
        }
        let n = stmt
            .execute(rusqlite::params_from_iter(binds.iter()))
            .map_err(|e| format!("statement[{i}] failed: {e}"))?;
        changes += n as u64;
    }
    tx.commit().map_err(|e| format!("db_tx: commit failed: {e}"))?;
    Ok(changes)
}

/// Create/upgrade the schema. Call once before the first exec; idempotent by design.
#[tauri::command]
pub fn db_migrate(app: tauri::AppHandle) -> Result<(), String> {
    let mut conn = open_db(&app)?;
    apply_migrations(&mut conn)
}

/// One statement, rows out (`[]` for writes).
#[tauri::command]
pub fn db_exec(app: tauri::AppHandle, sql: String, params: Option<Vec<Json>>) -> Result<Vec<Json>, String> {
    let conn = open_db(&app)?;
    exec_one(&conn, &sql, params)
}

/// Collected statements, one atomic commit. Returns the summed change count.
#[tauri::command]
pub fn db_tx(app: tauri::AppHandle, statements: Vec<Statement>) -> Result<u64, String> {
    let mut conn = open_db(&app)?;
    tx_statements(&mut conn, statements)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated() -> rusqlite::Connection {
        let mut conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        apply_migrations(&mut conn).expect("apply migrations");
        conn
    }

    #[test]
    fn migrations_are_recorded_and_idempotent() {
        let mut conn = migrated();
        apply_migrations(&mut conn).expect("second run must be a no-op");
        let mut stmt = conn
            .prepare("SELECT name FROM _migrations ORDER BY name")
            .expect("prepare ledger");
        let names: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .expect("query ledger")
            .map(|r| r.expect("row"))
            .collect();
        assert_eq!(names, vec!["0001_chat_events.sql".to_string(), "0002_unified.sql".to_string()]);
    }

    #[test]
    fn messages_insert_is_searchable_through_fts() {
        let conn = migrated();
        exec_one(
            &conn,
            "INSERT INTO messages (id, conv_id, seq, role, content, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            Some(vec![
                json!("m1"),
                json!("c1"),
                json!(1),
                json!("user"),
                json!("小明翻过西墙去看月亮"),
                json!(1),
            ]),
        )
        .expect("insert message");
        let rows = exec_one(
            &conn,
            "SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?1",
            Some(vec![json!("\"翻过西墙\"")]),
        )
        .expect("fts match");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("id").and_then(|v| v.as_str()), Some("m1"));
    }

    #[test]
    fn blob_params_and_results_round_trip() {
        let conn = migrated();
        let b64 = base64::engine::general_purpose::STANDARD.encode([0u8, 1, 250, 255]);
        exec_one(
            &conn,
            "INSERT INTO attachments (id, name, mime, size, body, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            Some(vec![
                json!("a1"),
                json!("x.png"),
                json!("image/png"),
                json!(4),
                json!({ "__b64": b64.clone() }),
                json!(1),
            ]),
        )
        .expect("insert attachment");
        let rows = exec_one(&conn, "SELECT body FROM attachments WHERE id = ?1", Some(vec![json!("a1")]))
            .expect("read attachment");
        assert_eq!(
            rows[0].get("body").and_then(|v| v.get("__b64")).and_then(|v| v.as_str()),
            Some(b64.as_str())
        );
    }

    #[test]
    fn transaction_rolls_back_every_statement() {
        let mut conn = migrated();
        let err = tx_statements(
            &mut conn,
            vec![
                Statement {
                    sql: "INSERT INTO chars (id, name, data) VALUES (?1, ?2, ?3)".to_string(),
                    params: Some(vec![json!("u_1"), json!("甲"), json!("{}")]),
                },
                Statement {
                    sql: "INSERT INTO chars (id, name, data) VALUES (?1, ?2, ?3)".to_string(),
                    params: Some(vec![json!("u_1"), json!("乙"), json!("{}")]),
                },
            ],
        )
        .expect_err("duplicate primary key must fail");
        assert!(err.contains("statement[1]"), "error must name the failing statement: {err}");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chars", [], |row| row.get(0))
            .expect("count chars");
        assert_eq!(count, 0, "the first insert must be rolled back");
    }

    #[test]
    fn transaction_refuses_reads() {
        let mut conn = migrated();
        let err = tx_statements(
            &mut conn,
            vec![Statement { sql: "SELECT 1".to_string(), params: None }],
        )
        .expect_err("a read inside a transaction must be refused");
        assert!(err.contains("reads are not allowed"), "unexpected error: {err}");
    }

    #[test]
    fn undefined_booleans_and_objects_are_rejected() {
        assert!(json_to_sql(json!([1, 2])).is_err());
        assert!(json_to_sql(json!({ "nope": 1 })).is_err());
        assert!(matches!(json_to_sql(json!(true)), Ok(rusqlite::types::Value::Integer(1))));
    }
}
