/**
 * Streaming layer for /api/chat: assembles the request body, reads SSE, and hands the caller the
 * accumulated full text.
 *
 * studio, write, coding and flow all share this one. The old code carried three copies of the SSE
 * reader, so each of the two fixes it needed — characters dropped across a chunk boundary, and the
 * trailing partial line — had to be applied three times and regressed whenever one was missed.
 *
 * Dependencies arrive through {@link ChatStreamPorts}: storage (four LS keys), modelsFast (the
 * fast-tier list) and fetch (the network exit). No `window` here; the adapter and the try/catch
 * wrappers live in l0/wiring/chat-stream.js.
 *
 * The SSE line-prefix rule has two tiers that must not be merged: the chat pages match `data: `
 * with the space, while the tools pages' call() has always used the loose tier; unifying either
 * way silently drops frames on the other side. Per-case assertions: test/chat-stream.test.mjs.
 * @module services/data/chat-stream
 */

/** Key-value storage port: window.localStorage in the browser, a Map in the Node tests. */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Value of `key` on an unknown value — the zero-`as` bridge. Reading through an index signature
 * yields an implicit `any`, so it goes through Object.entries instead.
 * Non-object, or key absent, yields undefined.
 */
function propOf(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) if (entries[i][0] === key) return entries[i][1];
  return undefined;
}

/** One read() result, structurally matching what ReadableStream returns. */
export interface StreamRead {
  done: boolean;
  value?: Uint8Array;
}

/** Minimal reader shape: read plus releaseLock is all this module needs. */
export interface StreamReader {
  read(): Promise<StreamRead>;
  releaseLock(): void;
}

/** Minimal body shape; a real Response.body satisfies it structurally. */
export interface StreamBody {
  getReader(): StreamReader;
}

/** Minimal response shape: call() touches ok / status / body / text only. */
export interface StreamResponse {
  ok: boolean;
  status: number;
  body: StreamBody | null;
  text?: () => Promise<string>;
}

/** Request-init shape this module sends; a real RequestInit satisfies it structurally. */
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: unknown;
}

/** Per-call options, field for field the old `opts` object. */
export interface ChatStreamOpts {
  profile?: string;
  system?: string;
  user?: string;
  messages?: unknown[];
  model?: string;
  mode?: string;
  signal?: unknown;
  onDelta?: (full: string) => void;
  unlock?: boolean;
  unlockKey?: string;
  unlockToken?: string;
  persona?: boolean;
  thinking?: string;
}

/** readSse options: `tail` defaults to true (flush the trailing line), `permissive` to false (strict `data: `). */
export interface SseReadOpts {
  tail?: boolean;
  permissive?: boolean;
}

/** Environment ports, injected by the wiring layer; every window access stays over there. */
export interface ChatStreamPorts {
  storage: KvStorage;
  /** window.APP_MODELS_FAST; the shape is untrusted, so this side filters it. */
  modelsFast(): unknown;
  /** Network exit. */
  fetch(url: string, init: FetchInit): Promise<StreamResponse>;
}

/** Public surface, name for name identical to the old window contract. `v` stays 2. */
export interface ChatStreamApi {
  v: number;
  modeForModel(model?: string): string;
  buildBody(opts?: ChatStreamOpts): Record<string, unknown>;
  call(opts?: ChatStreamOpts): Promise<string>;
  readSse(
    res: StreamResponse | null,
    onData: (data: string, isTail: boolean) => void,
    opts?: SseReadOpts
  ): Promise<void>;
}

/**
 * Create a streaming instance. It keeps no state across requests; each call() uses its own reader.
 * @param ports - storage, fast-tier list and network exit.
 * @returns `v` (kept at 2 — raising it makes already-mounted pages initialise twice) plus the four entry points.
 */
export function createChatStream(ports: ChatStreamPorts): ChatStreamApi {
  const storage = ports.storage;

  /** Safe read: value or fallback. Matches the old `getItem(k) || d`, so an empty string falls back too. */
  function ls(key: string, fallback: string): string {
    try {
      const v = storage.getItem(key);
      return v === null || v === "" ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  // 2026-11-11: the write page carries its own switch key (cfw_write_unlock_v1), passed as unlockKey; the main site key is the default
  function unlocked(key?: string): boolean {
    return ls(key === undefined || key === "" ? "cfw_unlocked_v1" : key, "") === "1";
  }

  function token(): string {
    return ls("cfw_unlock_token_v1", "");
  }

  /** Model tier: anything listed in APP_MODELS_FAST goes fast, everything else free. coding and flow each had their own copy before. */
  function modeForModel(model?: string): string {
    const fast = ports.modelsFast();
    if (!Array.isArray(fast)) return "free";
    for (let i = 0; i < fast.length; i++) {
      const item: unknown = fast[i];
      let id = "";
      if (typeof item === "string") id = item;
      else {
        const value = propOf(item, "id");
        if (typeof value === "string") id = value;
      }
      if (id !== "" && id === model) return "fast";
    }
    return "free";
  }

  function buildBody(opts?: ChatStreamOpts): Record<string, unknown> {
    const o: ChatStreamOpts = opts === undefined || opts === null ? {} : opts;
    // persona may be forced either way: the coding page exposes it as an in-page checkbox rather than a LS key
    const on =
      typeof o.persona === "boolean"
        ? o.persona
        : o.unlock === false
          ? false
          : unlocked(o.unlockKey);
    // The old code was `opts.messages || [single default]`; an empty array is truthy, so it goes out as given
    const messages: unknown[] = Array.isArray(o.messages)
      ? o.messages
      : [{ role: "user", content: o.user || "" }];
    const body: Record<string, unknown> = {
      mode: o.mode || modeForModel(o.model),
      model: o.model || undefined,
      promptProfile: o.profile || "assist",
      use_builtin_persona: on,
      custom_system_prompt: o.system || "",
      thinking: o.thinking || "disabled",
      messages: messages,
    };
    if (on) {
      const tk = o.unlockToken || token();
      if (tk !== "") body.unlockToken = tk;
    }
    // 2026-10-05: the base version follows the settings page; when locked, the server picks per its own lock state
    const bid = ls("cfw_base_id_v1", "");
    if (bid !== "") body.baseId = bid;
    const nid = ls("cfw_neutral_id_v1", "");
    if (nid !== "") body.neutralId = nid;
    return body;
  }

  async function readSse(
    res: StreamResponse | null,
    onData: (data: string, isTail: boolean) => void,
    opts?: SseReadOpts
  ): Promise<void> {
    const o: SseReadOpts = opts === undefined || opts === null ? {} : opts;
    if (!res || !res.body || typeof res.body.getReader !== "function") {
      throw new Error("响应没有可读的流");
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    function take(line: string, isTail: boolean): void {
      let data: string;
      if (o.permissive === true) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.charAt(0) === ":") return;
        if (trimmed.indexOf("data:") !== 0) return;
        data = trimmed.slice(5).trim();
      } else {
        if (line.indexOf("data: ") !== 0) return;
        data = line.slice(6).trim();
      }
      if (data === "" || data === "[DONE]") return;
      onData(data, isTail);
    }

    try {
      while (true) {
        const rd = await reader.read();
        // Under stream:true a trailing partial UTF-8 sequence stays inside the decoder, so it must be flushed on done
        if (rd.done) {
          buf += dec.decode();
          break;
        }
        const chunk = rd.value;
        buf += dec.decode(chunk === undefined ? undefined : chunk, { stream: true });
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          take(line, false);
          i = buf.indexOf("\n");
        }
      }
      if (o.tail !== false) {
        const rest = buf.trim();
        if (rest !== "") take(rest, true);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (e) {}
    }
  }

  async function call(opts?: ChatStreamOpts): Promise<string> {
    const o: ChatStreamOpts = opts === undefined || opts === null ? {} : opts;
    const r = await ports.fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(o)),
      signal: o.signal,
    });
    if (!r.ok) {
      let t = "";
      try {
        if (typeof r.text === "function") t = await r.text();
      } catch (e) {}
      throw new Error("服务返回 " + r.status + (t !== "" ? " · " + t.slice(0, 160) : ""));
    }
    if (!r.body) throw new Error("服务未返回流式内容");
    let full = "";
    const onDelta = o.onDelta;
    await readSse(
      r,
      function (data: string) {
        try {
          const j: unknown = JSON.parse(data);
          const content = deltaContent(j);
          if (content !== "") {
            full += content;
            if (typeof onDelta === "function") onDelta(full);
          }
        } catch (e) {}
      },
      { permissive: true }
    );
    return full;
  }

  return {
    v: 2,
    modeForModel: modeForModel,
    buildBody: buildBody,
    call: call,
    readSse: readSse,
  };
}

/**
 * choices[0].delta.content of one SSE payload; any other shape yields "". The old code inlined the
 * `j && j.choices && …` chain inside call() with a guard per level, and this never throws either.
 */
function deltaContent(payload: unknown): string {
  const choices = propOf(payload, "choices");
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first: unknown = choices[0];
  const delta = propOf(first, "delta");
  const content = propOf(delta, "content");
  return typeof content === "string" ? content : "";
}
