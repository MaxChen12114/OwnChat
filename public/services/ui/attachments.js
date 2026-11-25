(function () {
/**
 * Chat attachment domain rules, minus the browser: the pending-attachment state machine, the
 * message metadata shaping, token estimation, and the request-assembly expansion that turns
 * stored attachment metadata into payload content (fenced file blocks, vision image arrays).
 *
 * Non-obvious choice: document full texts never enter session storage — messages carry only
 * {id,name,chars,truncated}; the full text lives in IndexedDB (via the injected getBlob port)
 * plus an in-page memo that covers the async IDB write window, and expansion re-fetches it on
 * every send. This keeps the 2MB localStorage session slot from being overflowed by a single
 * paste, which used to evict the oldest messages (= real data loss).
 *
 * The wiring (browser adapter appended by l0/emit.mjs) owns IndexedDB access, DOM rendering,
 * the lightbox gestures and the frozen attach facade; everything here is pure and vm-testable.
 * @module services/ui/attachments
 */

/** Single-document character cap for request assembly (the only source of truth). */
const ATT_MAX_CHARS = 100000;

                              
              
                
                 
                      
                
 

                               
              
                
                   
             
             
                     
 

/** Input for addText; chars is intentionally unknown because callers pass raw file metadata. */
                              
                
                  
                      
                 
 

                               
                
                   
                     
             
             
 

                              
                        
                          
                              
 

/**
 * Browser ports injected by the wiring. putBlob must never throw synchronously (its caller
 * wraps the Blob construction in the same try as before); getBlob resolves null instead of
 * rejecting when a device does not hold the blob.
 */
                                 
                                                                         
                                                
                              
 

                                 
             
               
               
                
                     
                
 

                                  
             
                
               
                  
                    
            
            
 

                                                          

                           
                                                                                 
                                                                     
                                                                                       
                                
 

                             
                       
                  
                        
                
                           
                                   
                                                
                          
                                
                                                                       
                                                                   
                               
                               
                                                          
                                                                        
                        
                                                                                     
                                                                                                  
                                                            
 

                                   

const isRec = (v         )           => typeof v === "object" && v !== null;
const isRecArray = (v         )             => Array.isArray(v);
const isFileMeta = (v         )                   => isRec(v);
const isImageMeta = (v         )                    => isRec(v);

function uid()         {
  return "att_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function parseIntSafe(n         )         {
  return parseInt(String(n ?? ""), 10) || 0;
}

/** Human character counts; the units are user-visible copy and stay localized. */
function fmtChars(n         )         {
  const v = parseIntSafe(n);
  if (v >= 10000) return (Math.round(v / 1000) / 10) + " 万字";
  if (v >= 1000) return (Math.round(v / 100) / 10) + " 千字";
  return v + " 字";
}

/** Human byte sizes; thresholds follow the 1024 ladder, rounding mirrors the legacy math. */
function fmtBytes(n         )         {
  const v = parseIntSafe(n);
  if (v >= 1048576) return (Math.round(v / 104857.6) / 10) + "MB";
  if (v >= 1024) return Math.round(v / 102.4) / 10 + "KB";
  return v + "B";
}

function extOf(name         )         {
  const m = String(name || "").match(/\.([A-Za-z0-9]{1,6})$/);
  return m ? String(m[1]).toLowerCase() : "";
}

/** File-type chip palette (colored doc icon + filename pill, not one flat gray). */
const TYPE_COLORS                          = [
  [/^(pdf)$/, "#e0453a"],
  [/^(docx?|rtf|odt|pages)$/, "#2b6cb0"],
  [/^(pptx?|key)$/, "#d9480f"],
  [/^(xlsx?|csv|tsv|ods|numbers)$/, "#2f9e44"],
  [/^(md|markdown|mdx|rst|txt|text|log)$/, "#6b7280"],
  [/^(json|jsonc|json5|ya?ml|toml|ini|conf|env|xml)$/, "#a16207"],
  [/^(html?|css|scss|less|vue|svelte)$/, "#0891b2"],
  [/^(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|sql|graphql|gql|lua|dart|swift|r|pl)$/, "#587a9d"]
];

function typeColor(name         )         {
  const e = extOf(name);
  for (const [re, color] of TYPE_COLORS) {
    if (re.test(e)) return color;
  }
  return "#6b7280";
}

const FENCE = "\x60\x60\x60"; // triple backticks (never spelled bare in this source)

function createAttachmentsCore(host                )             {
  const pending               = [];
  const _textMemo = new Map                ();

  function list()               {
    return pending.slice();
  }
  function count()         {
    return pending.length;
  }
  // Images only: they have a separate quota (vision request body / token cost) and must not
  // be crowded out by text attachments.
  function countImages()         {
    let n = 0;
    for (const p of pending) if (p.kind === "image") n++;
    return n;
  }
  function clear()       {
    pending.length = 0;
    host.onPendingChange();
  }
  function remove(id        )       {
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].id === id) {
        pending.splice(i, 1);
        break;
      }
    }
    host.onPendingChange();
  }
  function addText(item             )       {
    const id = uid();
    const text = String(item.text == null ? "" : item.text);
    _textMemo.set(id, text);
    try {
      host.putBlob(id, new Blob([text], { type: "text/plain;charset=utf-8" }));
    } catch (_) {
      // Blob construction can fail in non-browser realms; the memo below still covers the send.
    }
    pending.push({
      id: id, kind: "text", name: item.name || "未命名",
      chars: parseIntSafe(item.chars),
      truncated: !!item.truncated
    });
    host.onPendingChange();
  }
  function addImage(item              )                  {
    const p                  = {
      id: uid(), kind: "image", name: item.name || "图片",
      dataUrl: item.dataUrl || "", blob: item.blob || null,
      w: item.w || 0, h: item.h || 0
    };
    pending.push(p);
    if (p.blob) host.putBlob(p.id, p.blob);
    host.onPendingChange();
    return p;
  }

  /**
   * Drain the pending list into the shapes a sent message needs. files/images carry metadata
   * only (the full text lives in IDB/memo, fetched back via fileFullText) so the session
   * store is never overflowed by document bodies; _memImages exists for this render only.
   */
  function takePending()           {
    const files                                                                         = [];
    const images                    = [];
    const imagesMeta                                                            = [];
    for (const p of pending) {
      if (p.kind === "text") {
        files.push({ id: p.id, name: p.name, chars: p.chars, truncated: p.truncated });
      } else {
        images.push(p);
        imagesMeta.push({ id: p.id, name: p.name, w: p.w || 0, h: p.h || 0 });
      }
    }
    pending.length = 0;
    host.onPendingChange();
    return {
      files: files.length ? files : undefined,
      images: imagesMeta.length ? imagesMeta : undefined,
      _memImages: images
    };
  }

  /**
   * Put a sent message's attachments back into the pending list (the retry path). New-format
   * files (with id) reuse the original id — the blob is already in IDB, no re-ingest; legacy
   * files (with inline text) are restaged as-is and read from f.text during expansion.
   */
  function restage(msg         )         {
    const m = isRec(msg) ? msg : {};
    let n = 0;
    const files = Array.isArray(m.files) ? m.files.filter(isFileMeta) : [];
    for (const f of files) {
      if (f.id) {
        pending.push({
          id: f.id, kind: "text", name: f.name || "未命名",
          chars: parseIntSafe(f.chars), truncated: !!f.truncated
        });
      } else {
        pending.push({
          id: uid(), kind: "text", name: f.name || "未命名",
          chars: parseIntSafe(f.chars), truncated: !!f.truncated,
          text: String(f.text == null ? "" : f.text)
        });
      }
      n++;
    }
    const images = Array.isArray(m.images) ? m.images.filter(isImageMeta) : [];
    for (const im of images) {
      // Reuse the original id: the image blob is already in IndexedDB and can be fetched
      // back to a dataURL at send time.
      pending.push({ id: im.id || uid(), kind: "image", name: im.name || "图片", dataUrl: "", blob: null, w: im.w || 0, h: im.h || 0 });
      n++;
    }
    if (n) host.onPendingChange();
    return n;
  }

  function blobToDataUrl(blob             )                  {
    return new Promise((res) => {
      if (!blob) {
        res("");
        return;
      }
      try {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result || ""));
        fr.onerror = () => res("");
        fr.readAsDataURL(blob);
      } catch (_) {
        res("");
      }
    });
  }

  function imageDataUrl(meta                                 )                  {
    if (!meta) return Promise.resolve("");
    if (meta.dataUrl) return Promise.resolve(meta.dataUrl);
    if (meta.id) return host.getBlob(meta.id).then(blobToDataUrl);
    return Promise.resolve("");
  }

  /**
   * Fetch a document's full text: in-page memo first (covers the IDB async-write race for
   * texts added this page load), then the legacy inline f.text (historical sessions), then
   * IDB. Empty string when nothing is available — never rejects.
   */
  async function fileFullText(f                                )                  {
    if (!f) return "";
    if (f.id && _textMemo.has(f.id)) return _textMemo.get(f.id) || "";
    if (typeof f.text === "string") return f.text;
    if (f.id) {
      try {
        const b = await host.getBlob(f.id);
        if (b) return await b.text();
      } catch (_) {
        // fall through to empty
      }
    }
    return "";
  }

  function attHasAny(att                                )          {
    return !!(att && ((att.files && att.files.length) || (att.images && att.images.length)));
  }

  /** Metadata persisted into the message (no _memImages — that is per-render memory only). */
  function attMeta(att                                )                          {
    const o                          = {};
    if (att && att.files && att.files.length) o.files = att.files;
    if (att && att.images && att.images.length) o.images = att.images;
    return o;
  }

  function attMaxChars()         {
    return ATT_MAX_CHARS;
  }

  /**
   * Token estimate for attachment texts (images go through the vision chain and are not
   * estimated client-side). New format approximates synchronously as min(chars, cap) — chars
   * counts the original text while a truncated send carries only the cap, so min() is the
   * real occupancy; legacy format (inline f.text) uses the injected estimator, whose
   * implementation lives in chat/context and is deliberately not duplicated here.
   */
  function attFileTokens(att                                , estimate                           )         {
    if (!att || !att.files || !att.files.length) return 0;
    if (typeof estimate !== "function") throw new Error("attFileTokens 需要注入 estimateTokens");
    let n = 0;
    for (const f of att.files) {
      if (typeof f.chars === "number" && f.chars) n += Math.min(f.chars, attMaxChars());
      else n += estimate("【文件:" + f.name + "】" + (f.text || ""));
    }
    return n;
  }

  /**
   * Request-assembly expansion (memory-only; the session is never rewritten, so retry and
   * refresh cannot lose anything):
   *   · files — only the LATEST message carrying files expands full texts; earlier file
   *     messages keep the first 1000 chars. Before the IDB migration every historical file
   *     message resent its full text each turn (cost x turns, blowing the upstream context
   *     in 2-3 turns on large docs).
   *   · images — only the last user message expands, into the vision array.
   */
  async function expandAttachmentMessages(msgs         )                   {
    const arr        = isRecArray(msgs) ? msgs : [];
    let lastUser = -1;
    let lastFilesUser = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (m && m.role === "user") {
        if (lastUser < 0) lastUser = i;
        if (lastFilesUser < 0 && Array.isArray(m.files) && m.files.length) lastFilesUser = i;
      }
    }
    if (lastUser < 0) return arr;
    const attLimit = attMaxChars();
    const EXCERPT = 1000;
    let changed = false;
    const out = arr.slice();
    for (let j = 0; j < out.length; j++) {
      const m = out[j];
      if (!m || m.role !== "user") continue;
      const hasFiles = Array.isArray(m.files) && m.files.length > 0;
      const hasImgs = j === lastUser && Array.isArray(m.images) && m.images.length > 0;
      if (!hasFiles && !hasImgs) continue;
      let text = typeof m.content === "string" ? m.content : "";
      if (hasFiles) {
        const isLatest = j === lastFilesUser;
        const blocks           = [];
        const files                = Array.isArray(m.files) ? m.files.filter(isFileMeta) : [];
        for (const f of files) {
          let body = "";
          try {
            body = await fileFullText(f);
          } catch (_) {
            body = typeof f.text === "string" ? f.text : "";
          }
          const note           = [];
          if (f.truncated) note.push("(内容过长,已截断到前 " + attLimit + " 字)");
          if (!isLatest && body.length > EXCERPT) {
            body = body.slice(0, EXCERPT);
            note.push("(较早上传的长文档,正文已省略 —— 完整全文仅在刚上传后的回合提供;需要可重新上传或分批粘贴)");
          }
          blocks.push("【文件:" + f.name + "】\n" + FENCE + "\n" + body + "\n" + FENCE + (note.length ? "\n" + note.join(" ") : ""));
        }
        text = text ? text + "\n\n" + blocks.join("\n\n") : blocks.join("\n\n");
      }
      let content          = text;
      if (hasImgs) {
        const urls           = [];
        const images                 = Array.isArray(m.images) ? m.images.filter(isImageMeta) : [];
        for (const im of images) {
          let u = "";
          try {
            u = await imageDataUrl(im);
          } catch (_) {
            // missing blob -> skip this image
          }
          if (u) urls.push(u);
        }
        if (urls.length) {
          const parts                                                                                            = [{ type: "text", text: text }];
          for (const x of urls) parts.push({ type: "image_url", image_url: { url: x } });
          content = parts;
        }
      }
      // Deliberately keep only role/content: passing files/images back through the payload
      // would duplicate the full text one more time.
      out[j] = { role: m.role, content: content };
      changed = true;
    }
    return changed ? out : arr;
  }

  return {
    list, count, countImages, clear, remove,
    addText, addImage,
    takePending, restage,
    imageDataUrl, fileFullText,
    fmtChars, fmtBytes,
    attHasAny, attMeta, attMaxChars,
    attFileTokens,
    expandAttachmentMessages
  };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/attachments.ts owns the pending
// state machine, metadata shaping, token estimation and the request-assembly expansion; this file
// owns IndexedDB blob storage, the DOM (text chips, image cards, lightbox with pinch/pan
// gestures), the pending strip above the composer, and the frozen attach facade assembly.
//
// Frozen global name: the attach facade is written by chat-extras (add side) and read by app.js
// and chat-ux (retry/restore side); every method key below is load-bearing for those callers.
// The lightbox also publishes a debug snapshot global (scale/pan/pointer counts) — same key as
// before, consumers expect it.
(function (global) {
  "use strict";
  if (global.__attach) return;

  const esc = global.__ownEscape.esc; // shared escaper, loaded earlier in the boot list

  // ───────── IndexedDB: chat image/document blob store ─────────
  // A dedicated database on purpose: reusing cfw_image_gallery needs a version bump (conflicts
  // with existing v1 openers, old users read null) and cfw_image_album has a "clear gallery"
  // button that would wipe chat blobs. A separate DB is conflict-free.
  var IDB_NAME = "cfw_chat_images";
  var IDB_STORE = "blobs";
  var _db = null;
  function idb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve) {
      try {
        var req = global.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () { try { req.result.createObjectStore(IDB_STORE); } catch (e) {} };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function putBlob(id, blob) {
    return idb().then(function (db) {
      if (!db || !blob) return false;
      return new Promise(function (res) {
        try {
          var tx = db.transaction(IDB_STORE, "readwrite");
          tx.objectStore(IDB_STORE).put(blob, id);
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { res(false); };
          tx.onabort = function () { res(false); };
        } catch (e) { res(false); }
      });
    }).catch(function () { return false; });
  }
  function getBlob(id) {
    return idb().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) {
        try {
          var r = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(id);
          r.onsuccess = function () { res(r.result || null); };
          r.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    }).catch(function () { return null; });
  }
  function delBlob(id) {
    return idb().then(function (db) {
      if (!db) return;
      try { db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(id); } catch (e) {}
    }).catch(function () {});
  }
  if (global.indexedDB && global.indexedDB.databases) {
    // One orphan sweep 4s after boot (blobs left behind by deleted messages): the keep set can
    // not be the current session alone — the sweep runs once at startup, and collecting only
    // the live session's ids would delete every other conversation's blobs (symptom: switching
    // back shows unusable images / empty documents). Walk every slot of the session store,
    // then union the in-memory session and the not-yet-sent attachments (when history is off
    // the live session never lands in storage and the pending list is the safety net).
    setTimeout(function () { gcOrphanBlobs(); }, 4000);
  }
  function gcOrphanBlobs() {
    try {
      var keep = {};
      var keepMsg = function (m) {
        (m && m.images ? m.images : []).forEach(function (im) { if (im && im.id) keep[im.id] = 1; });
        // Document full texts also live in IDB (message files carry an id) — leaving them out
        // would GC them as orphans (symptom: texts vanish after refresh / empty docs on send).
        (m && m.files ? m.files : []).forEach(function (f) { if (f && f.id) keep[f.id] = 1; });
      };
      try {
        var all = JSON.parse(global.localStorage.getItem("cfw_chat_session_v1") || "{}") || {};
        if (Array.isArray(all)) all = { "__none__": all };
        Object.keys(all).forEach(function (slot) {
          (all[slot] || []).forEach(keepMsg);
        });
      } catch (e3) {}
      var arr = (global.__app && global.__app.getSessionMessages) ? global.__app.getSessionMessages() : [];
      (arr || []).forEach(keepMsg);
      // Not-yet-sent attachments must survive too.
      try {
        core.list().forEach(function (p) {
          if (p && p.id) keep[p.id] = 1;
        });
      } catch (e2) {}
      idb().then(function (db) {
        if (!db) return;
        try {
          var os = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
          os.openCursor().onsuccess = function (e) {
            var c = e.target.result;
            if (!c) return;
            if (!keep[c.key]) { try { c.delete(); } catch (e2) {} }
            c.continue();
          };
        } catch (e) {}
      });
    } catch (e) {}
  }

  // ───────── Core instantiation: IDB ports + strip re-render hook ─────────
  const core = createAttachmentsCore({
    putBlob: putBlob,
    getBlob: getBlob,
    onPendingChange: function () { renderPendingBar(); }
  });

  const DOC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

  // ───────── CSS (self-injected, colors via theme tokens) ─────────
  const STYLE_ID = "attachStyles";
  const CSS_TEXT = `
.att-strip{pointer-events:auto;width:100%;max-width:var(--content-max);margin:0 auto 8px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;}
.att-strip:empty{display:none;}
.att-chip{position:relative;display:inline-flex;align-items:center;gap:8px;max-width:min(250px,72vw);padding:8px 14px;border-radius:999px;background:var(--bubble-ai,rgba(127,127,127,.10));border:1px solid var(--border,rgba(127,127,127,.24));box-shadow:0 1px 6px rgba(0,0,0,.10);font-size:12.5px;line-height:1.2;color:inherit;}
.att-chip-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;}
.att-chip-ico svg{width:18px;height:18px;display:block;}
.att-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
.att-chip-trunc{flex:none;font-size:10px;font-weight:700;line-height:1;padding:3px 6px;border-radius:999px;color:#ffb648;border:1px solid rgba(255,182,72,.45);background:rgba(255,182,72,.12);}
.att-x{flex:none;width:19px;height:19px;border:none;border-radius:999px;background:rgba(127,127,127,.18);color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:0;display:inline-flex;align-items:center;justify-content:center;opacity:.65;transition:opacity .15s,background .15s;}
.att-x:hover{opacity:1;background:rgba(232,96,125,.28);}
.att-wrap{display:flex;flex-direction:column;gap:6px;max-width:100%;margin:0 0 6px;}
.att-wrap:empty{display:none;}
.att-chips{display:flex;flex-wrap:wrap;gap:6px;}
.att-cards{display:flex;flex-wrap:wrap;gap:6px;}
.att-cards:empty{display:none;}
.att-card{position:relative;flex:none;height:96px;border-radius:10px;overflow:hidden;border:1px solid var(--border,rgba(127,127,127,.28));cursor:zoom-in;background:rgba(127,127,127,.12);transition:transform .15s ease,box-shadow .15s ease;}
.att-card:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.28);}
.att-card img{display:block;height:100%;width:auto;max-width:min(320px,60vw);object-fit:cover;}
.att-card.att-missing{display:flex;align-items:center;justify-content:center;width:120px;cursor:default;color:var(--muted,#9a9a9a);font-size:10.5px;text-align:center;padding:0 8px;line-height:1.4;}
.att-card .att-x{position:absolute;right:4px;top:4px;background:rgba(20,20,20,.72);color:#fff;}
#attLightbox{position:fixed;inset:0;background:rgba(0,0,0,.86);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9990;padding:24px;box-sizing:border-box;animation:attFade .16s ease;}
#attLightbox img{max-width:92vw;max-height:86vh;object-fit:contain;border-radius:10px;box-shadow:0 30px 80px rgba(0,0,0,.6);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;will-change:transform;}
#attLightbox img.zoom-anim{transition:transform .18s ease;}
#attLightbox .att-lb-hint{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,.6);font-size:11px;letter-spacing:.02em;pointer-events:none;white-space:nowrap;text-shadow:0 1px 4px rgba(0,0,0,.6);}
#attLightbox .att-lb-nav{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.22);background:rgba(30,30,30,.7);color:#fff;font-size:18px;line-height:1;cursor:pointer;display:none;align-items:center;justify-content:center;font-family:inherit;}
#attLightbox .att-lb-nav.show{display:flex;}
#attLightbox .att-lb-nav:hover{background:rgba(60,60,60,.85);}
#attLightbox .att-lb-nav.prev{left:12px;}
#attLightbox .att-lb-nav.next{right:12px;}
#attLightbox .att-lb-count{position:absolute;bottom:17px;left:16px;color:rgba(255,255,255,.7);font-size:12px;font-variant-numeric:tabular-nums;}
@media (max-width:640px){#attLightbox .att-lb-nav{top:auto;bottom:40px;transform:none;}}
.att-lb-bar{position:absolute;top:14px;right:16px;display:flex;gap:8px;}
.att-lb-bar a,.att-lb-bar button{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,255,255,.22);background:rgba(30,30,30,.7);color:#fff;font-size:12px;text-decoration:none;cursor:pointer;font-family:inherit;}
.att-lb-bar a:hover,.att-lb-bar button:hover{background:rgba(60,60,60,.85);}
@keyframes attFade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.att-card{transition:none;}#attLightbox{animation:none;}}
@media (max-width:640px){.att-card{height:76px;}#attLightbox{padding:12px;}}
`;
  function ensureCss() {
    const doc = global.document;
    if (doc.getElementById(STYLE_ID)) return;
    const s = doc.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (doc.head || doc.documentElement).appendChild(s);
  }

  // ───────── Lightbox (double-tap zoom / pinch / pan when zoomed / wheel zoom / swipe nav) ─────────
  let lbEl = null;
  function closeLightbox() {
    if (!lbEl) return;
    if (lbEl.parentNode) lbEl.parentNode.removeChild(lbEl);
    lbEl = null;
    global.document.removeEventListener("keydown", lbKey, true);
  }
  function lbKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); closeLightbox(); return; }
    // Multi-image keyboard navigation (desktop)
    if (lbEl && typeof lbEl.__nav === "function") {
      if (e.key === "ArrowRight") { e.stopPropagation(); lbEl.__nav(1); }
      else if (e.key === "ArrowLeft") { e.stopPropagation(); lbEl.__nav(-1); }
    }
  }
  function openLightbox(src, name, list, index) {
    const doc = global.document;
    ensureCss();
    closeLightbox();
    lbEl = doc.createElement("div");
    lbEl.id = "attLightbox";
    const items = (Array.isArray(list) && list.length) ? list : [{ src: src, name: name }];
    let cur = Math.max(0, Math.min(items.length - 1, index || 0));
    const img = doc.createElement("img");
    img.src = src;
    img.alt = name || "附件图片";
    img.draggable = false;
    const hint = doc.createElement("div");
    hint.className = "att-lb-hint";
    hint.textContent = "双击放大 · 捏合缩放 · 放大后可拖动";
    const count = doc.createElement("div");
    count.className = "att-lb-count";
    const bar = doc.createElement("div");
    bar.className = "att-lb-bar";
    const dl = doc.createElement("a");
    dl.href = src; dl.download = name || "image"; dl.textContent = "下载";
    // The mobile shell does not support <a download> — route through the shell's
    // export_binary_file (writes into the Android/media visible dir); the web build keeps the
    // native download untouched.
    dl.addEventListener("click", function (e) {
      const sf = global.__saveFile;
      if (!sf || !sf.isTauri || !sf.isTauri() || !sf.saveBinaryFile) return;
      e.preventDefault(); e.stopPropagation();
      const it = items[cur] || {};
      sf.saveBinaryFile(it.src || img.src, it.name || "image.png").then(function (r) {
        const msg = (r && r.ok) ? ("已保存：" + (r.path || r.filename || "文件")) : ("保存失败：" + ((r && r.error) || "未知错误"));
        try { if (global.__feedback && global.__feedback.toast) global.__feedback.toast(msg, 3200); } catch (e3) {}
      });
    });
    const op = doc.createElement("button");
    op.type = "button"; op.textContent = "新标签打开";
    op.addEventListener("click", function (e) { e.stopPropagation(); try { global.open(img.src, "_blank"); } catch (e2) {} });
    const cl = doc.createElement("button");
    cl.type = "button"; cl.textContent = "关闭";
    bar.appendChild(dl); bar.appendChild(op); bar.appendChild(cl);
    const prev = doc.createElement("button");
    prev.type = "button"; prev.className = "att-lb-nav prev"; prev.textContent = "‹"; prev.setAttribute("aria-label", "上一张");
    const next = doc.createElement("button");
    next.type = "button"; next.className = "att-lb-nav next"; next.textContent = "›"; next.setAttribute("aria-label", "下一张");
    lbEl.appendChild(img); lbEl.appendChild(bar); lbEl.appendChild(hint); lbEl.appendChild(count); lbEl.appendChild(prev); lbEl.appendChild(next);
    lbEl.addEventListener("click", function (e) { if (e.target === lbEl || e.target === cl) closeLightbox(); });
    doc.body.appendChild(lbEl);
    doc.addEventListener("keydown", lbKey, true);

    function show(i) {
      cur = Math.max(0, Math.min(items.length - 1, i));
      const it = items[cur];
      reset();
      img.src = it.src;
      img.alt = it.name || "附件图片";
      dl.href = it.src; dl.download = it.name || "image";
      const many = items.length > 1;
      prev.classList.toggle("show", many);
      next.classList.toggle("show", many);
      count.textContent = many ? ((cur + 1) + "/" + items.length) : "";
    }
    function nav(delta) { if (items.length > 1) show(cur + delta); }
    lbEl.__nav = nav;
    prev.addEventListener("click", function (e) { e.stopPropagation(); nav(-1); });
    next.addEventListener("click", function (e) { e.stopPropagation(); nav(1); });

    // ── Zoom / pan gestures (Pointer Events: one path for touch and mouse) ──
    let scale = 1, tx = 0, ty = 0;
    const pointers = new Map();
    let pinchBase = null;      // { dist, midX, midY, scale0, tx0, ty0 }
    let panBase = null;        // { x, y, tx0, ty0 }
    let lastTap = { t: 0, x: 0, y: 0 };
    let swipeStart = null; // horizontal swipe switches image at 1x
    const MAX_SCALE = 8, MIN_SCALE = 1;
    show(cur);

    function apply(anim) {
      if (anim) img.classList.add("zoom-anim"); else img.classList.remove("zoom-anim");
      img.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
    }
    function clampPan() {
      const maxX = Math.max(0, (img.clientWidth * scale - lbEl.clientWidth) / 2 + 24);
      const maxY = Math.max(0, (img.clientHeight * scale - lbEl.clientHeight) / 2 + 24);
      tx = Math.max(-maxX, Math.min(maxX, tx));
      ty = Math.max(-maxY, Math.min(maxY, ty));
      if (scale <= MIN_SCALE + 0.001) { tx = 0; ty = 0; }
    }
    function zoomAt(factor, cx, cy) { // cx/cy = client focus point; zoom around it (translate outer, scale inner)
      const s0 = scale;
      const s1 = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
      if (s1 === s0) return;
      const rect = img.getBoundingClientRect();
      const cx0 = rect.left + rect.width / 2, cy0 = rect.top + rect.height / 2;
      scale = s1;
      tx = tx + (cx - cx0) * (1 - scale / s0);
      ty = ty + (cy - cy0) * (1 - scale / s0);
      clampPan();
      apply(false);
    }
    function reset() { scale = 1; tx = 0; ty = 0; apply(true); }

    img.addEventListener("pointerdown", function (e) {
      e.preventDefault(); // swallow the synthetic click so pinch/pan never closes on backdrop
      try { img.setPointerCapture(e.pointerId); } catch (e2) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const pts = [];
        pointers.forEach(function (p) { pts.push(p); });
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        pinchBase = {
          dist: dist,
          midX: (pts[0].x + pts[1].x) / 2, midY: (pts[0].y + pts[1].y) / 2,
          scale0: scale, tx0: tx, ty0: ty
        };
        panBase = null;
      } else if (pointers.size === 1 && scale > MIN_SCALE + 0.001) {
        panBase = { x: e.clientX, y: e.clientY, tx0: tx, ty0: ty };
        swipeStart = null;
      } else if (pointers.size === 1) {
        swipeStart = { x: e.clientX, y: e.clientY };
      }
    });
    img.addEventListener("pointermove", function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2 && pinchBase) {
        const pts = [];
        pointers.forEach(function (p) { pts.push(p); });
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
        const s0 = pinchBase.scale0;
        const s1 = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s0 * (dist / pinchBase.dist)));
        // Baseline geometry: zoom from the pinch start, keeping the two-finger midpoint fixed
        const rect = img.getBoundingClientRect();
        const cx0 = rect.left + rect.width / 2 - tx, cy0 = rect.top + rect.height / 2 - ty; // untransformed center
        const baseMidDX = pinchBase.midX - (cx0 + pinchBase.tx0);
        const baseMidDY = pinchBase.midY - (cy0 + pinchBase.ty0);
        scale = s1;
        tx = midX - cx0 - baseMidDX * (scale / s0);
        ty = midY - cy0 - baseMidDY * (scale / s0);
        clampPan();
        apply(false);
      } else if (pointers.size === 1 && panBase) {
        tx = panBase.tx0 + (e.clientX - panBase.x);
        ty = panBase.ty0 + (e.clientY - panBase.y);
        clampPan();
        apply(false);
      }
    });
    function onUp(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchBase = null;
      if (pointers.size === 1) {
        let rest = null;
        pointers.forEach(function (p) { rest = p; });
        panBase = (scale > MIN_SCALE + 0.001) ? { x: rest.x, y: rest.y, tx0: tx, ty0: ty } : null;
      } else {
        panBase = null;
        if (scale <= MIN_SCALE + 0.001) reset();
      }
      // 1x horizontal swipe -> previous/next image (multi-image only)
      if (swipeStart && scale <= MIN_SCALE + 0.001) {
        const sdx = e.clientX - swipeStart.x, sdy = e.clientY - swipeStart.y;
        if (Math.abs(sdx) > 60 && Math.abs(sdx) > 2 * Math.abs(sdy)) {
          swipeStart = null;
          nav(sdx < 0 ? 1 : -1);
          return;
        }
      }
      swipeStart = null;
      // Double-tap detection (two quick pointerups near the same spot)
      const now = Date.now();
      if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 28) {
        lastTap = { t: 0, x: 0, y: 0 };
        if (scale > MIN_SCALE + 0.05) reset();
        else zoomAt(2.5, e.clientX, e.clientY);
        return;
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
    img.addEventListener("pointerup", onUp);
    img.addEventListener("pointercancel", function (e) {
      pointers.delete(e.pointerId);
      pinchBase = null; panBase = null;
      if (scale <= MIN_SCALE + 0.001) reset();
    });
    img.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    }, { passive: false });
  }

  // ───────── Rendering: text chip ─────────
  // Pill + colored doc icon + truncated filename; a visible "truncated" badge replaces the
  // hover-only title (mobile has no hover at all).
  function makeChipEl(f, onRemove) {
    const doc = global.document;
    const el = doc.createElement("span");
    el.className = "att-chip";
    el.title = f.name + " · " + core.fmtChars(f.chars) + (f.truncated ? "(已截断)" : "");
    const ico = doc.createElement("span");
    ico.className = "att-chip-ico";
    ico.style.color = typeColor(f.name);
    ico.innerHTML = DOC_SVG;
    const nm = doc.createElement("span");
    nm.className = "att-chip-name";
    nm.textContent = f.name;
    el.appendChild(ico);
    el.appendChild(nm);
    if (f.truncated) {
      const tg = doc.createElement("span");
      tg.className = "att-chip-trunc";
      tg.textContent = "已截断";
      tg.title = "原文 " + core.fmtChars(f.chars) + ",超过 " + core.ATT_MAX_CHARS + " 字上限,仅前 " + core.ATT_MAX_CHARS + " 字会发送";
      el.appendChild(tg);
    }
    if (onRemove) {
      const x = doc.createElement("button");
      x.type = "button"; x.className = "att-x"; x.textContent = "×"; x.title = "移除";
      x.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onRemove(); });
      el.appendChild(x);
    }
    return el;
  }

  // ───────── Rendering: image card (+ lightbox) ─────────
  // srcOf: use the in-memory dataUrl when present; on history restore fetch the blob by id
  // from IDB and convert to an objectURL (cached, bounded eviction).
  const _urlCache = new Map();
  const URL_CACHE_MAX = 40;
  function cachedUrl(id, blob) {
    if (_urlCache.has(id)) return _urlCache.get(id);
    const u = URL.createObjectURL(blob);
    _urlCache.set(id, u);
    if (_urlCache.size > URL_CACHE_MAX) {
      const firstKey = _urlCache.keys().next().value;
      try { URL.revokeObjectURL(_urlCache.get(firstKey)); } catch (e) {}
      _urlCache.delete(firstKey);
    }
    return u;
  }
  function makeCardEl(meta, src, onRemove) {
    const doc = global.document;
    if (!src) {
      const ph = doc.createElement("div");
      ph.className = "att-card att-missing";
      ph.textContent = "图片不可用(未同步到本设备)";
      ph.title = meta && meta.name ? meta.name : "";
      if (onRemove) {
        const x0 = doc.createElement("button");
        x0.type = "button"; x0.className = "att-x"; x0.textContent = "×";
        x0.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onRemove(); });
        ph.appendChild(x0);
      }
      return ph;
    }
    const card = doc.createElement("div");
    card.className = "att-card";
    const img = doc.createElement("img");
    img.src = src;
    img.alt = (meta && meta.name) || "附件图片";
    // Memory: a full history restore decodes every attachment image of the conversation —
    // keep offscreen ones unloaded / undecoded.
    try { img.loading = "lazy"; img.decoding = "async"; } catch (e) {}
    card.appendChild(img);
    card.addEventListener("click", function () {
      // Collect the loaded images of this group for the lightbox -> multi-image nav (placeholder
      // cards have no img and are skipped automatically)
      let group = [], idx = 0;
      try {
        const imgs = card.parentNode ? card.parentNode.querySelectorAll(".att-card img") : [];
        for (let i = 0; i < imgs.length; i++) {
          if (imgs[i].src) group.push({ src: imgs[i].src, name: imgs[i].alt || "" });
          if (imgs[i] === img) idx = group.length - 1;
        }
      } catch (e) {}
      openLightbox(src, (meta && meta.name) || "", group.length > 1 ? group : null, idx);
    });
    if (onRemove) {
      const x = doc.createElement("button");
      x.type = "button"; x.className = "att-x"; x.textContent = "×"; x.title = "移除";
      x.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onRemove(); });
      card.appendChild(x);
    }
    return card;
  }
  // The one "append an image card" entry: dataUrl is used directly; with only an id, place the
  // placeholder first and swap in the real image once IDB yields the blob.
  function appendImageCard(container, meta, onRemove) {
    const inner = makeCardEl(meta, (meta && meta.dataUrl) || "", onRemove);
    container.appendChild(inner);
    if (meta && !meta.dataUrl && meta.id) {
      getBlob(meta.id).then(function (blob) {
        if (!blob) return; // not on this device / already cleaned -> keep the placeholder
        const real = makeCardEl(meta, cachedUrl(meta.id, blob), onRemove);
        if (inner.parentNode === container) container.replaceChild(real, inner);
      });
    }
    return inner;
  }
  // Render one {files, images, _memImages} bundle into a container.
  // opts.before: insert the attachment block BEFORE that element (in chat = above the bubble,
  // its own block like ZCode); omit to append at the end (pending strip use).
  function renderInto(container, att, opts) {
    if (!container || !att) return container;
    ensureCss();
    opts = opts || {};
    const doc = global.document;
    const host = (opts.before && opts.before.parentNode) ? opts.before.parentNode : container;
    let wrap = host.querySelector(":scope > .att-wrap");
    if (!wrap) {
      wrap = doc.createElement("div");
      wrap.className = "att-wrap";
      if (opts.before && opts.before.parentNode === host) host.insertBefore(wrap, opts.before);
      else host.appendChild(wrap);
    }
    // ZCode order: image thumbnails on top, file chips on the next row, bubble at the bottom
    const imgs = (att._memImages && att._memImages.length) ? att._memImages : (att.images || []);
    if (imgs.length) {
      const cards = doc.createElement("div");
      cards.className = "att-cards";
      wrap.appendChild(cards);
      imgs.forEach(function (m) {
        appendImageCard(cards, m, opts.onRemoveImage ? function () { opts.onRemoveImage(m); } : null);
      });
    }
    if (att.files && att.files.length) {
      const row = doc.createElement("div");
      row.className = "att-chips";
      att.files.forEach(function (f) {
        row.appendChild(makeChipEl(f, opts.onRemoveFile ? function () { opts.onRemoveFile(f); } : null));
      });
      wrap.appendChild(row);
    }
    return container;
  }

  // ───────── Pending strip (above the composer) ─────────
  let stripEl = null;
  function mountStrip() {
    const doc = global.document;
    ensureCss();
    if (stripEl && stripEl.parentNode) return stripEl;
    const anchor = doc.getElementById("composer");
    const floating = doc.querySelector(".input-floating");
    if (!anchor && !floating) return null;
    stripEl = doc.createElement("div");
    stripEl.id = "attachStrip";
    stripEl.className = "att-strip";
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(stripEl, anchor);
    else floating.insertBefore(stripEl, floating.firstChild);
    return stripEl;
  }
  function renderPendingBar() {
    const el = mountStrip();
    if (!el) return;
    el.textContent = "";
    const all = core.list();
    if (!all.length) { el.style.display = "none"; return; }
    el.style.display = "";
    // Same order as in chat: images on top, file chips below (each removable)
    const imgs = all.filter(function (p) { return p.kind === "image"; });
    const files = all.filter(function (p) { return p.kind === "text"; });
    if (imgs.length) {
      const cards = global.document.createElement("div");
      cards.className = "att-cards";
      imgs.forEach(function (p) { appendImageCard(cards, p, function () { core.remove(p.id); }); });
      el.appendChild(cards);
    }
    if (files.length) {
      const row = global.document.createElement("div");
      row.className = "att-chips";
      files.forEach(function (p) { row.appendChild(makeChipEl(p, function () { core.remove(p.id); })); });
      el.appendChild(row);
    }
  }
  // Put a sent message's attachments back into the pending list (retry path): the legacy
  // implementation rebuilt the message from bubble text and the attachments were gone for
  // good — that was the root cause of "retry after switching model loses the attachment".
  function restage(msg) {
    return core.restage(msg);
  }

  // ───────── History-restore rendering + long-message fold ─────────
  // Render a restored message's attachments ABOVE the bubble (chips + image cards, ZCode look)
  function renderAttachmentsInto(bubble, att) {
    if (!bubble || !att) return;
    if (!core.attHasAny(att) && !(att._memImages && att._memImages.length)) return;
    try {
      renderInto(bubble.parentNode || bubble, att, { before: bubble });
    } catch (_) {}
  }
  const USER_FOLD_CHARS = 420;
  const USER_FOLD_LINES = 12;
  // Long user-message fold (2026-09-14): pasted long texts collapse the bubble (bottom fade +
  // expand arrow) instead of flooding the screen. Presentation only: the session keeps the
  // full content (retry/resend read the session, not the bubble text), so nothing is lost.
  function applyUserFold(bubble) {
    const doc = global.document;
    if (!bubble || bubble.querySelector(":scope > .uc-wrap")) return;
    const raw = bubble.textContent || "";
    if (raw.length <= USER_FOLD_CHARS && raw.split(String.fromCharCode(10)).length <= USER_FOLD_LINES) return;
    const inner = doc.createElement("div");
    inner.className = "uc-inner";
    // Move text nodes only; the attachment block (att-wrap) stays outside the fold
    Array.prototype.slice.call(bubble.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && n.classList && n.classList.contains("att-wrap")) return;
      inner.appendChild(n);
    });
    if (!inner.childNodes.length) return;
    const wrap = doc.createElement("div");
    wrap.className = "uc-wrap folded";
    wrap.appendChild(inner);
    bubble.appendChild(wrap);
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "uc-toggle";
    btn.title = "展开全文";
    btn.setAttribute("aria-label", "展开全文");
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      const folded = wrap.classList.toggle("folded");
      btn.title = folded ? "展开全文" : "收起";
      btn.setAttribute("aria-label", btn.title);
    });
    bubble.appendChild(btn);
  }

  // ───────── Frozen facade: key set is the contract, do not rename ─────────
  global.__attach = {
    list: core.list, count: core.count, countImages: core.countImages, clear: core.clear, remove: core.remove,
    addText: core.addText, addImage: core.addImage,
    takePending: core.takePending, restage: restage,
    renderInto: renderInto,
    renderPendingBar: renderPendingBar,
    openLightbox: openLightbox,
    putBlob: putBlob, getBlob: getBlob, delBlob: delBlob,
    imageDataUrl: core.imageDataUrl,
    fileFullText: core.fileFullText,
    fmtChars: core.fmtChars, fmtBytes: core.fmtBytes, esc: esc,
    attHasAny: core.attHasAny, attMeta: core.attMeta, attMaxChars: core.attMaxChars,
    attFileTokens: core.attFileTokens,
    renderAttachmentsInto: renderAttachmentsInto,
    applyUserFold: applyUserFold,
    expandAttachmentMessages: core.expandAttachmentMessages,
    ATT_MAX_CHARS: ATT_MAX_CHARS
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

globalThis.ATT_MAX_CHARS = ATT_MAX_CHARS;
globalThis.fmtChars = fmtChars;
globalThis.fmtBytes = fmtBytes;
globalThis.extOf = extOf;
globalThis.typeColor = typeColor;
globalThis.createAttachmentsCore = createAttachmentsCore;
})();
