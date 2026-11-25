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
export type InvokeFn = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Written by the shell; `path` is the location the user picked. */
export interface SaveResultTauri {
  ok: true;
  mode: "tauri";
  path: string;
}

/** Written by the browser; the download's filename is the only receipt available. */
export interface SaveResultBrowser {
  ok: true;
  mode: "browser";
  filename: string;
}

/** The save dialog was dismissed: nothing reached the disk, and that must stay visible. */
export interface SaveResultCancelled {
  ok: false;
  cancelled: true;
  error: string;
}

export interface SaveResultFailed {
  ok: false;
  error: string;
}

export type SaveResult = SaveResultTauri | SaveResultBrowser | SaveResultCancelled | SaveResultFailed;

export interface SaveFilePorts {
  /** Resolves the shell bridge, or null when this build has no shell. Probed per call: a shell
   *  injects its global before page scripts, but a harness may attach it later. */
  shell(): InvokeFn | null;
  /** Browser path for text payloads: Blob, object URL, anchor click, deferred revoke. */
  downloadText(name: string, text: string): void;
  /** Browser path for binary payloads: the href is already a `data:` URL. */
  downloadHref(name: string, href: string): void;
  /** Epoch ms; drives the `export-YYYY-MM-DD.json` default name. */
  now(): number;
}

export interface SaveFile {
  saveTextFile(text: unknown, filename?: unknown): Promise<SaveResult>;
  saveJsonFile(obj: unknown, filename?: unknown): Promise<SaveResult>;
  saveBinaryFile(data: unknown, filename?: unknown): Promise<SaveResult>;
  isTauri(): boolean;
}

/** A binary input split into what each side needs. */
export interface BinaryPayload {
  /** Base64 characters only — the shape `export_binary_file` expects. */
  base64: string;
  /** What the browser anchor points at: the original `data:` URL, or one wrapped around bare base64. */
  href: string;
}

const DEFAULT_TEXT_NAME = "export.txt";
const DEFAULT_BINARY_NAME = "file.bin";
const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,(.*)$/;
const OCTET_STREAM_PREFIX = "data:application/octet-stream;base64,";

function textOf(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function recOf(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = val;
  return out;
}

/** The `message` of a thrown value when it has one, else its string form — the same text the old
 *  implementation interpolated into its failure messages. Shell rejections arrive as strings, so the
 *  plain `String(e)` fallback is the common path, not a corner case. */
function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const msg = recOf(e)["message"];
  if (typeof msg === "string" && msg.length) return msg;
  return String(e);
}

/** Splits a `data:` URL or bare base64 into the two shapes the callers need. */
export function binaryPayload(input: unknown): BinaryPayload {
  const raw = textOf(input);
  const m = DATA_URL_RE.exec(raw);
  const base64 = m && m[2] ? m[3] : raw.replace(/^data:[^,]*,/, "");
  return { base64, href: m ? raw : OCTET_STREAM_PREFIX + base64 };
}

/** `export-YYYY-MM-DD.json` — UTC, matching the old `toISOString().slice(0, 10)`. */
export function jsonDefaultName(nowMs: number): string {
  const d = new Date(nowMs);
  const iso = Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  return iso ? "export-" + iso + ".json" : "export.json";
}

export function createSaveFile(ports: SaveFilePorts): SaveFile {
  async function saveTextFile(text: unknown, filename?: unknown): Promise<SaveResult> {
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

  async function saveJsonFile(obj: unknown, filename?: unknown): Promise<SaveResult> {
    const body = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    return saveTextFile(body, filename || jsonDefaultName(ports.now()));
  }

  async function saveBinaryFile(data: unknown, filename?: unknown): Promise<SaveResult> {
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
