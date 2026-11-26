(function () {
/**
 * Agent file workspace: a per-conversation file store handed to the model as six tools
 * (list / read / search / write / edit / delete) plus an export that reaches the real disk.
 *
 * The store arrives through {@link WorkspacePorts}: the browser wiring backs it with the unified
 * SQLite `workspace` / `workspace_versions` / `workspace_blobs` tables, keeps the legacy IndexedDB
 * database only as the one-time import source and as a fallback for hosts without those tables,
 * and the tests use a map. So do line slicing, text search, the clock and the disk export, because
 * each of them already has an owner elsewhere. This file touches no `window`, `document` or
 * `indexedDB`; the adapter lives in l0/wiring/agent-workspace.js.
 *
 * Files are keyed by `convId::path` (the SQL row keeps that composite key in `path`, because the
 * table's primary key is `path` alone), so a task's intermediate products die with its
 * conversation. That is the non-obvious choice here: the workspace is a scratchpad per
 * conversation, not a shared drive, and every path is flat — `..` is rejected rather than resolved.
 *
 * Tools are registered one `try` at a time. A duplicate name makes `define` throw, and a shared
 * `try` would take every later file tool down with it.
 * @module services/data/agent-workspace
 */

/** Key-value storage is not used here, but the change hook and clock are shared with the domain. */
                                             

/** One stored file, exactly as the store hands it back. Legacy rows may miss fields. */
                                
               
                
                 
             
                  
 

/** One immutable version, as `history` returns it (no content). */
                                   
                  
             
                
                
               
 

/** The stored version row. `hash` is null for a delete; `fromVersion` marks a restore. */
                      
             
                   
                 
               
              
             
               
                      
                
                
                          
                       
 

/** File-store port: one flat namespace of rows keyed by `id`. */
                            
                           
                                          
                                  
                                    
                                                                                     
                                                                
                         
 

/** Line slicing and text search, owned by the text-search module. */
                                 
           
                           
                            
                           
                           
                              
    
                                                                              
                                                              
                                        
                                                              
 

                              
                
               
             
               
                
                        
                          
 

                             
                  
                 
                       
                   
                      
 

                               
                     
                
                     
                      
                    
 

                              
               
                     
                     
                     
                      
 

                            
                        
                     
 

/** Disk export, already resolved to a platform by the wiring layer (Tauri dialog or download). */
                           
                                                                               
                                 

/** A tool descriptor as the model sees it. `parameters` is JSON Schema, kept opaque here. */
                          
               
                      
                                      
                        
                                  
 

                                   
                             
 

                                 
                   
                                                                                     
                       
                                                                                           
                    
                                                                                                  
                                             
                                                                 
                   
                                              
                
                                                                                                
                                
                                                                  
                                                                        
                                                                                       
                                                  
 

const NO_CONV = "__none__";
/** Keep at most this many versions of one file (baseline/delete included). */
const MAX_VERSIONS_PER_FILE = 50;
/** Keep at most this many versions across one conversation. */
const MAX_VERSIONS_PER_CONV = 200;
/** Keep at most this much version text per conversation; the main file write always wins. */
const MAX_HISTORY_BYTES_PER_CONV = 16 * 1024 * 1024;

/**
 * Object guard for values that came back from the model or from storage. Fields are copied one by
 * one: that is how this codebase reads unknown JSON without a cast.
 */
function recOf(value         )                          {
  const out                          = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Array guard for the same reason as {@link recOf}. */
function arrOf(value         )            {
  if (!Array.isArray(value)) return [];
  const out            = [];
  for (let i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

function strOf(v         )         {
  return v == null ? "" : String(v);
}

function numOf(v         )         {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize a workspace path: forward slashes, no leading `./` or `/`, no `..` segment.
 * An empty result means "rejected" — the workspace is flat, so a traversal has no meaning here.
 */
function normPath(p         )         {
  const s = strOf(p)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "");
  if (!s) return "";
  const parts = s.split("/").filter((x) => x && x !== ".");
  if (parts.some((x) => x === "..")) return "";
  return parts.join("/");
}

/** Storage key of a path inside one conversation. */
function fileKey(convId        , path        )         {
  return convId + "::" + path;
}

function toFile(row         )                {
  const r = recOf(row);
  const bytes = numOf(r["bytes"]);
  const lines = numOf(r["lines"]);
  return {
    path: strOf(r["path"]),
    bytes,
    lines: lines || undefined,
    ts: numOf(r["ts"]),
    content: strOf(r["content"]),
  };
}

function toVersion(row         )             {
  const r = recOf(row);
  return {
    id: strOf(r["id"]),
    scopeKey: strOf(r["scopeKey"]),
    convId: strOf(r["convId"]),
    path: strOf(r["path"]),
    seq: numOf(r["seq"]),
    ts: numOf(r["ts"]),
    kind: strOf(r["kind"]),
    hash: r["hash"] == null ? null : strOf(r["hash"]),
    bytes: numOf(r["bytes"]),
    lines: numOf(r["lines"]),
    prevHash: r["prevHash"] == null ? null : strOf(r["prevHash"]),
    fromVersion: r["fromVersion"] == null ? undefined : numOf(r["fromVersion"]),
  };
}

/**
 * Build the workspace over its ports. Every method returns a result object instead of throwing:
 * the callers are model tools, and a thrown error would surface as a broken tool call.
 */
function createWorkspace(ports                ) {
  const convId = ()         => ports.convId() || NO_CONV;

  function list()                           {
    const c = convId();
    const empty           = [];
    return ports.store
      .all()
      .catch(() => empty)
      .then((rows) => {
      const out                  = [];
      for (const row of rows) {
        const r = recOf(row);
        if (!r || strOf(r["convId"]) !== c) continue;
        const f = toFile(r);
        out.push({ path: f.path, bytes: f.bytes, lines: f.lines, ts: f.ts, content: "" });
      }
      out.sort((a, b) => (a.path < b.path ? -1 : 1));
      return out;
    });
  }

  function read(path         )                                {
    const p = normPath(path);
    if (!p) return Promise.resolve(null);
    return ports.store
      .get(fileKey(convId(), p))
      .then((row) => (row ? toFile(row) : null))
      .catch(() => null);
  }

  // ── History: append-only versions + content-addressed blobs ──
  // Best effort by design: a missing/broken history port turns history off for the rest of the
  // page and never blocks the file itself. `write` / `remove` keep their old result shapes.
  let historyOff = false;

  function historyReady()          {
    return !historyOff && !!ports.versions && !!ports.blobs && !!ports.digest;
  }

  function versionsOf(scopeKey        )                        {
    const v = ports.versions;
    if (!v) return Promise.resolve([]);
    return v.all()
      .then((rows) => rows.map(toVersion).filter((r) => r.scopeKey === scopeKey).sort((a, b) => a.seq - b.seq))
      .catch(() => []);
  }

  function versionsForConv(c        )                        {
    const v = ports.versions;
    if (!v) return Promise.resolve([]);
    return v.all()
      .then((rows) => rows.map(toVersion).filter((r) => r.convId === c))
      .catch(() => []);
  }

  function digestOf(text        )                         {
    const d = ports.digest;
    if (!d) { historyOff = true; return Promise.resolve(null); }
    return d(text)
      .then((hash) => strOf(hash) || null)
      .catch(() => { historyOff = true; return null; });
  }

  function putBlob(c        , hash        , text        )                   {
    const b = ports.blobs;
    if (!b) return Promise.resolve(false);
    const id = c + "::" + hash;
    return b.get(id)
      .then((row) => {
        if (row) return true;
        return b.put({ id, convId: c, hash, content: text, bytes: text.length }).then(() => true);
      })
      .catch(() => { historyOff = true; return false; });
  }

  async function appendVersion(
    c        , p        , scopeKey        , kind        , text        , fromVersion         ,
  )                         {
    if (!historyReady()) return null;
    const hash = await digestOf(text);
    if (!hash) return null;
    if (!(await putBlob(c, hash, text))) return null;
    const rows = await versionsOf(scopeKey);
    const seq = rows.length ? rows[rows.length - 1].seq + 1 : 1;
    const last = rows.length ? rows[rows.length - 1] : null;
    const row         = {
      id: scopeKey + "#" + seq,
      scopeKey,
      convId: c,
      path: p,
      seq,
      ts: ports.now(),
      kind,
      hash,
      bytes: text.length,
      lines: text.split("\n").length,
      prevHash: last ? last.hash : null,
    };
    if (fromVersion != null) row["fromVersion"] = fromVersion;
    const v = ports.versions;
    if (!v) return null;
    try {
      await v.put(row);
      return seq;
    } catch (_e) {
      historyOff = true;
      return null;
    }
  }

  /** A pre-history file's old content becomes seq 0 before the first mutation. */
  async function ensureBaseline(c        , p        , scopeKey        , oldContent        )                {
    if (!historyReady()) return;
    const rows = await versionsOf(scopeKey);
    if (rows.length) return;
    const hash = await digestOf(oldContent);
    if (!hash) return;
    if (!(await putBlob(c, hash, oldContent))) return;
    const v = ports.versions;
    if (!v) return;
    try {
      await v.put({
        id: scopeKey + "#0",
        scopeKey,
        convId: c,
        path: p,
        seq: 0,
        ts: ports.now(),
        kind: "baseline",
        hash,
        bytes: oldContent.length,
        lines: oldContent.split("\n").length,
        prevHash: null,
      });
    } catch (_e) {
      historyOff = true;
    }
  }

  async function appendDelete(c        , p        , scopeKey        )                         {
    if (!historyReady()) return null;
    const rows = await versionsOf(scopeKey);
    const seq = rows.length ? rows[rows.length - 1].seq + 1 : 1;
    const last = rows.length ? rows[rows.length - 1] : null;
    const v = ports.versions;
    if (!v) return null;
    try {
      await v.put({
        id: scopeKey + "#" + seq,
        scopeKey,
        convId: c,
        path: p,
        seq,
        ts: ports.now(),
        kind: "delete",
        hash: null,
        bytes: 0,
        lines: 0,
        prevHash: last ? last.hash : null,
      });
      return seq;
    } catch (_e) {
      historyOff = true;
      return null;
    }
  }

  /** Trim old versions and GC blobs no remaining version references. */
  async function prune(c        )                {
    const v = ports.versions;
    const b = ports.blobs;
    if (!v || !b) return;
    const rows = await versionsForConv(c);
    if (!rows.length) return;

    const latest = new Map                    ();
    for (const r of rows) {
      const cur = latest.get(r.scopeKey);
      if (!cur || r.seq > cur.seq) latest.set(r.scopeKey, r);
    }

    const drop = new Set        ();
    const byScope = new Map                      ();
    for (const r of rows) {
      const list = byScope.get(r.scopeKey) || [];
      list.push(r);
      byScope.set(r.scopeKey, list);
    }
    for (const list of byScope.values()) {
      list.sort((a, b) => b.seq - a.seq);
      for (let i = MAX_VERSIONS_PER_FILE; i < list.length; i++) drop.add(list[i].id);
    }

    const kept = rows.filter((r) => !drop.has(r.id));
    const ordered = kept.slice().sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    let count = ordered.length;
    let bytes = ordered.reduce((n, r) => n + r.bytes, 0);
    for (const r of ordered) {
      if (count <= MAX_VERSIONS_PER_CONV && bytes <= MAX_HISTORY_BYTES_PER_CONV) break;
      if (latest.get(r.scopeKey) === r) continue; // never drop the latest version of a file
      drop.add(r.id);
      count--;
      bytes -= r.bytes;
    }

    for (const id of drop) {
      try { await v.remove(id); } catch (_e) { /* best effort */ }
    }

    const remaining = rows.filter((r) => !drop.has(r.id));
    const used = new Set        ();
    for (const r of remaining) if (r.hash) used.add(r.hash);
    let blobs           = [];
    try { blobs = await b.all(); } catch (_e) { blobs = []; }
    for (const raw of blobs) {
      const row = recOf(raw);
      if (strOf(row["convId"]) !== c) continue;
      const hash = strOf(row["hash"]);
      if (hash && !used.has(hash)) {
        try { await b.remove(strOf(row["id"])); } catch (_e) { /* best effort */ }
      }
    }
  }

                    
                                                                       
                                   

  function writeInternal(path         , content         , kind        , fromVersion         )                       {
    const p = normPath(path);
    if (!p) return Promise.resolve({ ok: false, error: "路径不合法(不能为空、不能含 ..)" });
    const text = strOf(content);
    const c = convId();
    const scopeKey = fileKey(c, p);
    const row         = {
      id: scopeKey,
      convId: c,
      path: p,
      content: text,
      bytes: text.length,
      lines: text.split("\n").length,
      ts: ports.now(),
    };
    const withHistory = historyReady();
    const oldP = withHistory ? ports.store.get(scopeKey).catch(() => null) : Promise.resolve(null);
    return oldP.then(async (oldRow) => {
      const old = oldRow ? toFile(oldRow) : null;
      if (withHistory && old) await ensureBaseline(c, p, scopeKey, old.content);
      try {
        await ports.store.put(row);
      } catch (_e) {
        return { ok: false, error: "工作区不可用(存储未就绪)" };
      }
      let version                = null;
      if (withHistory) {
        version = await appendVersion(c, p, scopeKey, kind, text, fromVersion);
        await prune(c);
      }
      return { ok: true, path: p, bytes: text.length, version };
    });
  }

  function write(path         , content         )          
                                                                            
    {
    return writeInternal(path, content, "write").then((r) => (
      r.ok ? { ok: true, path: r.path, bytes: r.bytes } : r
    ));
  }

  function remove(path         )                                                                     {
    const p = normPath(path);
    if (!p) return Promise.resolve({ ok: false, error: "路径不合法" });
    const c = convId();
    const scopeKey = fileKey(c, p);
    const withHistory = historyReady();
    const oldP = withHistory ? ports.store.get(scopeKey).catch(() => null) : Promise.resolve(null);
    return oldP.then(async (oldRow) => {
      const old = oldRow ? toFile(oldRow) : null;
      if (withHistory && old) await ensureBaseline(c, p, scopeKey, old.content);
      try {
        await ports.store.remove(scopeKey);
      } catch (_e) {
        return { ok: false, error: "工作区不可用" };
      }
      if (withHistory && old) {
        await appendDelete(c, p, scopeKey);
        await prune(c);
      }
      return { ok: true, path: p };
    });
  }

  /**
   * Drop every file of one conversation. Called when a conversation is deleted or its history is
   * cleared; without it the workspace keeps orphans whose convId no longer exists.
   */
  function removeByConv(cid          )                                            {
    const target = strOf(cid) || convId();
    return ports.store
      .removeWhere((row) => strOf(recOf(row)["convId"]) === target)
      .then((removed) => {
        const jobs                          = [];
        const v = ports.versions;
        const b = ports.blobs;
        if (v) jobs.push(v.removeWhere((row) => strOf(recOf(row)["convId"]) === target).catch(() => 0));
        if (b) jobs.push(b.removeWhere((row) => strOf(recOf(row)["convId"]) === target).catch(() => 0));
        return Promise.all(jobs).then(() => ({ ok: true, removed }));
      })
      .catch(() => ({ ok: false, removed: 0 }));
  }

  /** Wipe the whole workspace, used by "clear all conversations". */
  function clearAll()                           {
    const jobs                          = [ports.store.clear()];
    if (ports.versions) jobs.push(ports.versions.clear());
    if (ports.blobs) jobs.push(ports.blobs.clear());
    return Promise.all(jobs)
      .then(() => ({ ok: true }))
      .catch(() => ({ ok: false }));
  }

  /** Version metadata for one file, newest first; no content. */
  function history(path         , limit          )                   {
    const p = normPath(path);
    if (!p) return Promise.resolve({ ok: false, error: "路径不合法" });
    if (!historyReady()) return Promise.resolve({ ok: false, error: "历史未启用（wiring 未提供 versions/blobs/digest）" });
    const max = Math.max(1, Math.min(50, numOf(limit) || 20));
    return versionsOf(fileKey(convId(), p)).then((rows) => {
      const all = rows.slice().sort((a, b) => b.seq - a.seq);
      return {
        ok: true,
        path: p,
        total: all.length,
        versions: all.slice(0, max).map((r) => ({
          version: r.seq,
          ts: r.ts,
          bytes: r.bytes,
          lines: r.lines,
          kind: r.kind,
        })),
      };
    });
  }

  /** One version's full text; the UI restores by seq, never by content. */
  function readVersion(path         , version         )                   {
    const p = normPath(path);
    if (!p) return Promise.resolve({ ok: false, error: "路径不合法" });
    if (!historyReady()) return Promise.resolve({ ok: false, error: "历史未启用" });
    const b = ports.blobs;
    if (!b) return Promise.resolve({ ok: false, error: "历史未启用" });
    const c = convId();
    return versionsOf(fileKey(c, p)).then((rows) => {
      const v = rows.find((r) => r.seq === numOf(version));
      if (!v) return { ok: false, error: "版本不存在" };
      if (!v.hash) return { ok: false, error: "该版本是删除记录，没有正文" };
      return b.get(c + "::" + v.hash).then((blob) => {
        if (!blob) return { ok: false, error: "版本正文已清理" };
        return {
          ok: true,
          path: p,
          version: v.seq,
          ts: v.ts,
          bytes: v.bytes,
          lines: v.lines,
          kind: v.kind,
          content: strOf(recOf(blob)["content"]),
        };
      }).catch(() => ({ ok: false, error: "版本正文读取失败" }));
    });
  }

  /**
   * Restore an old version by writing a NEW version with its content. History is append-only:
   * the restored-from row is never rewritten, so a restore can itself be undone.
   */
  async function restore(path         , version         )                   {
    const p = normPath(path);
    if (!p) return { ok: false, error: "路径不合法" };
    if (!historyReady()) return { ok: false, error: "历史未启用" };
    const c = convId();
    const rows = await versionsOf(fileKey(c, p));
    const v = rows.find((r) => r.seq === numOf(version));
    if (!v) return { ok: false, error: "版本不存在" };
    if (!v.hash) return { ok: false, error: "该版本是删除记录，没有正文" };
    const b = ports.blobs;
    if (!b) return { ok: false, error: "历史未启用" };
    const blob = await b.get(c + "::" + v.hash).catch(() => null);
    if (!blob) return { ok: false, error: "版本正文已清理" };
    const text = strOf(recOf(blob)["content"]);
    const w = await writeInternal(p, text, "restore", v.seq);
    if (w.ok === false) return w;
    return { ok: true, path: p, version: w.version, restoredFrom: v.seq, bytes: text.length };
  }

  function listFiles()                   {
    return list().then((arr) => {
      if (!arr.length) return { ok: true, files: [], note: "工作区还是空的。用 write_file 写入第一个文件。" };
      return { ok: true, count: arr.length, files: arr };
    });
  }

  function readFile(args         )                   {
    const a = recOf(args);
    return read(a["path"]).then((r) => {
      if (!r) return { ok: false, error: "文件不存在: " + normPath(a["path"]) };
      const TS = ports.text();
      if (!TS) return { ok: false, error: "text-search 模块未加载（分页读不可用）" };
      const sl = TS.sliceLines(r.content, a["offset"], a["limit"]);
      const out                          = {
        ok: true,
        path: r.path,
        bytes: r.bytes,
        totalLines: sl.total,
        from: sl.from,
        to: sl.to,
        text: sl.text,
      };
      if (sl.more) {
        out["truncated"] = true;
        out["nextOffset"] = sl.to + 1;
        out["hint"] =
          "共 " +
          sl.total +
          " 行，本次返回第 " +
          sl.from +
          "–" +
          sl.to +
          " 行；继续读用 read_file(offset=" +
          (sl.to + 1) +
          ")，或先 search_file 定位再读窗口。";
      } else if (sl.from > 1) {
        out["hint"] = "已到文件末尾（共 " + sl.total + " 行）。";
      }
      if (sl.clippedLines) out["clippedLines"] = sl.clippedLines;
      if (sl.droppedByBytes) {
        out["hint"] =
          (out["hint"] ? out["hint"] + " " : "") +
          "（单窗字节上限 " +
          TS.LIMITS.READ_MAX_BYTES +
          "，本次少返回 " +
          sl.droppedByBytes +
          " 行）";
      }
      return out;
    });
  }

  function searchFile(args         )                   {
    const a = recOf(args);
    const pattern = strOf(a["pattern"]);
    if (!pattern) return Promise.resolve({ ok: false, error: "缺少 pattern" });
    const TS = ports.text();
    if (!TS) return Promise.resolve({ ok: false, error: "text-search 模块未加载（检索不可用）" });
    return list().then((found) => {
      let picked = found;
      const rawPath = a["path"];
      if (rawPath) {
        const p = normPath(rawPath);
        const re = TS.globToRe(p);
        const exact = picked.filter((f) => f.path === p);
        if (exact.length) picked = exact;
        else if (re) picked = picked.filter((f) => re.test(f.path));
        else picked = picked.filter((f) => f.path.indexOf(p) >= 0);
      }
      if (!picked.length) {
        return { ok: true, files: [], totalMatches: 0, note: "没有匹配的文件（先 list_files 看工作区里有什么）" };
      }
      const max = Math.max(
        1,
        Math.min(TS.LIMITS.SEARCH_HARD_MAX, parseInt(strOf(a["max_results"]), 10) || TS.LIMITS.SEARCH_DEF_MAX)
      );
      const ctx = a["context"] == null ? TS.LIMITS.SEARCH_CTX_DEF : a["context"];
      let remaining = max;
      const blocks                = [];
      let total = 0;
      let degraded                = null;
      let scanned = 0;
      let perFileTruncated = false;

      const step = (i        )                => {
        if (i >= picked.length || remaining <= 0) return Promise.resolve();
        const f = picked[i];
        return read(f.path)
          .then((r) => {
            if (!r) return;
            scanned++;
            const res = TS.searchText(r.content, {
              pattern,
              regex: !!a["regex"],
              ignore_case: !!a["ignore_case"],
              context: ctx,
              max_results: remaining,
            });
            if (res.degraded && !degraded) degraded = f.path + "：" + res.degraded;
            total += res.total;
            if (res.matches.length) {
              const blk              = {
                path: f.path,
                totalLines: res.totalLines,
                matchCount: res.total,
                matches: res.matches,
              };
              if (res.truncated) {
                blk.truncated = true;
                perFileTruncated = true;
              }
              blocks.push(blk);
              remaining -= res.matches.length;
            }
          })
          .then(() => step(i + 1));
      };

      return step(0).then(() => {
        // Output budget matches the kernel's per-tool-result cap: past it the kernel would keep the
        // head and tail and cut the middle out, so trim by item here and say so.
        const fit = TS.fitBlocks(blocks, TS.LIMITS.SEARCH_OUT_BUDGET);
        const out                          = {
          ok: true,
          totalMatches: total,
          filesScanned: scanned,
          files: fit.blocks,
        };
        if (fit.truncated) {
          out["truncated"] = true;
          out["hint"] =
            "命中过多，输出已按预算（" + TS.LIMITS.SEARCH_OUT_BUDGET + " 字符）截断；请收窄 pattern 或加 path 限定文件。";
        } else if (perFileTruncated) {
          out["truncated"] = true;
          out["hint"] =
            "部分文件命中数超过返回上限（见各文件 matchCount）；收窄 pattern 或调大 max_results（上限 " +
            TS.LIMITS.SEARCH_HARD_MAX +
            "）。";
        } else if (remaining <= 0) {
          out["hint"] =
            "已达 max_results 上限（" + max + "）；收窄 pattern 或调大 max_results（上限 " + TS.LIMITS.SEARCH_HARD_MAX + "）。";
        }
        if (!total) {
          out["note"] =
            "没有命中（模式：" +
            (a["regex"] ? "正则" : "字面") +
            "）。换关键词、去掉大小写限制，或确认真的是这个文件。";
        } else {
          out["readHint"] = "读窗口：read_file(path, offset=命中行-" + (numOf(ctx) + 1) + ", limit=" + (numOf(ctx) * 2 + 10) + ")。";
        }
        if (degraded) out["degraded"] = degraded;
        return out;
      });
    });
  }

  function writeFile(args         )                   {
    const a = recOf(args);
    return write(a["path"], a["content"]).then((r) => {
      if (!r.ok) return r;
      return {
        ok: true,
        path: r.path,
        bytes: r.bytes,
        note: "已写入工作区,可用 read_file 读回或 export_file 导出到磁盘",
      };
    });
  }

  function editFile(args         )                   {
    const a = recOf(args);
    return read(a["path"]).then((r)          => {
      if (!r) return { ok: false, error: "文件不存在: " + normPath(a["path"]) };
      const oldS = strOf(a["old_string"]);
      if (!oldS) return { ok: false, error: "old_string 不能为空" };
      const cnt = r.content.split(oldS).length - 1;
      if (cnt === 0) return { ok: false, error: "没找到 old_string(注意空格/换行要完全一致)" };
      if (cnt > 1 && a["replace_all"] !== true) {
        return {
          ok: false,
          error:
            "old_string 在文件里出现了 " +
            cnt +
            " 次,不唯一。请把上下文补足让它唯一,或传 replace_all:true；也可以先用 search_file 看各处命中行号再补足上下文。",
        };
      }
      const next =
        a["replace_all"] === true
          ? r.content.split(oldS).join(strOf(a["new_string"]))
          : r.content.replace(oldS, strOf(a["new_string"]));
      return writeInternal(a["path"], next, "edit").then((w)          => {
        if (w.ok === false) return w;
        return { ok: true, path: w.path, replaced: cnt, bytes: w.bytes };
      });
    });
  }

  function deleteFile(args         )                   {
    const a = recOf(args);
    return remove(a["path"]).then((r) => (r.ok ? { ok: true, path: r.path, note: "已删除" } : r));
  }

  /**
   * Export a workspace file to the real disk. The browser-side split (Tauri dialog on desktop,
   * download on the web) belongs to the wiring layer, which reports a cancelled save as a failure
   * rather than a success.
   */
  function exportFile(args         )                   {
    const a = recOf(args);
    return read(a["path"]).then((r)                                         => {
      if (!r) return { ok: false, error: "文件不存在: " + normPath(a["path"]) };
      const fallback = r.path.split("/").pop() || "file.txt";
      const name = strOf(a["filename"]) || fallback;
      return ports.exportFile(name, r.content);
    });
  }

  const DEFS            = [
    {
      name: "list_files",
      description: "列出当前会话工作区里的文件(路径 / 大小 / 最后修改时间)。工作区存于统一存储,按会话隔离。",
      parameters: { type: "object", properties: {} },
      run: () => listFiles(),
    },
    {
      name: "read_file",
      description:
        "读取工作区文件（**按行分页**）。默认返回前 400 行；文件更长时结果里带 totalLines 与 nextOffset，" +
        "继续读就把 offset 传成 nextOffset。要找内容先用 search_file（先搜后读，比整读省得多，也不会被截断挖掉中段）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内的文件路径,如 report.md / src/app.js" },
          offset: { type: "integer", description: "起始行号（1 起，默认 1）" },
          limit: { type: "integer", description: "最多返回多少行（默认 400，上限 2000）" },
        },
        required: ["path"],
      },
      run: (args) => readFile(args),
    },
    {
      name: "search_file",
      description:
        "在工作区文件里检索（grep 语义）：返回命中**行号 + 上下文**。" +
        "默认**字面**匹配（快、零误报）；regex:true 才按正则解释 pattern（带长度上限与嵌套量词拒绝，防回溯炸弹）。" +
        "用法：大文件先 search 定位 → read_file(path, offset=命中行-15, limit=40) 读窗口；不要整读大文件。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "要找的内容（默认字面文本；regex:true 时为正则）" },
          path: { type: "string", description: "可选：只搜某个文件（精确路径、glob 如 *.md / src/*，或路径片段）" },
          regex: { type: "boolean", description: "true=按正则解释 pattern（默认 false=字面）" },
          ignore_case: { type: "boolean", description: "忽略大小写" },
          context: { type: "integer", description: "每个命中的上下文行数（默认 2，上限 10；0=不要上下文）" },
          max_results: { type: "integer", description: "最多返回多少条命中（默认 30，上限 100）" },
        },
        required: ["pattern"],
      },
      run: (args) => searchFile(args),
    },
    {
      name: "write_file",
      description:
        "把内容写入当前会话工作区(统一存储,真持久化,可被 read_file 立刻读回)。" +
        "适合产出报告/代码/数据,或作为多步任务的中间产物。要导出到真实磁盘用 export_file。",
      destructive: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内的文件路径,如 report.md / src/app.js" },
          content: { type: "string", description: "文件内容(UTF-8 文本)" },
        },
        required: ["path", "content"],
      },
      run: (args) => writeFile(args),
    },
    {
      name: "edit_file",
      description:
        "在工作区文件里做精确替换(把 old_string 换成 new_string)。old_string 必须在文件里唯一出现,否则报错让你补足上下文。是最常用的「改文件」工具。",
      destructive: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内的文件路径" },
          old_string: { type: "string", description: "要被替换的原文(需在文件中唯一)" },
          new_string: { type: "string", description: "替换成的新内容" },
          replace_all: { type: "boolean", description: "true = 替换全部出现(默认 false,要求唯一)" },
        },
        required: ["path", "old_string", "new_string"],
      },
      run: (args) => editFile(args),
    },
    {
      name: "delete_file",
      description: "从工作区删除一个文件。",
      destructive: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "工作区内的文件路径" } },
        required: ["path"],
      },
      run: (args) => deleteFile(args),
    },
    {
      name: "export_file",
      description:
        "把工作区文件导出到**真实磁盘**(桌面端弹保存对话框,网页端触发下载)。要落盘给用户时才用;" +
        "只是产出中间文件请用 write_file(写工作区,不需要用户干预)。",
      destructive: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内要导出的文件路径" },
          filename: { type: "string", description: "另存为的文件名(默认用 path 的文件名)" },
        },
        required: ["path"],
      },
      run: (args) => exportFile(args),
    },
  ];

  /** Register every file tool. One failure is contained: the rest still register. */
  function defineTools(registry                         )       {
    if (!registry || typeof registry.define !== "function") return;
    for (const def of DEFS) {
      try {
        registry.define(def);
      } catch (e) {
        ports.onToolError(def.name, e);
      }
    }
  }

  return {
    list,
    read,
    write,
    remove,
    removeByConv,
    clearAll,
    history,
    readVersion,
    restore,
    defineTools,
    convId,
  };
}

// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// Agent file workspace: the data layer lives in services/data/agent-workspace.ts, so this file owns
// only the storage adapters and the browser-side pieces — the unified SQLite trio reached through
// window.dbSvc (`workspace` for current files, `workspace_versions` for history, `workspace_blobs`
// for content-addressed snapshot texts), the one-time import of the legacy IndexedDB database, the
// content hash for dedupe, the lazy bridge to text-search, the two "export to real disk" channels,
// and registering the file tools into the registry.
//
// Why IndexedDB still exists below: it is the fallback for a page whose DbPort or 0003 tables are
// missing (an older desktop binary, a deployment that has not applied the migration, the vm tests)
// and the only way to read the pre-SQL data once. It is never the primary store once the tables
// answer, and the legacy rows it holds are imported on the first run that can reach them.
//
// Export reports failure as failure on purpose: the old version called a cancelled save ok:true, so
// the model announced a file that had landed nowhere.
(function () {
  var IDB_NAME = "cfw_agent_workspace_v1";
  var IDB_STORE = "files";
  var IDB_VERSIONS = "versions";
  var IDB_BLOBS = "blobs";
  var IDB_VERSION = 2;
  // Namespace of the one-time import marker in `storage_marks` (shared table; one row per domain).
  var IMPORT_MARK = "workspace_idb_v1";
  // 0003 tables. `workspace` is 0002's; the other three arrive with 0003, and all four are probed
  // together because a half-applied schema is exactly what must fall back, not fail mid-write.
  var SQL_TABLES = ["workspace", "workspace_versions", "workspace_blobs", "storage_marks"];
  // The /api/data/tx route caps a batch at 200 statements and 4 MB of JSON; stay well below both so
  // a chunk of long file texts cannot turn a migration into a 413. (A single text larger than the
  // cap still goes alone: splitting a row is not possible without a second schema.)
  var WRITE_CHUNK = 100;
  var WRITE_BYTES = 1024 * 1024;
  var _db = null;
  var _idbCreated = false;

  function warn(message, error) {
    try { console.warn("[agent-workspace] " + message, error); } catch (e) {}
  }

  // ───────── legacy IndexedDB adapter (fallback + one-time import source) ─────────
  function idb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve) {
      try {
        var req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function (ev) {
          // oldVersion 0 means this open created the database; an upgrade of an existing database
          // (oldVersion > 0) may hold real rows and must still be read/imported.
          _idbCreated = !ev || !ev.oldVersion;
          var d = req.result;
          if (!d.objectStoreNames.contains(IDB_STORE)) {
            var os = d.createObjectStore(IDB_STORE, { keyPath: "id" });
            try { os.createIndex("conv", "convId", { unique: false }); } catch (e) {}
          }
          if (!d.objectStoreNames.contains(IDB_VERSIONS)) {
            var vs = d.createObjectStore(IDB_VERSIONS, { keyPath: "id" });
            try { vs.createIndex("conv", "convId", { unique: false }); } catch (e) {}
            try { vs.createIndex("scope", "scopeKey", { unique: false }); } catch (e) {}
          }
          if (!d.objectStoreNames.contains(IDB_BLOBS)) {
            var bs = d.createObjectStore(IDB_BLOBS, { keyPath: "id" });
            try { bs.createIndex("conv", "convId", { unique: false }); } catch (e) {}
          }
        };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  function tx(storeName, mode) {
    return idb().then(function (db) { return db ? db.transaction(storeName, mode).objectStore(storeName) : null; });
  }

  function reqP(r) {
    return new Promise(function (res) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(null); }; });
  }

  // An unopened workspace must not read as an empty table (the model would think every file is gone):
  // throw instead, and the service turns it into ok:false.
  function need(os) {
    if (!os) throw new Error("工作区不可用(存储未就绪)");
    return os;
  }

  function makeStore(storeName) {
    return {
      all: function () {
        return tx(storeName, "readonly").then(function (os) { return os ? reqP(os.getAll()) : []; }).then(function (arr) {
          return Array.isArray(arr) ? arr : [];
        });
      },
      get: function (id) {
        return tx(storeName, "readonly").then(function (os) { return os ? reqP(os.get(id)) : null; });
      },
      put: function (row) {
        return tx(storeName, "readwrite").then(function (os) { return reqP(need(os).put(row)); });
      },
      remove: function (id) {
        return tx(storeName, "readwrite").then(function (os) { return reqP(need(os).delete(id)); });
      },
      removeWhere: function (match) {
        return tx(storeName, "readwrite").then(function (os) {
          if (!os) return Promise.reject(new Error("工作区不可用(存储未就绪)"));
          return new Promise(function (res, rej) {
            var n = 0;
            var r = os.openCursor();
            r.onsuccess = function (e) {
              var c = e.target.result;
              if (!c) return res(n);
              if (match(c.value)) { n++; c.delete(); }
              c.continue();
            };
            r.onerror = function () { rej(new Error("工作区游标读取失败")); };
          });
        });
      },
      clear: function () {
        return tx(storeName, "readwrite").then(function (os) { return reqP(need(os).clear()); });
      },
    };
  }

  var idbFiles = makeStore(IDB_STORE);
  var idbVersions = makeStore(IDB_VERSIONS);
  var idbBlobs = makeStore(IDB_BLOBS);

  // ───────── SQLite stores (the primary path; rows keep the FileStore shapes) ─────────
  function wsPort() {
    try {
      var svc = window.dbSvc;
      if (svc && typeof svc.get === "function") return svc.get();
    } catch (e) {
      warn("DbPort 不可用，本次回退 IndexedDB", e);
    }
    return null;
  }

  function wsRows(result) {
    return result && Array.isArray(result.rows) ? result.rows : [];
  }

  function wsText(value) {
    return value == null ? "" : String(value);
  }

  function wsNum(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  function hasTables(p) {
    return p.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?,?,?,?)", SQL_TABLES)
      .then(function (res) {
        var found = {};
        wsRows(res).forEach(function (row) { found[wsText(row && row.name)] = true; });
        for (var i = 0; i < SQL_TABLES.length; i++) if (!found[SQL_TABLES[i]]) return false;
        return true;
      });
  }

  // One writer at a time. The node sidecar and the Tauri shell share one SQLite connection, and two
  // overlapping BEGIN/COMMIT batches abort each other ("cannot start a transaction within a
  // transaction"). Our domain never needs concurrent writes (they would race on the same version
  // seq anyway), so a local queue is the whole fix; reads stay parallel.
  var _writeChain = Promise.resolve();
  function serialWrite(job) {
    var run = _writeChain.then(job);
    _writeChain = run.then(function () {}, function () {});
    return run;
  }

  /** At most WRITE_CHUNK statements and roughly WRITE_BYTES of param text per request. */
  function chunkOf(statements, at) {
    var batch = [];
    var bytes = 0;
    for (var i = at; i < statements.length && batch.length < WRITE_CHUNK; i++) {
      var params = statements[i].params || [];
      var size = 0;
      for (var j = 0; j < params.length; j++) {
        var value = params[j];
        size += typeof value === "string" ? value.length + 16 : 16;
      }
      if (batch.length && bytes + size > WRITE_BYTES) break;
      batch.push(statements[i]);
      bytes += size;
    }
    return batch;
  }

  function writeChunks(p, statements) {
    var at = 0;
    function step() {
      if (at >= statements.length) return Promise.resolve();
      var batch = chunkOf(statements, at);
      at += batch.length;
      return serialWrite(function () {
        return p.transaction(function (t) {
          for (var i = 0; i < batch.length; i++) t.exec(batch[i].sql, batch[i].params);
        });
      }).then(step);
    }
    return step();
  }

  function removeMatching(p, table, keyColumn, selectSql, mapRow, match) {
    return p.exec(selectSql).then(function (res) {
      var rows = wsRows(res).map(mapRow);
      var hits = [];
      for (var i = 0; i < rows.length; i++) if (match(rows[i])) hits.push(rows[i]);
      if (!hits.length) return 0;
      var statements = [];
      for (var j = 0; j < hits.length; j++) {
        statements.push({ sql: "DELETE FROM " + table + " WHERE " + keyColumn + " = ?", params: [hits[j].id] });
      }
      return writeChunks(p, statements).then(function () { return hits.length; });
    });
  }

  // `workspace.path` holds the composite storage key (the table's PK is path alone, so the
  // conversation has to live inside it); `cid` repeats the conversation for scoped reads, and the
  // real path is recovered by stripping the `<cid>::` prefix this code wrote.
  var FILES_SELECT = "SELECT path, cid, content, lines, ts FROM workspace";

  function mapFileRow(row) {
    var r = row || {};
    var key = wsText(r["path"]);
    var cid = wsText(r["cid"]);
    var content = wsText(r["content"]);
    var prefix = cid + "::";
    return {
      id: key,
      convId: cid,
      path: cid && key.indexOf(prefix) === 0 ? key.slice(prefix.length) : key,
      content: content,
      bytes: content.length,
      lines: wsNum(r["lines"]),
      ts: wsNum(r["ts"]),
    };
  }

  function makeSqlFiles(p) {
    return {
      all: function () {
        return p.exec(FILES_SELECT).then(function (res) { return wsRows(res).map(mapFileRow); });
      },
      get: function (id) {
        return p.exec(FILES_SELECT + " WHERE path = ?", [id]).then(function (res) {
          var rows = wsRows(res);
          return rows.length ? mapFileRow(rows[0]) : null;
        });
      },
      put: function (row) {
        var r = row || {};
        var key = wsText(r["id"]) || (wsText(r["convId"]) + "::" + wsText(r["path"]));
        var content = wsText(r["content"]);
        return serialWrite(function () {
          return p.exec(
            "INSERT OR REPLACE INTO workspace (path, cid, content, lines, ts) VALUES (?,?,?,?,?)",
            [key, wsText(r["convId"]), content, wsNum(r["lines"]), wsNum(r["ts"])]
          );
        }).then(function () {});
      },
      remove: function (id) {
        return serialWrite(function () { return p.exec("DELETE FROM workspace WHERE path = ?", [id]); })
          .then(function () {});
      },
      removeWhere: function (match) {
        return removeMatching(p, "workspace", "path", FILES_SELECT, mapFileRow, match);
      },
      clear: function () {
        return serialWrite(function () { return p.exec("DELETE FROM workspace"); }).then(function () {});
      },
    };
  }

  var VERSIONS_SELECT = "SELECT id, scope_key, conv_id, path, seq, ts, kind, hash, bytes, lines, prev_hash, from_version FROM workspace_versions";

  function mapVersionRow(row) {
    var r = row || {};
    return {
      id: wsText(r["id"]),
      scopeKey: wsText(r["scope_key"]),
      convId: wsText(r["conv_id"]),
      path: wsText(r["path"]),
      seq: wsNum(r["seq"]),
      ts: wsNum(r["ts"]),
      kind: wsText(r["kind"]),
      hash: r["hash"] == null ? null : wsText(r["hash"]),
      bytes: wsNum(r["bytes"]),
      lines: wsNum(r["lines"]),
      prevHash: r["prev_hash"] == null ? null : wsText(r["prev_hash"]),
      fromVersion: r["from_version"] == null ? undefined : wsNum(r["from_version"]),
    };
  }

  function makeSqlVersions(p) {
    return {
      all: function () {
        return p.exec(VERSIONS_SELECT).then(function (res) { return wsRows(res).map(mapVersionRow); });
      },
      get: function (id) {
        return p.exec(VERSIONS_SELECT + " WHERE id = ?", [id]).then(function (res) {
          var rows = wsRows(res);
          return rows.length ? mapVersionRow(rows[0]) : null;
        });
      },
      put: function (row) {
        var r = row || {};
        return serialWrite(function () { return p.exec(
          "INSERT OR REPLACE INTO workspace_versions (id, scope_key, conv_id, path, seq, ts, kind, hash, bytes, lines, prev_hash, from_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            wsText(r["id"]),
            wsText(r["scopeKey"]),
            wsText(r["convId"]),
            wsText(r["path"]),
            wsNum(r["seq"]),
            wsNum(r["ts"]),
            wsText(r["kind"]),
            r["hash"] == null ? null : wsText(r["hash"]),
            wsNum(r["bytes"]),
            wsNum(r["lines"]),
            r["prevHash"] == null ? null : wsText(r["prevHash"]),
            r["fromVersion"] == null ? null : wsNum(r["fromVersion"]),
          ]
        ); }).then(function () {});
      },
      remove: function (id) {
        return serialWrite(function () { return p.exec("DELETE FROM workspace_versions WHERE id = ?", [id]); })
          .then(function () {});
      },
      removeWhere: function (match) {
        return removeMatching(p, "workspace_versions", "id", VERSIONS_SELECT, mapVersionRow, match);
      },
      clear: function () {
        return serialWrite(function () { return p.exec("DELETE FROM workspace_versions"); }).then(function () {});
      },
    };
  }

  var BLOBS_SELECT = "SELECT id, conv_id, hash, content, bytes FROM workspace_blobs";

  function mapBlobRow(row) {
    var r = row || {};
    return {
      id: wsText(r["id"]),
      convId: wsText(r["conv_id"]),
      hash: wsText(r["hash"]),
      content: wsText(r["content"]),
      bytes: wsNum(r["bytes"]),
    };
  }

  function makeSqlBlobs(p) {
    return {
      all: function () {
        return p.exec(BLOBS_SELECT).then(function (res) { return wsRows(res).map(mapBlobRow); });
      },
      get: function (id) {
        return p.exec(BLOBS_SELECT + " WHERE id = ?", [id]).then(function (res) {
          var rows = wsRows(res);
          return rows.length ? mapBlobRow(rows[0]) : null;
        });
      },
      put: function (row) {
        var r = row || {};
        return serialWrite(function () {
          return p.exec(
            "INSERT OR REPLACE INTO workspace_blobs (id, conv_id, hash, content, bytes) VALUES (?,?,?,?,?)",
            [wsText(r["id"]), wsText(r["convId"]), wsText(r["hash"]), wsText(r["content"]), wsNum(r["bytes"])]
          );
        }).then(function () {});
      },
      remove: function (id) {
        return serialWrite(function () { return p.exec("DELETE FROM workspace_blobs WHERE id = ?", [id]); })
          .then(function () {});
      },
      removeWhere: function (match) {
        return removeMatching(p, "workspace_blobs", "id", BLOBS_SELECT, mapBlobRow, match);
      },
      clear: function () {
        return serialWrite(function () { return p.exec("DELETE FROM workspace_blobs"); }).then(function () {});
      },
    };
  }

  // ───────── One-time import of the legacy IndexedDB database ─────────
  function isMarked(p) {
    return p.exec("SELECT name FROM storage_marks WHERE name = ?", [IMPORT_MARK]).then(function (res) {
      return wsRows(res).length > 0;
    });
  }

  function markDone(p) {
    return serialWrite(function () {
      return p.exec("INSERT OR REPLACE INTO storage_marks (name, ts) VALUES (?,?)", [IMPORT_MARK, Date.now()]);
    }).then(function () {});
  }

  /** Read all three legacy stores; null means "could not read", which must never be marked done. */
  function readLegacy() {
    // No IndexedDB in this host means no legacy data can exist; that is a definitive empty answer,
    // not a read failure (a headless boot must still be able to use the SQL store).
    if (!window.indexedDB || typeof window.indexedDB.open !== "function") {
      return Promise.resolve({ files: [], versions: [], blobs: [] });
    }
    return idb().then(function (db) {
      if (!db) return null;
      if (_idbCreated) return { files: [], versions: [], blobs: [] };
      return Promise.all([
        reqP(db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAll()),
        reqP(db.transaction(IDB_VERSIONS, "readonly").objectStore(IDB_VERSIONS).getAll()),
        reqP(db.transaction(IDB_BLOBS, "readonly").objectStore(IDB_BLOBS).getAll()),
      ]).then(function (all) {
        var files = Array.isArray(all[0]) ? all[0] : [];
        var versions = Array.isArray(all[1]) ? all[1] : [];
        var blobs = Array.isArray(all[2]) ? all[2] : [];
        return { files: files, versions: versions, blobs: blobs };
      });
    }).catch(function (e) {
      warn("旧工作区读取失败", e);
      return null;
    });
  }

  // REPLACE, not IGNORE: until the marker exists the legacy store is the source of truth (a session
  // that fell back to IndexedDB may have newer content), so a retry must converge on it.
  function legacyStatements(legacy) {
    var out = [];
    var i;
    var r;
    for (i = 0; i < legacy.files.length; i++) {
      r = legacy.files[i] || {};
      var fileKey = wsText(r["id"]) || (wsText(r["convId"]) + "::" + wsText(r["path"]));
      if (!fileKey) continue;
      out.push({
        sql: "INSERT OR REPLACE INTO workspace (path, cid, content, lines, ts) VALUES (?,?,?,?,?)",
        params: [fileKey, wsText(r["convId"]), wsText(r["content"]), wsNum(r["lines"]), wsNum(r["ts"])],
      });
    }
    for (i = 0; i < legacy.versions.length; i++) {
      r = legacy.versions[i] || {};
      var versionId = wsText(r["id"]) || (wsText(r["scopeKey"]) + "#" + wsNum(r["seq"]));
      if (!versionId) continue;
      out.push({
        sql: "INSERT OR REPLACE INTO workspace_versions (id, scope_key, conv_id, path, seq, ts, kind, hash, bytes, lines, prev_hash, from_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        params: [
          versionId,
          wsText(r["scopeKey"]),
          wsText(r["convId"]),
          wsText(r["path"]),
          wsNum(r["seq"]),
          wsNum(r["ts"]),
          wsText(r["kind"]),
          r["hash"] == null ? null : wsText(r["hash"]),
          wsNum(r["bytes"]),
          wsNum(r["lines"]),
          r["prevHash"] == null ? null : wsText(r["prevHash"]),
          r["fromVersion"] == null ? null : wsNum(r["fromVersion"]),
        ],
      });
    }
    for (i = 0; i < legacy.blobs.length; i++) {
      r = legacy.blobs[i] || {};
      var blobId = wsText(r["id"]) || (wsText(r["convId"]) + "::" + wsText(r["hash"]));
      if (!blobId) continue;
      out.push({
        sql: "INSERT OR REPLACE INTO workspace_blobs (id, conv_id, hash, content, bytes) VALUES (?,?,?,?,?)",
        params: [blobId, wsText(r["convId"]), wsText(r["hash"]), wsText(r["content"]), wsNum(r["bytes"])],
      });
    }
    return out;
  }

  /** Close our handle, then drop the legacy database. A blocked delete keeps the marker for retry. */
  function deleteLegacyDb() {
    return new Promise(function (resolve) {
      try {
        if (_db) { try { _db.close(); } catch (e) {} _db = null; }
        if (!window.indexedDB || typeof window.indexedDB.deleteDatabase !== "function") return resolve(false);
        var req = window.indexedDB.deleteDatabase(IDB_NAME);
        req.onsuccess = function () { _idbCreated = false; resolve(true); };
        req.onerror = function () {
          warn("旧工作区 IndexedDB 删除失败（旧数据已导入，标记保留；下次启动重试删除）");
          resolve(false);
        };
        req.onblocked = function () {
          warn("旧工作区 IndexedDB 被其他标签页占用，未删除（旧数据已导入；下次启动重试）");
          resolve(false);
        };
      } catch (e) {
        warn("旧工作区 IndexedDB 删除异常", e);
        resolve(false);
      }
    });
  }

  function migrateLegacy(p) {
    return isMarked(p).then(function (done) {
      if (done) return deleteLegacyDb();
      return readLegacy().then(function (legacy) {
        if (!legacy) throw new Error("legacy workspace IndexedDB is unreadable");
        var statements = legacyStatements(legacy);
        return writeChunks(p, statements)
          .then(function () { return markDone(p); })
          .then(deleteLegacyDb);
      });
    });
  }

  // ───────── Backend choice (lazy, once per page) ─────────
  var _backend = null;
  var _backendP = null;

  function fallbackBackend() {
    return { mode: "idb", files: idbFiles, versions: idbVersions, blobs: idbBlobs };
  }

  function resolveBackend() {
    var p = wsPort();
    if (!p) return Promise.resolve(fallbackBackend());
    return hasTables(p).then(function (ok) {
      if (!ok) {
        warn("统一存储缺少 0003 表（workspace_versions / workspace_blobs / storage_marks），本次回退 IndexedDB");
        return fallbackBackend();
      }
      var sql = { mode: "sql", files: makeSqlFiles(p), versions: makeSqlVersions(p), blobs: makeSqlBlobs(p) };
      return migrateLegacy(p).then(function () { return sql; }, function (e) {
        warn("旧 IndexedDB 工作区迁移失败，本次继续用 IndexedDB（旧数据保留，不删库）", e);
        return fallbackBackend();
      });
    }, function (e) {
      // Unreachable is not "schema missing": keep the SQL stores so writes fail loudly instead of
      // silently moving to a second local store that would have to be reconciled later.
      warn("统一存储不可达，工作区操作将报错而不改写 IndexedDB", e);
      return { mode: "sql", files: makeSqlFiles(p), versions: makeSqlVersions(p), blobs: makeSqlBlobs(p) };
    });
  }

  function backend() {
    if (_backend) return Promise.resolve(_backend);
    if (!_backendP) {
      // The `then` wrapper turns a synchronous throw (a hostile port, a missing global) into a
      // rejection: every store method assumes it gets a promise back.
      _backendP = Promise.resolve().then(resolveBackend).then(function (b) { _backend = b; return b; });
    }
    return _backendP;
  }

  /** A FileStore that resolves the chosen backend on each call, so load stays synchronous. */
  function routedStore(pick) {
    return {
      all: function () { return backend().then(function (b) { return pick(b).all(); }); },
      get: function (id) { return backend().then(function (b) { return pick(b).get(id); }); },
      put: function (row) { return backend().then(function (b) { return pick(b).put(row); }); },
      remove: function (id) { return backend().then(function (b) { return pick(b).remove(id); }); },
      removeWhere: function (match) { return backend().then(function (b) { return pick(b).removeWhere(match); }); },
      clear: function () { return backend().then(function (b) { return pick(b).clear(); }); },
    };
  }

  /** SHA-256 of UTF-8 text; history stays off when SubtleCrypto is unavailable. */
  function digest(text) {
    var c = (typeof window !== "undefined" && window.crypto) || null;
    if (!c || !c.subtle || typeof c.subtle.digest !== "function" || typeof TextEncoder === "undefined") {
      return Promise.reject(new Error("crypto.subtle/TextEncoder 不可用"));
    }
    var bytes = new TextEncoder().encode(String(text == null ? "" : text));
    return c.subtle.digest("SHA-256", bytes).then(function (buf) {
      var arr = new Uint8Array(buf), hex = "";
      for (var i = 0; i < arr.length; i++) hex += (arr[i] < 16 ? "0" : "") + arr[i].toString(16);
      return "sha256:" + hex;
    });
  }

  // Resolved per call: nothing guarantees text-search loads before this module (the old code also read
  // it at call time).
  function textPort() {
    return (typeof window !== "undefined" && window.textSearchSvc) || null;
  }

  function activeConvId() {
    try {
      if (window.appSvc && window.appSvc.getActiveConvId) return window.appSvc.getActiveConvId() || "__none__";
    } catch (e) {}
    return "__none__";
  }

  // Real disk: the Tauri save dialog on desktop, an <a download> on the web.
  // Return shape is the service's ExportOutcome — a null path means the user cancelled, not success.
  function exportFile(name, content) {
    var g = (typeof globalThis !== "undefined") ? globalThis : window;
    var invoke = g.tauriSvc ? g.tauriSvc.invokeOrNull() : null;
    var bytes = String(content == null ? "" : content).length;
    if (invoke) {
      return invoke("export_text_file", { suggestedName: name, content: content })
        .then(function (p) {
          // Android may hand back a content:// URI with no path; treat it like a cancel (nothing written).
          if (!p) return { ok: false, error: "已取消保存（未写盘）" };
          return { ok: true, mode: "tauri", path: String(p), bytes: bytes };
        })
        .catch(function (e) { return { ok: false, error: "写盘失败: " + String((e && e.message) || e) }; });
    }
    try {
      var blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var el = document.createElement("a");
      el.href = url;
      el.download = name;
      el.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      return Promise.resolve({ ok: true, mode: "browser-download", filename: name, bytes: bytes });
    } catch (e) {
      return Promise.resolve({ ok: false, error: "下载失败: " + String((e && e.message) || e) });
    }
  }

  var workspace = createWorkspace({
    store: routedStore(function (b) { return b.files; }),
    versions: routedStore(function (b) { return b.versions; }),
    blobs: routedStore(function (b) { return b.blobs; }),
    digest: digest,
    convId: activeConvId,
    now: function () { return Date.now(); },
    text: textPort,
    exportFile: exportFile,
    onToolError: function (name, e) { console.warn("[agent-workspace] 注册工具失败:", name, e); },
  });

  window.__agentWorkspace = {
    defineTools: workspace.defineTools,
    list: workspace.list,
    read: workspace.read,
    write: workspace.write,
    remove: workspace.remove,
    removeByConv: workspace.removeByConv,
    clearAll: workspace.clearAll,
    history: workspace.history,
    readVersion: workspace.readVersion,
    restore: workspace.restore,
    normPath: normPath,
    convId: workspace.convId,
    _idb: { name: IDB_NAME, version: IDB_VERSION, store: IDB_STORE, versions: IDB_VERSIONS, blobs: IDB_BLOBS },
    // Diagnostics only: which backend the lazy probe settled on ("sql" / "idb"), for the status panel.
    _backend: function () { return backend().then(function (b) { return b.mode; }); },
  };
})();

globalThis.recOf = recOf;
globalThis.arrOf = arrOf;
globalThis.normPath = normPath;
globalThis.fileKey = fileKey;
globalThis.createWorkspace = createWorkspace;
})();
