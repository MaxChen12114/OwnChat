(function () {
/**
 * Single exit for "write a file to disk": a Tauri shell writes through its own native command, the
 * browser answers with an `<a download>` click.
 *
 * The shell is probed through a port per call rather than assumed from the user agent, because an
 * Android WebView accepts the anchor click and then writes nothing — reporting that as success is
 * the failure this module exists to prevent. A cancelled or failed write therefore returns
 * `{ ok: false }` with a reason the caller can show.
 *
 * Ports: `shell` (the invoke bridge, `null` in a plain browser), `downloadText` / `downloadHref`
 * (Blob, object URL, anchor lifetime and the 4 s revoke schedule) and `now` (the default JSON
 * filename stamp). `l0/wiring/save-file.js` owns `window`/`document` and publishes the frozen
 * global; this file touches neither. Per-case assertions live in `test/save-file.test.mjs`.
 * @module services/save-file
 */

/** The shell's invoke bridge; rejects when the Rust side fails. */
                                                                                            

/** Written by the shell; `path` is the location the user picked. */
                                  
           
                
               
 

/** Written by the browser; the download's filename is the only receipt available. */
                                    
           
                  
                   
 

/** The save dialog was dismissed: nothing reached the disk, and that must stay visible. */
                                      
            
                  
                
 

                                   
            
                
 

                                                                                                      

                                
                                                                                               
                                                                                   
                           
                                                                                         
                                                 
                                                                             
                                                 
                                                                    
                
 

                           
                                                                       
                                                                      
                                                                         
                     
 

/** A binary input split into what each side needs. */
                                
                                                                         
                 
                                                                                                        
               
 

const DEFAULT_TEXT_NAME = "export.txt";
const DEFAULT_BINARY_NAME = "file.bin";
const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,(.*)$/;
const OCTET_STREAM_PREFIX = "data:application/octet-stream;base64,";

function textOf(v         )         {
  return v === null || v === undefined ? "" : String(v);
}

function recOf(v         )                          {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out                          = {};
  for (const [k, val] of Object.entries(v)) out[k] = val;
  return out;
}

/** The `message` of a thrown value when it has one, else its string form — the same text the old
 *  implementation interpolated into its failure messages. Shell rejections arrive as strings, so the
 *  plain `String(e)` fallback is the common path, not a corner case. */
function messageOf(e         )         {
  if (e instanceof Error && e.message) return e.message;
  const msg = recOf(e)["message"];
  if (typeof msg === "string" && msg.length) return msg;
  return String(e);
}

/** Splits a `data:` URL or bare base64 into the two shapes the callers need. */
function binaryPayload(input         )                {
  const raw = textOf(input);
  const m = DATA_URL_RE.exec(raw);
  const base64 = m && m[2] ? m[3] : raw.replace(/^data:[^,]*,/, "");
  return { base64, href: m ? raw : OCTET_STREAM_PREFIX + base64 };
}

/** `export-YYYY-MM-DD.json` — UTC, matching the old `toISOString().slice(0, 10)`. */
function jsonDefaultName(nowMs        )         {
  const d = new Date(nowMs);
  const iso = Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  return iso ? "export-" + iso + ".json" : "export.json";
}

function createSaveFile(ports               )           {
  async function saveTextFile(text         , filename          )                      {
    const name = String(filename || DEFAULT_TEXT_NAME);
    const body = textOf(text);
    const invoke = ports.shell();
    if (invoke) {
      try {
        const p = await invoke("export_text_file", { suggestedName: name, content: body });
        if (p) return { ok: true, mode: "tauri", path: String(p) };
        return { ok: false, cancelled: true, error: "已取消保存（未写盘）" };
      } catch (e) {
        return { ok: false, error: "写盘失败: " + messageOf(e) };
      }
    }
    try {
      ports.downloadText(name, body);
      return { ok: true, mode: "browser", filename: name };
    } catch (e) {
      return { ok: false, error: "下载失败: " + messageOf(e) };
    }
  }

  async function saveJsonFile(obj         , filename          )                      {
    const body = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    return saveTextFile(body, filename || jsonDefaultName(ports.now()));
  }

  async function saveBinaryFile(data         , filename          )                      {
    const name = String(filename || DEFAULT_BINARY_NAME);
    const payload = binaryPayload(data);
    const invoke = ports.shell();
    if (invoke) {
      try {
        const p = await invoke("export_binary_file", { suggestedName: name, base64Data: payload.base64 });
        if (p) return { ok: true, mode: "tauri", path: String(p) };
        return { ok: false, cancelled: true, error: "已取消保存（未写盘）" };
      } catch (e) {
        return { ok: false, error: "保存失败: " + messageOf(e) };
      }
    }
    try {
      ports.downloadHref(name, payload.href);
      return { ok: true, mode: "browser", filename: name };
    } catch (e) {
      return { ok: false, error: "下载失败: " + messageOf(e) };
    }
  }

  return {
    saveTextFile,
    saveJsonFile,
    saveBinaryFile,
    isTauri() {
      return ports.shell() !== null;
    },
  };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/save-file.ts; this file owns the frozen
// global name, the Tauri probe and the anchor lifetime.
//
// The 4 s cleanup is not cosmetic: the anchor has to stay in the DOM until the browser has consumed
// the click, and the object URL must outlive it, or the download fails silently on a slow machine.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);
  var CLEANUP_MS = 4000;

  function shellInvoke() {
    try {
      return G.tauriSvc ? G.tauriSvc.invokeOrNull() : null;
    } catch (e) {
      return null;
    }
  }

  function clickAnchor(a) {
    a.rel = "noopener";
    a.style.position = "fixed";
    a.style.left = "-9999px";
    a.style.top = "-9999px";
    G.document.body.appendChild(a);
    a.dispatchEvent(new G.MouseEvent("click", { bubbles: true, cancelable: true, view: G }));
  }

  function removeLater(a, revokeUrl) {
    G.setTimeout(function () {
      try { if (a && a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
      if (revokeUrl) { try { G.URL.revokeObjectURL(revokeUrl); } catch (e) {} }
    }, CLEANUP_MS);
  }

  var saveFile = createSaveFile({
    shell: shellInvoke,
    now: function () { return Date.now(); },
    downloadText: function (name, text) {
      var blob = new G.Blob([text], { type: "text/plain;charset=utf-8" });
      var url = G.URL.createObjectURL(blob);
      var a = G.document.createElement("a");
      a.href = url;
      a.download = name;
      clickAnchor(a);
      removeLater(a, url);
    },
    downloadHref: function (name, href) {
      var a = G.document.createElement("a");
      a.href = href;
      a.download = name;
      clickAnchor(a);
      removeLater(a, null);
    }
  });

  G.saveFileSvc = {
    saveTextFile: saveFile.saveTextFile,
    saveJsonFile: saveFile.saveJsonFile,
    saveBinaryFile: saveFile.saveBinaryFile,
    isTauri: saveFile.isTauri
  };
})();

globalThis.binaryPayload = binaryPayload;
globalThis.jsonDefaultName = jsonDefaultName;
globalThis.createSaveFile = createSaveFile;
})();
