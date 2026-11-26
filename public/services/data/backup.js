(function () {
/**
 * ZIP backup and restore over the unified SQLite store.
 *
 * The contract in one paragraph: export dumps every owned table into one ZIP, `session_events`
 * included; import replaces the local tables wholesale, then rebuilds the `messages` / `summaries`
 * projections from the event truth with `sessionEventsSvc.replay()` — the backup's own projection
 * files are never trusted as the answer. An import that fails anywhere restores an in-memory copy
 * of the pre-import rows, so a rejected archive leaves the device exactly as it was.
 *
 * Why full replacement and not a merge: two event logs cannot be merged without deciding whose
 * seq space wins, and a silent merge is how duplicate conversations appear. The user chose "restore
 * this backup"; the honest behaviour is to make the device equal the backup, and to say so before
 * starting (the card asks for confirmation).
 *
 * Transaction shape: `DbPort.transaction` is collect-then-commit (D1 has no interactive
 * transactions), and one request is capped at 200 statements. A whole database therefore cannot be
 * one atomic statement batch; the import uses bounded multi-row inserts per transaction and keeps an
 * in-memory undo image. A crash *between* those transactions can leave a partial database — the
 * archive is still on disk and a re-import is idempotent, which is the documented recovery path.
 *
 * Not included on purpose: API keys, `cfw_*` settings (localStorage, never touched) and sync
 * cursors. `native_kv` is opt-in and even then secret-looking namespaces are filtered out.
 *
 * Gates are refusals, not truncation: a table over 500 000 rows or a 200 MB table file stops the
 * operation with a message; silently dropping half a backup would be worse than failing.
 *
 * Boundary: no DOM, no localStorage, no fetch. Storage arrives as `DbPort`, ZIP as the two core
 * readers/writers, replay as the session-events service, user-visible refusals as the `alert` port.
 * @module services/data/backup
 */

                                                   

/** Separate emit products bridged on globalThis by the emitter; declared instead of imported. */
                                                                                      

/** The archive format tag written into `manifest.json`. */
const BACKUP_FORMAT = "ownchat-backup";
/** Schema version of the archive's own layout (not the SQLite migration number). */
const BACKUP_VERSION = 1;

                  
           
          
           
          
              
              
           
            
             
              
           

                                 
                     
                 
                
                 
 

                                                                  

/** One archive entry as auctioned by `core/zip-read`; only what this service reads is declared. */
                                     
               
               
                          
 

                                    
                                                                                                            
 

                                     
                                                                  
 

/** The slice of `sessionEventsSvc` the rebuild needs. `replay` derives and rewrites in one go. */
                                          
                                                                                                         
 

                              
                                                                             
               
                                                            
                                                               
                                                                                                
                                                              
                                                                                     
                                                
                 
 

                               
                                                                                 
                       
                                         
                        
 

                                      
                                                                                      
                            
                                                                   
                  
                                
                                                         
                   
 

                                      
                                                  
                  
                                
                                                         
                   
 

                                    
                          
 

                                 
           
                   
                    
                                                                                      
                      
               
                            
               
                    
                     
 

                                   
            
               
                
 

                                                                   

                                 
           
                    
                            
               
                                                                         
                                                      
                     
 

                                   
            
               
                
                                                                                              
                      
 

                                                                   

                                   
           
                            
               
                    
 

                                     
            
               
                
 

                                                                         

                            
       
                                                                        
                                                                        
                                            
 

const DEFAULT_LIMITS               = {
  maxTableRows: 500000,
  maxTableBytes: 200 * 1024 * 1024,
};

/**
 * One statement may carry at most 256 bindings on the Worker route, but Cloudflare D1 itself caps
 * a query at 100 bound parameters — the strictest runtime wins, or a backup that works on the Node
 * sidecar fails on the deployed Worker.
 */
const MAX_PARAMS = 100;
/** One `/api/data/tx` carries at most 200 statements; 120 leaves headroom for the clear batch. */
const MAX_STATEMENTS_PER_TX = 120;
/** Keep one INSERT statement's payload small (a 2 MB attachment becomes ~2.7 MB of base64). */
const MAX_STATEMENT_BYTES = 4 * 1024 * 1024;
/** Keep one transaction's request body well under the Workers/D1 request ceiling. */
const MAX_TX_BYTES = 8 * 1024 * 1024;
/** Rows read per SELECT page. */
const PAGE_ROWS = 2000;
/** ZIP entries: manifest + the tables below. */
const MAX_ENTRIES = 64;

                           
               
                                                                                            
                             
                                                                        
                           
                                                                                   
                     
                                                                          
                       
                                                           
                            
 

/**
 * The owned tables. Insert order matters: `session_events` first (the truth), parents before
 * children (`kb_docs` before `kb_chunks`), and the two projections last (legacy rows only).
 */
const TABLES                             = [
  {
    name: "session_events",
    columns: ["id", "conv_id", "seq", "type", "payload", "ts"],
    order: ["conv_id ASC", "seq ASC"],
  },
  {
    name: "chars",
    columns: ["id", "name", "data"],
    order: ["id ASC"],
  },
  {
    name: "epi",
    columns: ["id", "cid", "what", "kind", "fact_type", "fact_kind", "entities", "terms", "ts", "when", "where", "who", "why", "scene", "vec"],
    order: ["cid ASC", "ts ASC", "id ASC"],
  },
  {
    name: "kb_docs",
    columns: ["id", "cid", "title", "size", "chars", "ts"],
    order: ["cid ASC", "id ASC"],
  },
  {
    name: "kb_chunks",
    columns: ["id", "doc_id", "cid", "chunk", "offset", "ord"],
    order: ["doc_id ASC", "ord ASC", "id ASC"],
  },
  {
    name: "entities",
    columns: ["cid", "name", "kind", "ref_id"],
    order: ["cid ASC", "name ASC", "kind ASC", "ref_id ASC"],
  },
  {
    name: "char_kv",
    columns: ["cid", "key", "value", "ts"],
    order: ["cid ASC", "key ASC"],
  },
  {
    name: "workspace",
    columns: ["path", "cid", "content", "lines", "ts"],
    order: ["path ASC"],
  },
  {
    name: "workspace_versions",
    columns: ["id", "scope_key", "conv_id", "path", "seq", "ts", "kind", "hash", "bytes", "lines", "prev_hash", "from_version"],
    order: ["scope_key ASC", "seq ASC", "id ASC"],
  },
  {
    name: "workspace_blobs",
    columns: ["id", "conv_id", "hash", "content", "bytes"],
    order: ["conv_id ASC", "hash ASC", "id ASC"],
  },
  {
    name: "attachments",
    columns: ["id", "name", "mime", "size", "body", "text", "ts"],
    order: ["id ASC"],
    blobs: ["body"],
  },
  {
    name: "gallery",
    columns: ["url", "source", "ts"],
    order: ["url ASC"],
  },
  {
    name: "native_kv",
    columns: ["namespace", "key", "value", "updated_at"],
    order: ["namespace ASC", "key ASC"],
    optional: true,
  },
  {
    name: "messages",
    columns: ["id", "conv_id", "seq", "role", "content", "tool_calls", "tool_call_id", "reasoning_content", "sc", "speaker_name", "ts"],
    order: ["conv_id ASC", "seq ASC"],
    projection: true,
  },
  {
    name: "summaries",
    columns: ["conv_id", "text", "ts"],
    order: ["conv_id ASC"],
    projection: true,
  },
];

/** Reserved words this schema actually uses as column names. */
const RESERVED_IDENTS                    = {
  key: 1, when: 1, where: 1, offset: 1, order: 1, group: 1, values: 1, index: 1,
};

/** `key` → `"key"`; everything else passes through. Constants only — never user text. */
function sqlIdent(name        )         {
  return Object.prototype.hasOwnProperty.call(RESERVED_IDENTS, name) ? '"' + name + '"' : name;
}

function selectList(spec                 )         {
  return spec.columns.map(sqlIdent).join(", ");
}

function insertHead(spec                 )         {
  return "INSERT INTO " + spec.name + " (" + spec.columns.map(sqlIdent).join(", ") + ") VALUES ";
}

function specOf(name        )                         {
  for (let i = 0; i < TABLES.length; i++) if (TABLES[i].name === name) return TABLES[i];
  return null;
}

/* ── small value bridges (no assertions) ─────────────────────────────────────────────── */

function recOf(value         )                          {
  const out                          = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i][0];
    // Archive JSON is untrusted: a `__proto__` own key must not become this object's prototype
    // (the row validators reject the key anyway; this keeps option/manifest reads honest).
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    out[key] = entries[i][1];
  }
  return out;
}

function strOf(value         )         {
  return value === null || value === undefined ? "" : String(value);
}

function numOf(value         , fallback        )         {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function errText(e         )         {
  if (e instanceof Error && e.message) return e.message;
  const msg = recOf(e)["message"];
  if (typeof msg === "string" && msg) return msg;
  return String(e);
}

function codeOf(e         )         {
  const code = recOf(e)["code"];
  return typeof code === "string" && code ? code : "BACKUP_FAILED";
}

function backupError(code        , message        )        {
  return Object.assign(new Error(message), { code: code });
}

function isPlainObject(value         )                                   {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeLimits(raw         )               {
  const o = recOf(raw);
  return {
    maxTableRows: numOf(o["maxTableRows"], DEFAULT_LIMITS.maxTableRows),
    maxTableBytes: numOf(o["maxTableBytes"], DEFAULT_LIMITS.maxTableBytes),
  };
}

function emitProgress(fn                              , progress                )       {
  if (typeof fn !== "function") return;
  try {
    fn(progress);
  } catch (e) {
    // A broken progress listener must not abort a backup.
  }
}

/** Narrow an unknown option to the progress callback without a type assertion. */
function progressOf(value         )                               {
  if (typeof value !== "function") return undefined;
  return function (progress                )       {
    value(progress);
  };
}

/** `ownchat-backup-YYYY-MM-DD.zip` in local time; the same day twice just overwrites. */
function backupFilename(nowMs        )         {
  const d = new Date(nowMs);
  const year = Number.isFinite(d.getFullYear()) ? d.getFullYear() : 1970;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return "ownchat-backup-" + year + "-" + mm + "-" + dd + ".zip";
}

/** Namespaces/keys that look like secrets, settings or sync cursors are never exported, even opt-in. */
const SECRET_WORD_RE = /(?:^|[._-])(key|keys|secret|token|auth|cred|credential|password|passwd|cursor|session)(?:$|[._-])/i;
const SETTINGS_NAMESPACE_RE = /^(?:cfw|ownchat[-_.]?settings|settings|sync|storage)(?:$|[._-])/i;

function isSecretNamespace(namespace        )          {
  return SETTINGS_NAMESPACE_RE.test(namespace) || SECRET_WORD_RE.test(namespace) || /api[_-]?key/i.test(namespace);
}

/** A native_kv row is skipped when either half looks secret: the platform may keep a secret under
 *  a generic namespace, or a harmless name under a settings namespace. */
function isSecretKv(namespace        , key        )          {
  return isSecretNamespace(namespace) || SECRET_WORD_RE.test(key) || /(?:api|secret|access|private)[_-]?key|authorization/i.test(key);
}

/** Rows of one table, encoded for JSON (`{__b64}` for bytes), paged and capped. */
async function dumpTable(
  port        ,
  spec                 ,
  limits              ,
  onProgress                              ,
  phase             ,
)                   {
  const rows          = [];
  const sql =
    "SELECT " + selectList(spec) + " FROM " + spec.name +
    " ORDER BY " + spec.order.join(", ") +
    " LIMIT " + PAGE_ROWS + " OFFSET ?";
  for (let offset = 0; ; offset += PAGE_ROWS) {
    let page         ;
    try {
      const res = await port.exec(sql, [offset]);
      page = Array.isArray(res.rows) ? res.rows : [];
    } catch (e) {
      throw backupError("TABLE_UNREADABLE", "读取表 " + spec.name + " 失败：" + errText(e));
    }
    for (let i = 0; i < page.length; i++) rows.push(dbWire.encodeRow(page[i]));
    if (rows.length > limits.maxTableRows) {
      throw backupError(
        "TABLE_TOO_MANY_ROWS",
        "表 " + spec.name + " 超过 " + limits.maxTableRows + " 行，备份已拒绝（不做截断）。请先清理或分批导出。",
      );
    }
    emitProgress(onProgress, { phase: phase, table: spec.name, done: rows.length });
    if (page.length < PAGE_ROWS) break;
  }
  return rows;
}

async function countRows(port        , table        )                  {
  try {
    const res = await port.exec("SELECT COUNT(*) AS n FROM " + table, []);
    const row = recOf((res.rows || [])[0]);
    return numOf(row["n"], 0);
  } catch (e) {
    throw backupError("TABLE_UNREADABLE", "读取表 " + table + " 失败：" + errText(e));
  }
}

/** Validate one decoded JSON row against the table spec. Strict: unknown/missing keys are errors. */
function validateRow(spec                 , row         , index        )       {
  if (!isPlainObject(row)) {
    throw backupError("BAD_ROW", "表 " + spec.name + " 第 " + (index + 1) + " 行不是对象");
  }
  const keys = Object.keys(row);
  for (let i = 0; i < keys.length; i++) {
    if (spec.columns.indexOf(keys[i]) < 0) {
      throw backupError("BAD_ROW", "表 " + spec.name + " 第 " + (index + 1) + " 行含未知列 " + keys[i]);
    }
  }
  for (let c = 0; c < spec.columns.length; c++) {
    const col = spec.columns[c];
    if (!Object.prototype.hasOwnProperty.call(row, col)) {
      throw backupError("BAD_ROW", "表 " + spec.name + " 第 " + (index + 1) + " 行缺少列 " + col);
    }
    const value = row[col];
    if (value === null) continue;
    const blob = spec.blobs !== undefined && spec.blobs.indexOf(col) >= 0;
    if (blob) {
      const obj = recOf(value);
      if (!isPlainObject(value) || typeof obj["__b64"] !== "string" || Object.keys(obj).length !== 1) {
        throw backupError("BAD_ROW", "表 " + spec.name + " 第 " + (index + 1) + " 行的二进制列 " + col + " 不是 {__b64} 形态");
      }
      continue;
    }
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) continue;
    throw backupError("BAD_ROW", "表 " + spec.name + " 第 " + (index + 1) + " 行的列 " + col + " 不是标量");
  }
}

/** Values of one row in column order, decoded from the wire shape. */
function rowParams(spec                 , row                         )            {
  const decoded = dbWire.decodeRow(row);
  const out            = [];
  for (let c = 0; c < spec.columns.length; c++) out.push(decoded[spec.columns[c]]);
  return out;
}

/** Conservative wire-size estimate for one row's bindings (UTF-8 ×3 per UTF-16 unit, base64 ×4/3). */
function paramsBytes(params                    )         {
  let total = 0;
  for (let i = 0; i < params.length; i++) {
    const value = params[i];
    if (typeof value === "string") total += value.length * 3 + 8;
    else if (value instanceof Uint8Array) total += Math.ceil((value.length * 4) / 3) + 16;
    else total += 24;
  }
  return total;
}

/**
 * Bounded multi-row inserts: ≤100 bindings per statement (D1's cap), ≤4 MB per statement and
 * ≤8 MB per transaction, ≤120 statements per transaction. A single oversized row still goes out
 * alone (the caps gate the *groups*, never the row) — the 500 000-row / 200 MB gates bound the
 * archive long before a row can be too large.
 */
async function insertRows(
  port        ,
  spec                 ,
  rows                                    ,
  onProgress                              ,
  phase             ,
)                {
  if (!rows.length) return;
  const perRow = spec.columns.length;
  const maxRowsPerStmt = Math.max(1, Math.floor(MAX_PARAMS / perRow));
  const placeholders = "(" + new Array(perRow).fill("?").join(",") + ")";
  const head = insertHead(spec);
  let values           = [];
  let params            = [];
  let stmtBytes = 0;
  let statements                                            = [];
  let txBytes = 0;
  let written = 0;

  async function flushStatements()                {
    if (!statements.length) return;
    const batch = statements;
    statements = [];
    txBytes = 0;
    try {
      await port.transaction(function (tx) {
        for (let i = 0; i < batch.length; i++) tx.exec(batch[i].sql, batch[i].params);
      });
    } catch (e) {
      throw backupError("WRITE_FAILED", "写入表 " + spec.name + " 失败（约第 " + written + " 行）：" + errText(e));
    }
  }

  async function flushStatement()                {
    if (!values.length) return;
    statements.push({ sql: head + values.join(","), params: params });
    values = [];
    params = [];
    stmtBytes = 0;
    if (statements.length >= MAX_STATEMENTS_PER_TX || txBytes >= MAX_TX_BYTES) await flushStatements();
  }

  for (let i = 0; i < rows.length; i++) {
    const p = rowParams(spec, rows[i]);
    const bytes = paramsBytes(p);
    if (values.length >= maxRowsPerStmt || (values.length > 0 && stmtBytes + bytes > MAX_STATEMENT_BYTES)) {
      await flushStatement();
    }
    values.push(placeholders);
    for (let k = 0; k < p.length; k++) params.push(p[k]);
    stmtBytes += bytes;
    txBytes += bytes;
    written = i + 1;
    if (written === rows.length || written % 5000 === 0) {
      emitProgress(onProgress, { phase: phase, table: spec.name, done: written, total: rows.length });
    }
  }
  await flushStatement();
  await flushStatements();
  emitProgress(onProgress, { phase: phase, table: spec.name, done: written, total: rows.length });
}

async function clearTables(port        , specs                            )                {
  await port.transaction(function (tx) {
    // Reverse order: children before parents (kb_chunks before kb_docs), the projection last.
    for (let i = specs.length - 1; i >= 0; i--) tx.exec("DELETE FROM " + specs[i].name, []);
  });
}

/** UTF-8 encode without depending on a text encoder being injected as a port. */
function utf8(text        )             {
  return new TextEncoder().encode(text);
}

function decodeUtf8(bytes            )         {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseJson(bytes                   , label        )          {
  if (!bytes) throw backupError("BAD_ENTRY", label + " 没有数据（不支持的压缩方法或无内容）");
  let text        ;
  try {
    text = decodeUtf8(bytes);
  } catch (e) {
    throw backupError("BAD_JSON", label + " 不是合法的 UTF-8 文本");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw backupError("BAD_JSON", label + " 不是合法 JSON：" + errText(e));
  }
}

                         
             
                   
                    
                      
                              
    
                                                                           
                                                          
                     
 

async function parseArchive(
  zip                   ,
  bytes         ,
  limits              ,
  onProgress                              ,
)                         {
  let result                                                         ;
  try {
    result = await zip.readZip(bytes, {
      maxEntries: MAX_ENTRIES,
      maxSingle: limits.maxTableBytes,
      maxTotal: Math.min(0xffffffff, limits.maxTableBytes * TABLES.length),
      maxRatio: 100000,
    });
  } catch (e) {
    const code = codeOf(e);
    if (code === "ENTRY_TOO_LARGE" || code === "TOTAL_TOO_LARGE") {
      throw backupError("TABLE_TOO_LARGE", "备份内有表超过 " + limits.maxTableBytes + " 字节，已拒绝（不做截断）：" + errText(e));
    }
    throw backupError("BAD_ZIP", "读取备份 ZIP 失败：" + errText(e));
  }
  const entries = Array.isArray(result.entries) ? result.entries : [];
  // Null-prototype name maps: entry names and conv ids come from the archive, and `__proto__`
  // must stay an ordinary key (never this object's prototype).
  const byName                                     = Object.create(null);
  for (let i = 0; i < entries.length; i++) byName[entries[i].name] = entries[i];

  const manifestEntry = byName["manifest.json"];
  if (!manifestEntry) throw backupError("MANIFEST_MISSING", "备份里没有 manifest.json，不是 OwnChat 备份");
  const rawManifest = parseJson(manifestEntry.data, "manifest.json");
  if (!isPlainObject(rawManifest)) throw backupError("BAD_MANIFEST", "manifest.json 不是对象");

  const format = strOf(rawManifest["format"]);
  if (format !== BACKUP_FORMAT) {
    throw backupError("UNSUPPORTED_FORMAT", "这不是 OwnChat 备份（format=" + (format || "空") + "）");
  }
  const version = numOf(rawManifest["version"], 0);
  if (version !== BACKUP_VERSION) {
    throw backupError(
      "UNSUPPORTED_VERSION",
      "备份格式版本 " + version + " 不受支持（本版本只认 " + BACKUP_VERSION + "）；请升级后再导入。",
    );
  }
  const manifestTables = recOf(rawManifest["tables"]);
  const declaredNames = Object.keys(manifestTables);
  if (!declaredNames.length) throw backupError("BAD_MANIFEST", "manifest.json 的 tables 为空");

  const declared                         = {};
  for (let i = 0; i < declaredNames.length; i++) {
    const name = declaredNames[i];
    const spec = specOf(name);
    if (!spec) {
      throw backupError("UNKNOWN_TABLE", "备份包含本版本不认识的表 " + name + "，导入会丢数据；已拒绝。");
    }
    const count = numOf(manifestTables[name], -1);
    if (count < 0) throw backupError("BAD_MANIFEST", "manifest 里表 " + name + " 的行数无效");
    if (count > limits.maxTableRows) {
      throw backupError(
        "TABLE_TOO_MANY_ROWS",
        "备份里表 " + name + " 有 " + count + " 行，超过 " + limits.maxTableRows + " 行上限，已拒绝（不做截断）。",
      );
    }
    declared[name] = count;
  }
  for (let i = 0; i < TABLES.length; i++) {
    const spec = TABLES[i];
    if (spec.optional) continue;
    if (!Object.prototype.hasOwnProperty.call(declared, spec.name)) {
      throw backupError("MISSING_TABLE", "备份缺少表 " + spec.name + "，不是完整的备份");
    }
  }

  // Any table file the manifest did not declare is a schema mismatch, not something to ignore:
  // importing the rest would silently drop it.
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i].name;
    if (name.indexOf("tables/") !== 0 || name.slice(-5) !== ".json") continue;
    const table = name.slice("tables/".length, -5);
    if (!Object.prototype.hasOwnProperty.call(declared, table)) {
      throw backupError("UNDECLARED_TABLE", "备份里有未在 manifest 声明的表文件 " + name + "；已拒绝以免静默丢数据。");
    }
  }

  const warnings           = [];
  const archiveWarnings = Array.isArray(result.warnings) ? result.warnings : [];
  for (let i = 0; i < archiveWarnings.length; i++) {
    const w = recOf(archiveWarnings[i]);
    warnings.push("ZIP 警告 " + strOf(w["code"]) + (w["name"] ? "：" + strOf(w["name"]) : ""));
  }

  const tables                                                  = [];
  let validated = 0;
  for (let i = 0; i < TABLES.length; i++) {
    const spec = TABLES[i];
    if (!Object.prototype.hasOwnProperty.call(declared, spec.name)) continue;
    const entry = byName["tables/" + spec.name + ".json"];
    if (!entry) throw backupError("MISSING_TABLE", "备份缺少表文件 tables/" + spec.name + ".json");
    if (entry.size > limits.maxTableBytes) {
      throw backupError("TABLE_TOO_LARGE", "表 " + spec.name + " 的解压大小超过 " + limits.maxTableBytes + " 字节，已拒绝。");
    }
    const parsed = parseJson(entry.data, "tables/" + spec.name + ".json");
    if (!Array.isArray(parsed)) throw backupError("BAD_JSON", "表 " + spec.name + " 的文件不是数组");
    if (parsed.length !== declared[spec.name]) {
      throw backupError(
        "COUNT_MISMATCH",
        "表 " + spec.name + " 实际 " + parsed.length + " 行，manifest 声明 " + declared[spec.name] + " 行",
      );
    }
    const rows          = [];
    for (let k = 0; k < parsed.length; k++) {
      validateRow(spec, parsed[k], k);
      rows.push(recOf(parsed[k]));
    }
    tables.push({ spec: spec, rows: rows });
    validated++;
    emitProgress(onProgress, { phase: "validate", table: spec.name, done: validated, total: declaredNames.length });
  }
  return {
    manifest: {
      format: format,
      version: version,
      createdAt: strOf(rawManifest["createdAt"]),
      tables: declared,
    },
    tables: tables,
    warnings: warnings,
  };
}

/** Build the service. One instance per page; the wiring publishes it as `window.backupSvc`. */
function createBackupService(ports             )            {
  if (!ports || typeof ports.db !== "function") throw new Error("backup: db 端口是必需的");
  const now = typeof ports.now === "function" ? ports.now : function ()         { return Date.now(); };

  function notify(message        , level         )       {
    if (typeof ports.alert !== "function") return;
    try {
      ports.alert(message, level);
    } catch (e) {
      // A broken toast port must not swallow the result object.
    }
  }

  function fail(code        , error        )                   {
    notify(error, "error");
    return { ok: false, code: code, error: error };
  }

  async function exportAll(options                      )                              {
    const opts = recOf(options);
    const limits = mergeLimits(opts["limits"]);
    const includeNativeKv = opts["includeNativeKv"] === true;
    const reason = strOf(opts["reason"]);
    const onProgress = progressOf(opts["onProgress"]);
    const nowMs = now();
    const createdAt = new Date(nowMs).toISOString();
    try {
      const port = ports.db();
      const entries                                            = [];
      const counts                    = {};
      const warnings           = [];
      let totalRows = 0;

      for (let i = 0; i < TABLES.length; i++) {
        const spec = TABLES[i];
        if (spec.optional && !includeNativeKv) continue;
        const count = await countRows(port, spec.name);
        emitProgress(onProgress, { phase: "count", table: spec.name, done: 0, total: count });
        if (count > limits.maxTableRows) {
          return fail(
            "TABLE_TOO_MANY_ROWS",
            "表 " + spec.name + " 有 " + count + " 行，超过 " + limits.maxTableRows + " 行上限；备份已拒绝（不做截断）。",
          );
        }
        let rows = await dumpTable(port, spec, limits, onProgress, "dump");
        if (spec.name === "native_kv") {
          const kept = rows.filter(function (row) {
            return !isSecretKv(strOf(row["namespace"]), strOf(row["key"]));
          });
          if (kept.length !== rows.length) {
            warnings.push("native_kv 跳过 " + (rows.length - kept.length) + " 行疑似密钥/设置/同步游标的记录");
          }
          rows = kept;
        }
        const json = JSON.stringify(rows);
        const bytes = utf8(json);
        if (bytes.length > limits.maxTableBytes) {
          return fail(
            "TABLE_TOO_LARGE",
            "表 " + spec.name + " 序列化后 " + bytes.length + " 字节，超过 " + limits.maxTableBytes + " 字节上限；备份已拒绝。",
          );
        }
        entries.push({ name: "tables/" + spec.name + ".json", data: bytes });
        counts[spec.name] = rows.length;
        totalRows += rows.length;
        emitProgress(onProgress, { phase: "dump", table: spec.name, done: rows.length, total: rows.length });
      }

      const manifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: createdAt,
        app: "OwnChat",
        reason: reason,
        nativeKv: includeNativeKv,
        tables: counts,
      };
      entries.unshift({ name: "manifest.json", data: utf8(JSON.stringify(manifest, null, 2)) });

      emitProgress(onProgress, { phase: "write", done: entries.length, total: entries.length });
      const writer = await ports.zipWrite();
      const archive = await writer.writeZip(entries, { deflate: true, date: nowMs });
      emitProgress(onProgress, { phase: "done", done: totalRows, total: totalRows });
      return {
        ok: true,
        filename: backupFilename(nowMs),
        createdAt: createdAt,
        archive: archive,
        size: archive.length,
        tables: counts,
        rows: totalRows,
        nativeKv: includeNativeKv,
        warnings: warnings,
      };
    } catch (e) {
      return fail(codeOf(e), errText(e));
    }
  }

  /** Undo image: encoded rows of every table the import will touch. */
  async function snapshotTables(
    port        ,
    specs                            ,
    limits              ,
    onProgress                              ,
  )                                   {
    const out                          = {};
    let done = 0;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const count = await countRows(port, spec.name);
      if (count > limits.maxTableRows) {
        throw backupError(
          "UNDO_TOO_LARGE",
          "本机表 " + spec.name + " 有 " + count + " 行，超过回滚快照上限 " + limits.maxTableRows +
          "；为避免导入失败后无法恢复，本次导入已拒绝。",
        );
      }
      out[spec.name] = await dumpTable(port, spec, limits, onProgress, "snapshot");
      done++;
      emitProgress(onProgress, { phase: "snapshot", table: spec.name, done: done, total: specs.length });
    }
    return out;
  }

  async function restore(
    port        ,
    undo                         ,
    specs                            ,
    onProgress                              ,
  )                {
    emitProgress(onProgress, { phase: "rollback", done: 0, total: specs.length });
    await clearTables(port, specs);
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const rows = undo[spec.name] || [];
      await insertRows(port, spec, rows, onProgress, "rollback");
      emitProgress(onProgress, { phase: "rollback", table: spec.name, done: i + 1, total: specs.length });
    }
  }

  async function importAll(options                      )                              {
    const opts = recOf(options);
    const limits = mergeLimits(opts["limits"]);
    const onProgress = progressOf(opts["onProgress"]);
    const bytes = opts["bytes"];

    let archive               ;
    try {
      const zip = await ports.zipRead();
      emitProgress(onProgress, { phase: "read" });
      archive = await parseArchive(zip, bytes, limits, onProgress);
    } catch (e) {
      return { ok: false, code: codeOf(e), error: errText(e), rolledBack: false };
    }

    const port = ports.db();
    const events = ports.sessionEvents();
    if (!events || typeof events.replay !== "function") {
      const error = "事件服务（sessionEventsSvc）未就绪：没有它就无法从事件真源重建消息投影，导入已拒绝。";
      notify(error, "error");
      return { ok: false, code: "EVENTS_UNAVAILABLE", error: error, rolledBack: true };
    }

    const declared                    = {};
    for (let i = 0; i < archive.tables.length; i++) declared[archive.tables[i].spec.name] = 1;
    const touched                    = [];
    for (let i = 0; i < TABLES.length; i++) {
      const spec = TABLES[i];
      if (spec.optional && !Object.prototype.hasOwnProperty.call(declared, spec.name)) continue;
      touched.push(spec);
    }

    let undo                         ;
    try {
      undo = await snapshotTables(port, touched, limits, onProgress);
    } catch (e) {
      return { ok: false, code: codeOf(e), error: errText(e), rolledBack: true };
    }

    try {
      // Event-backed conversations: every conv id present in the imported event log.
      const eventRows = archive.tables.find(function (t) { return t.spec.name === "session_events"; });
      const eventConvs                    = Object.create(null);
      let rows = 0;
      if (eventRows) {
        rows += eventRows.rows.length;
        for (let i = 0; i < eventRows.rows.length; i++) {
          const conv = strOf(eventRows.rows[i]["conv_id"]);
          if (conv) eventConvs[conv] = 1;
        }
      }
      for (let i = 0; i < archive.tables.length; i++) {
        if (archive.tables[i].spec.name !== "session_events") rows += archive.tables[i].rows.length;
      }

      emitProgress(onProgress, { phase: "clear", done: 0, total: touched.length });
      await clearTables(port, touched);

      const legacyConvs                    = Object.create(null);
      let legacyMessages = 0;
      let doneTables = 0;
      for (let i = 0; i < archive.tables.length; i++) {
        const item = archive.tables[i];
        const spec = item.spec;
        let tableRows                                     = item.rows;
        if (spec.projection) {
          // Do not trust the archive's projection: keep only rows whose conversation has no event
          // truth at all (pre-T3-D data). Everything else is rebuilt from events below.
          const kept          = [];
          for (let k = 0; k < tableRows.length; k++) {
            const conv = strOf(tableRows[k]["conv_id"]);
            if (conv && Object.prototype.hasOwnProperty.call(eventConvs, conv)) continue;
            kept.push(tableRows[k]);
            if (spec.name === "messages") legacyMessages++;
            if (conv) legacyConvs[conv] = 1;
          }
          tableRows = kept;
        }
        await insertRows(port, spec, tableRows, onProgress, "insert");
        doneTables++;
        emitProgress(onProgress, { phase: "insert", table: spec.name, done: doneTables, total: archive.tables.length });
      }

      const convs           = Object.keys(eventConvs).sort();
      let rebuiltMessages = 0;
      let repaired = 0;
      for (let i = 0; i < convs.length; i++) {
        const out = await events.replay(convs[i]);
        if (!out || out.ok !== true) {
          throw backupError(
            "REBUILD_FAILED",
            "会话 " + convs[i] + " 的投影重建失败：" + (out && out.error ? out.error : "replay 未返回 ok"),
          );
        }
        rebuiltMessages += numOf(out.messages, 0);
        repaired += numOf(out.repaired, 0);
        emitProgress(onProgress, { phase: "rebuild", table: "messages", done: i + 1, total: convs.length });
      }

      const warnings = archive.warnings.slice();
      const legacyConvCount = Object.keys(legacyConvs).length;
      if (legacyConvCount > 0) {
        warnings.push(
          "有 " + legacyConvCount + " 个会话只有消息投影、没有事件真源（旧格式数据），已按备份里的投影保留。",
        );
      }
      emitProgress(onProgress, { phase: "done", done: rows, total: rows });
      return {
        ok: true,
        createdAt: archive.manifest.createdAt,
        tables: archive.manifest.tables,
        rows: rows,
        rebuilt: { conversations: convs.length, messages: rebuiltMessages, repaired: repaired },
        legacy: { conversations: legacyConvCount, messages: legacyMessages },
        warnings: warnings,
      };
    } catch (e) {
      const original = codeOf(e) + "：" + errText(e);
      try {
        await restore(port, undo, touched, onProgress);
      } catch (restoreError) {
        const error = original + "；回滚也失败：" + errText(restoreError) + "（本机数据可能不完整，请重新导入备份）";
        notify(error, "error");
        return { ok: false, code: "ROLLBACK_FAILED", error: error, rolledBack: false };
      }
      const error = original + "；已回滚到导入前的数据。";
      notify(error, "error");
      return { ok: false, code: codeOf(e), error: error, rolledBack: true };
    }
  }

  async function snapshot()                                {
    try {
      const port = ports.db();
      const counts                    = {};
      const missing           = [];
      let rows = 0;
      for (let i = 0; i < TABLES.length; i++) {
        const spec = TABLES[i];
        try {
          const count = await countRows(port, spec.name);
          counts[spec.name] = count;
          rows += count;
        } catch (e) {
          missing.push(spec.name);
          counts[spec.name] = 0;
        }
      }
      return { ok: true, tables: counts, rows: rows, missing: missing };
    } catch (e) {
      return { ok: false, code: codeOf(e), error: errText(e) };
    }
  }

  return { v: 1, exportAll: exportAll, importAll: importAll, snapshot: snapshot };
}

// Browser wiring, appended by l0/emit.mjs. Engine: services/data/backup.ts (ZIP export/import over
// the unified SQLite store). This file owns the two platform exits, the settings card and the
// frozen facade.
//
// Public API (non-`__` on purpose; contracts.json tracks `__*` only):
//   window.backupSvc = { v, exportAll, importAll, snapshot }
//   window.backupCard = { mount }
//
// exportAll() exports, then *saves* the archive (Tauri `export_binary_file`, or a Blob download in
// the browser) and resolves with a receipt — a programmatic caller such as T4-C's first-connect
// backup gets a file on disk, not bytes it has to know how to persist. The service itself stays
// DOM-free; the bytes come back on `archive`.
//
// ZIP cores are loaded on demand (`/shared/core/zip-read.js` / `zip-write.js`), same posture as the
// skill-pack importer: a user who never opens the backup card pays nothing at boot.
(function (g) {
  "use strict";
  if (g.backupSvc) return;

  var loaders = {};
  function loadScriptOnce(src) {
    if (loaders[src]) return loaders[src];
    loaders[src] = new Promise(function (resolve, reject) {
      if (typeof g.document === "undefined") {
        reject(new Error("无法加载 " + src + "：当前环境没有 document"));
        return;
      }
      var el = g.document.createElement("script");
      el.src = src;
      el.onload = function () { resolve(); };
      el.onerror = function () { delete loaders[src]; reject(new Error("加载失败：" + src)); };
      g.document.head.appendChild(el);
    });
    return loaders[src];
  }

  function ensure(name, src) {
    if (g[name]) return Promise.resolve(g[name]);
    return loadScriptOnce(src).then(function () {
      if (!g[name]) throw new Error(src + " 已加载但没有暴露 " + name);
      return g[name];
    });
  }

  function db() {
    var svc = g.dbSvc;
    if (!svc || typeof svc.get !== "function") throw new Error("backup: dbSvc 未加载");
    return svc.get();
  }

  function zipRead() {
    return ensure("ZipRead", "/shared/core/zip-read.js").then(function (reader) {
      if (!reader || typeof reader.readZip !== "function") throw new Error("ZIP 读取器未就绪");
      return reader;
    });
  }

  function zipWrite() {
    return ensure("ZipWrite", "/shared/core/zip-write.js").then(function (writer) {
      if (!writer || typeof writer.writeZip !== "function") throw new Error("ZIP 写入器未就绪");
      return writer;
    });
  }

  function sessionEvents() {
    return g.sessionEventsSvc || null;
  }

  function toast(message, type) {
    try {
      if (g.feedbackSvc && typeof g.feedbackSvc.toast === "function") {
        g.feedbackSvc.toast(String(message), { type: type || "info", ms: 6000 });
      }
    } catch (e) { /* a missing toast must not break the operation */ }
  }

  var service = createBackupService({
    db: db,
    zipRead: zipRead,
    zipWrite: zipWrite,
    sessionEvents: sessionEvents,
    alert: function (message, level) { toast(message, level === "error" ? "err" : "warn"); },
    now: function () { return Date.now(); },
  });

  /* ── binary exit: Tauri writes through its own command, the browser clicks an anchor ───────── */

  function bytesToBase64(bytes) {
    try {
      if (g.dbWire && typeof g.dbWire.bytesToBase64 === "function") return g.dbWire.bytesToBase64(bytes);
    } catch (e) { /* fall through to the local copy */ }
    var out = "";
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return g.btoa(out);
  }

  function saveBinary(name, bytes) {
    var invoke = null;
    try {
      if (g.tauriSvc && typeof g.tauriSvc.invokeOrNull === "function") invoke = g.tauriSvc.invokeOrNull();
    } catch (e) { invoke = null; }
    if (invoke) {
      return Promise.resolve(invoke("export_binary_file", {
        suggestedName: name,
        base64Data: bytesToBase64(bytes),
      })).then(function (path) {
        if (path) return { mode: "tauri", path: String(path), cancelled: false };
        return { mode: "tauri", path: "", cancelled: true };
      });
    }
    return new Promise(function (resolve, reject) {
      try {
        var blob = new g.Blob([bytes], { type: "application/zip" });
        var url = g.URL.createObjectURL(blob);
        var a = g.document.createElement("a");
        a.href = url;
        a.download = name;
        a.rel = "noopener";
        a.style.position = "fixed";
        a.style.left = "-9999px";
        a.style.top = "-9999px";
        g.document.body.appendChild(a);
        a.dispatchEvent(new g.MouseEvent("click", { bubbles: true, cancelable: true, view: g }));
        // The anchor and the object URL must outlive the click on a slow machine (save-file.js uses
        // the same 4 s schedule and learned this the hard way).
        g.setTimeout(function () {
          try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
          try { g.URL.revokeObjectURL(url); } catch (e) {}
        }, 4000);
        resolve({ mode: "browser", path: name, cancelled: false });
      } catch (e) {
        reject(e);
      }
    });
  }

  function errText(e) {
    if (e && e.message) return String(e.message);
    return String(e);
  }

  /* ── facade ──────────────────────────────────────────────────────────────────────────────── */

  function exportAll(options) {
    return Promise.resolve(service.exportAll(options)).then(function (result) {
      if (!result || result.ok !== true) return result;
      return saveBinary(result.filename, result.archive).then(function (saved) {
        if (saved.cancelled) {
          return { ok: false, code: "SAVE_CANCELLED", error: "已取消保存（未写盘）", cancelled: true };
        }
        return {
          ok: true,
          filename: result.filename,
          path: saved.path,
          mode: saved.mode,
          size: result.size,
          createdAt: result.createdAt,
          tables: result.tables,
          rows: result.rows,
          nativeKv: result.nativeKv,
          warnings: result.warnings,
        };
      }, function (error) {
        return { ok: false, code: "SAVE_FAILED", error: "写盘失败：" + errText(error) };
      });
    }, function (error) {
      return { ok: false, code: "EXPORT_FAILED", error: errText(error) };
    });
  }

  function importAll(options) {
    return Promise.resolve(service.importAll(options)).then(function (result) {
      // A successful import made the database equal the archive; the old hot window in localStorage
      // is now a stale overlay (hydrate() merges hot over cold by id). Drop it before the card
      // reloads, or the first page load after a restore would show pre-import tails and could
      // re-archive them as fresh events. Settings/conversation-list keys stay.
      if (result && result.ok === true) clearLocalChatCache();
      return result;
    }, function (error) {
      return { ok: false, code: "IMPORT_FAILED", error: errText(error), rolledBack: false };
    });
  }

  /** Hot-window keys only (services/session/store.ts owns their names). Never settings or keys. */
  var LS_CHAT_CACHE_KEYS = [
    "cfw_chat_session_v1",
    "cfw_chat_slot_meta_v1",
    "cfw_chat_tomb_v1",
    "cfw_chat_cold_pending_v1",
    "cfw_chat_archived_v1",
  ];

  function clearLocalChatCache() {
    for (var i = 0; i < LS_CHAT_CACHE_KEYS.length; i++) {
      try { g.localStorage.removeItem(LS_CHAT_CACHE_KEYS[i]); } catch (e) { /* private mode */ }
    }
  }

  function snapshot() {
    return Promise.resolve(service.snapshot());
  }

  g.backupSvc = {
    v: 1,
    exportAll: exportAll,
    importAll: importAll,
    snapshot: snapshot,
  };

  /* ── settings card (「数据」分类：账号 · 数据 · 同步) ──────────────────────────────────────── */

  var busy = false;

  function setText(id, text) {
    var el = g.document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setBusy(value) {
    busy = value;
    var exportBtn = g.document.getElementById("backupExportBtn");
    var importBtn = g.document.getElementById("backupImportBtn");
    if (exportBtn) exportBtn.disabled = value;
    if (importBtn) importBtn.disabled = value;
  }

  function progressText(p) {
    if (!p) return "";
    var table = p.table ? " " + p.table : "";
    var count = (p.done == null) ? "" : "（" + p.done + (p.total == null ? "" : "/" + p.total) + "）";
    switch (p.phase) {
      case "count": return "统计" + table + count;
      case "dump": return "导出中：" + table + count;
      case "write": return "打包 ZIP…";
      case "read": return "读取备份…";
      case "validate": return "校验" + table + count;
      case "snapshot": return "备份本机当前数据（回滚用）" + table + count;
      case "clear": return "清空本机表…";
      case "insert": return "导入中" + table + count;
      case "rebuild": return "从事件日志重建消息索引" + count;
      case "rollback": return "回滚中" + table + count;
      default: return "完成";
    }
  }

  function onProgress(p) {
    setText("backupProgress", progressText(p));
  }

  function refreshSummary() {
    return snapshot().then(function (s) {
      if (!s || s.ok !== true) {
        setText("backupStatus", "读取本机数据量失败：" + (s && s.error ? s.error : "未知错误"));
        return;
      }
      var tables = 0;
      for (var k in s.tables) { if (Object.prototype.hasOwnProperty.call(s.tables, k)) tables++; }
      setText("backupStatus", "本机现有 " + tables + " 张表 / " + s.rows + " 行数据。");
    }, function (error) {
      setText("backupStatus", "读取本机数据量失败：" + errText(error));
    });
  }

  function confirmImport() {
    var message = "导入会用备份内容替换本机全部数据（会话、角色卡、记忆、知识库、工作区、附件、画廊），"
      + "随后从事件日志重建消息索引并刷新页面。建议先导出一份当前数据。确定继续？";
    try {
      if (g.feedbackSvc && typeof g.feedbackSvc.confirm === "function") {
        return g.feedbackSvc.confirm({
          title: "导入备份",
          message: message,
          okText: "导入并替换",
          cancelText: "取消",
          danger: true,
        });
      }
    } catch (e) { /* fall through to the native confirm */ }
    try {
      return Promise.resolve(!!(g.confirm && g.confirm(message)));
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function alertDialog(message) {
    try {
      if (g.feedbackSvc && typeof g.feedbackSvc.alert === "function") {
        return g.feedbackSvc.alert({ title: "数据备份", message: message });
      }
    } catch (e) { /* fall through */ }
    try { if (g.alert) g.alert(message); } catch (e) {}
    return Promise.resolve();
  }

  function doExport() {
    if (busy) return;
    setBusy(true);
    setText("backupProgress", "");
    var nativeToggle = g.document.getElementById("backupNativeKv");
    var includeNativeKv = !!(nativeToggle && nativeToggle.checked);
    exportAll({ includeNativeKv: includeNativeKv, reason: "manual", onProgress: onProgress }).then(function (result) {
      setBusy(false);
      setText("backupProgress", "");
      if (!result || result.ok !== true) {
        setText("backupStatus", "导出失败：" + (result && result.error ? result.error : "未知错误"));
        return;
      }
      var tableCount = 0;
      for (var k in result.tables) { if (Object.prototype.hasOwnProperty.call(result.tables, k)) tableCount++; }
      var mb = (result.size / (1024 * 1024)).toFixed(2);
      setText("backupStatus", "已导出 " + tableCount + " 张表 / " + result.rows + " 行（" + mb + " MB）→ "
        + (result.mode === "tauri" ? result.path : result.filename));
      if (result.warnings && result.warnings.length) {
        setText("backupStatus", "已导出（有 " + result.warnings.length + " 条提示）：" + result.warnings.join("；"));
      }
      refreshSummary();
    }, function (error) {
      setBusy(false);
      setText("backupStatus", "导出失败：" + errText(error));
    });
  }

  function doImport(bytes, filename) {
    confirmImport().then(function (ok) {
      if (!ok) return;
      if (busy) return;
      setBusy(true);
      setText("backupStatus", "正在导入 " + filename + " …");
      importAll({ bytes: bytes, onProgress: onProgress }).then(function (result) {
        if (!result || result.ok !== true) {
          setBusy(false);
          var message = (result && result.error) ? result.error : "未知错误";
          if (result && result.rolledBack === false && result.code === "ROLLBACK_FAILED") {
            message += "\n\n本机数据可能不完整，请重新导入同一份备份。";
          }
          setText("backupStatus", "导入失败：" + message);
          alertDialog("导入失败：" + message);
          return;
        }
        setText("backupStatus", "导入完成：" + result.rows + " 行，重建 " + result.rebuilt.conversations
          + " 个会话 / " + result.rebuilt.messages + " 条消息。正在刷新页面…");
        toast("导入完成，正在刷新页面", "ok");
        g.setTimeout(function () {
          try { g.location.reload(); } catch (e) {}
        }, 900);
      }, function (error) {
        setBusy(false);
        setText("backupStatus", "导入失败：" + errText(error));
        alertDialog("导入失败：" + errText(error));
      });
    });
  }

  function mountCard() {
    var slot = null;
    try {
      slot = g.slotRegistry && typeof g.slotRegistry.pick === "function" ? g.slotRegistry.pick("setAccountSlot") : null;
    } catch (e) { slot = null; }
    if (slot && g.slotRegistry && typeof g.slotRegistry.claim === "function") {
      try { g.slotRegistry.claim({ cardId: "dataBackupCard", slotId: "setAccountSlot" }); } catch (e) {}
    }
    if (!slot || g.document.getElementById("dataBackupCard")) return;

    var card = g.document.createElement("div");
    card.className = "card";
    card.id = "dataBackupCard";
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 7.5h15v12h-15z"/><path d="M8 7.5V5.5h8v2"/><path d="M12 10.5v5.5"/><path d="M9.5 13.5l2.5 2.5 2.5-2.5"/></svg>数据备份</h4>'
      + '<p>把统一存储里的会话事件、消息、摘要、角色卡、记忆、知识库、工作区、附件与画廊打包成一个 ZIP。不含 API Key、界面设置与同步游标。导入会替换本机数据，并从事件日志重建消息索引。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="backupNativeKv"><label for="backupNativeKv">一并导出本机热窗口（native_kv；自动跳过密钥、设置与同步游标命名空间）</label></div></div>'
      + '<div class="btns"><button class="smallbtn" id="backupExportBtn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.5V5"/><path d="M8 8.5L12 4.5l4 4"/><path d="M5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3.5"/></svg>导出备份</button>'
      + '<button class="smallbtn danger" id="backupImportBtn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5V15"/><path d="M8 11l4 4 4-4"/><path d="M5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3.5"/></svg>导入备份</button>'
      + '<input type="file" id="backupImportFile" accept=".zip,application/zip" style="display:none"></div>'
      + '<div id="backupStatus" style="font-size:11px;color:var(--muted);margin-top:8px;">正在读取本机数据量…</div>'
      + '<div id="backupProgress" style="font-size:11px;color:var(--muted);margin-top:4px;"></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>导入前请先导出一份当前备份。单表超过 50 万行或 200 MB 会直接拒绝（不做静默截断）；导入失败会回滚到导入前的数据。</span></div>';
    slot.appendChild(card);

    var exportBtn = g.document.getElementById("backupExportBtn");
    var importBtn = g.document.getElementById("backupImportBtn");
    var importFile = g.document.getElementById("backupImportFile");

    if (exportBtn) exportBtn.addEventListener("click", doExport);
    if (importBtn && importFile) {
      importBtn.addEventListener("click", function () {
        if (!busy) importFile.click();
      });
      importFile.addEventListener("change", function () {
        var file = importFile.files && importFile.files[0];
        importFile.value = "";
        if (!file) return;
        var reader = new g.FileReader();
        reader.onload = function () {
          var buffer = reader.result;
          if (!buffer) {
            setText("backupStatus", "读取备份文件失败：内容为空");
            return;
          }
          doImport(new Uint8Array(buffer), file.name || "backup.zip");
        };
        reader.onerror = function () {
          setText("backupStatus", "读取备份文件失败：" + errText(reader.error));
        };
        reader.readAsArrayBuffer(file);
      });
    }
    refreshSummary();
  }

  g.backupCard = { mount: mountCard };
})(typeof window !== "undefined" ? window : globalThis);

globalThis.BACKUP_FORMAT = BACKUP_FORMAT;
globalThis.BACKUP_VERSION = BACKUP_VERSION;
globalThis.backupFilename = backupFilename;
globalThis.createBackupService = createBackupService;
})();
