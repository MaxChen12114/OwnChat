/**
 * Scene scoping, speaker projection, tool-protocol sanitizing and the token watermark.
 *
 * Everything that is read at call time arrives as a getter on {@link ContextEnv} — multi, character,
 * agentKernel, the ctxExact/ctxHints tables, storage and the current model id — so the old "look it up
 * when needed, never capture up front" semantics survive. The host callbacks passed to `create()`
 * (getActiveConvId / getSession) stay injected by the caller.
 *
 * Equivalence: the golden fingerprint in test/context.test.mjs plus the side-by-side run in
 * test/chat-migration-equiv.test.mjs.
 * @module services/chat/context
 */

export interface ChatMessage {
  role?: string;
  content?: unknown;
  sc?: string;
  to?: string;
  speakerName?: string;
  speakerId?: string;
  speakerIcon?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  reasoning_content?: string;
  /** The visible text of a tool-round assistant message, carried over as-is: the old code was
   *  `if (m.content) a.agentPreamble = m.content`, with no type test, so an array content came across too.
   *  It stays `unknown` here for behaviour parity; consumers narrow it themselves. */
  agentPreamble?: unknown;
  _uiOnly?: boolean;
  _tool?: unknown;
  _meta?: unknown;
  images?: unknown;
  files?: unknown;
  [key: string]: unknown;
}

export interface ScopeCard {
  id?: string;
  name?: string;
  icon?: string;
}

export interface ContextEnv {
  readonly multi?: { isMulti(): boolean };
  readonly character?: { getActiveCard(): ScopeCard | null };
  readonly agentKernel?: { pairPendingToolCalls(msgs: ChatMessage[], reason: string): void };
  readonly ctxExact?: Record<string, number>;
  readonly ctxHints?: [string, number][];
  readonly storage: { getItem(key: string): string | null };
  /** #modelSel.value or cfw_model, empty when neither exists; the wiring layer swallows any throw. */
  modelId(): string;
}

export interface ContextHost {
  getActiveConvId?(): string;
  getSession?(): ChatMessage[];
}

export interface ContextApi {
  currentScopeKey(): string;
  scopeTag<T extends ChatMessage>(obj: T): T;
  scopeLabel(sc: string): string;
  selectSpeakerView(msgs: ChatMessage[], opts?: { scope?: string; card?: ScopeCard | null }): ChatMessage[];
  sanitizeToolProtocol(msgs: ChatMessage[], opts?: { dropToolRounds?: boolean }): ChatMessage[];
  kernelMessagesToSession(allMsgs: ChatMessage[], o?: Record<string, unknown>): ChatMessage[];
  estimateTokens(text: string): number;
  ctxLimitForCompact(): number;
  sessTokensForCompact(): number;
  /** Numeric compaction gate: 4-message floor, then token watermark (70%) or count trigger. */
  shouldCompact(sessionLength: unknown, summaryTrigger: unknown): boolean;
  /** Leading messages to summarize plus their count, or null when nothing is cut. */
  planCompact(session: unknown, keep: unknown): { cutoff: number; toSum: Record<string, unknown>[] } | null;
  /** Trimmed summary from an upstream reply, or null for every unusable shape. */
  readSummary(payload: unknown): string | null;
  toRenderableMessages(arr: ChatMessage[]): ChatMessage[];
}

// Implementation mirrors the old context.js statement by statement; only window lookups became env ports.

/** unknown -> Record read bridge (via Object.entries; arrays and scalars yield an empty shell), no assertions. */
function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Leading messages to summarize plus their count, or null when nothing is cut. `cutoff` is floored
 * at zero; the same slice feeds both the request body and the host's DOM row removal.
 */
function planCompact(session: unknown, keep: unknown): { cutoff: number; toSum: Record<string, unknown>[] } | null {
  if (!Array.isArray(session)) return null;
  const cutoff = Math.max(0, session.length - asNumber(keep, 10));
  if (cutoff <= 0) return null;
  const toSum: Record<string, unknown>[] = [];
  for (let i = 0; i < cutoff; i++) toSum.push(recOf(session[i]));
  return { cutoff, toSum };
}

/** Trimmed summary from an upstream reply, or null for every unusable shape. */
function readSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = recOf(payload)["summary"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

type SteeredFn = (m: ChatMessage) => boolean;
function isSteeredFn(v: unknown): v is SteeredFn { return typeof v === "function"; }
function isScopeCard(v: unknown): v is ScopeCard {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function createContextFactory(env: ContextEnv) {
  return {
    create(host?: ContextHost): ContextApi {
      const h = host || {};
      const getActiveConvId = typeof h.getActiveConvId === "function" ? h.getActiveConvId : function () { return ""; };
      const getSession = typeof h.getSession === "function" ? h.getSession : function () { return []; };

      function currentScopeKey() {
        try {
          const M = env.multi;
          // Group chat must scope per conversation: the old code returned the constant "group", so a new
          // conversation inherited the previous one's history.
          if (M && M.isMulti && M.isMulti()) {
            let cid = "";
            try { cid = getActiveConvId(); } catch (e) { cid = ""; }
            return cid ? ("group:" + cid) : "group";
          }
        } catch (e) {}
        try {
          const c = env.character && env.character.getActiveCard ? env.character.getActiveCard() : null;
          if (c && c.id) return "char:" + c.id;
        } catch (e) {}
        return "free";
      }

      function scopeTag<T extends ChatMessage>(obj: T): T {
        try { obj.sc = currentScopeKey(); } catch (e) {}
        return obj;
      }

      function scopeLabel(sc: string) {
        if (sc === "group") return "群聊";
        if (sc === "free") return "自由对话";
        if (sc && sc.indexOf("char:") === 0) return "单聊";
        return "全部";
      }

      // Project the shared session into one speaker's context: scope filter, speaker projection, private whispers.
      function selectSpeakerView(msgs: ChatMessage[], opts?: { scope?: string; card?: ScopeCard | null }) {
        const scope = (opts && opts.scope) || currentScopeKey();
        const card = (opts && opts.card) || null;
        const myName = (card && typeof card.name === "string") ? card.name : "";
        const out: ChatMessage[] = [];
        for (const m of msgs || []) {
          if (!m || !m.role) continue;
          if (m._uiOnly) continue;
          if (m.sc && m.sc !== scope && !(scope.indexOf("group:") === 0 && m.sc === "group")) continue;
          if (m.to && myName && m.to !== myName) continue;
          if (m.role === "assistant" && !(Array.isArray(m.tool_calls) && m.tool_calls.length)) {
            const speaker = typeof m.speakerName === "string" ? m.speakerName : "";
            if (myName && speaker && speaker !== myName) {
              out.push({ role: "user", content: "【" + speaker + "】" + (typeof m.content === "string" ? m.content : "") });
              continue;
            }
          }
          out.push(m);
        }
        return out;
      }

      // Agent protocol assembly (G-1/G-2/G-3) plus UI-field stripping and dangling-tool_call self-healing.
      function sanitizeToolProtocol(msgs: ChatMessage[], opts?: { dropToolRounds?: boolean }) {
        const drop = !!(opts && opts.dropToolRounds);
        const out: ChatMessage[] = [];
        (msgs || []).forEach((m) => {
          if (!m || !m.role) return;
          if (m._uiOnly) return;
          if (m.role === "tool") {
            if (!drop) out.push({ role: "tool", tool_call_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : String(m.content == null ? "" : JSON.stringify(m.content)) });
            return;
          }
          const hasTC = m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length;
          if (hasTC && drop) return;
          // Array content (vision image+text) must be preserved as-is, never flattened to ""
          const o: ChatMessage = { role: m.role, content: typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content : "") };
          if (hasTC) {
            o.content = "";
            o.tool_calls = m.tool_calls;
            if (typeof m.reasoning_content === "string" && m.reasoning_content) o.reasoning_content = m.reasoning_content;
          }
          if (typeof m.speakerName === "string") o.speakerName = m.speakerName;
          if (typeof m.speakerId === "string") o.speakerId = m.speakerId;
          out.push(o);
        });
        if (!drop) {
          const declared = new Set<unknown>();
          for (const m of out) {
            if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
              for (const c of m.tool_calls) {
                const call = recOf(c);
                if (c && call.id) declared.add(call.id);
              }
            }
          }
          const kept = out.filter((m) => m.role !== "tool" || (m.tool_call_id && declared.has(m.tool_call_id)));
          try {
            if (env.agentKernel && typeof env.agentKernel.pairPendingToolCalls === "function") {
              env.agentKernel.pairPendingToolCalls(kept, "回合被中断，工具结果未知（客户端协议自愈）");
            }
          } catch (e) {}
          return kept;
        }
        return out;
      }

      // One CJK character is roughly one token; four other characters are roughly one, whitespace skipped.
      function estimateTokens(text: string) {
        if (!text) return 0;
        let cjk = 0, ascii = 0;
        for (const ch of text) {
          const code = ch.charCodeAt(0);
          if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
          const isCJK =
            (code >= 0x4E00 && code <= 0x9FFF) ||
            (code >= 0x3400 && code <= 0x4DBF) ||
            (code >= 0x3040 && code <= 0x30FF) ||
            (code >= 0xAC00 && code <= 0xD7AF) ||
            (code >= 0xFF00 && code <= 0xFFEF);
          if (isCJK) cjk++; else ascii++;
        }
        return cjk + Math.ceil(ascii / 4);
      }

      // Manual override, else APP_CTX_EXACT/HINTS pushed by the worker's /config.js, else the 128K fallback.
      function ctxLimitForCompact() {
        let v = 0;
        try { v = parseInt(env.storage.getItem("cfw_ctx_window_v1") || "", 10) || 0; } catch (e) {}
        if (v >= 1024) return v;
        try {
          const mid = env.modelId();
          const exact = env.ctxExact || {};
          if (mid && exact[mid]) return exact[mid];
          const hints = Array.isArray(env.ctxHints) ? env.ctxHints : [];
          for (let i = 0; i < hints.length; i++) {
            try { if (new RegExp(hints[i][0], "i").test(mid)) return hints[i][1]; } catch (e) {}
          }
        } catch (e) {}
        return 131072;
      }

      function sessTokensForCompact() {
        let t = 0;
        for (const m of getSession() || []) {
          if (m && typeof m.content === "string") t += estimateTokens(m.content);
        }
        return t;
      }

      // Numeric gate only: the host short-circuits the on/off switches and the in-flight flag so
      // token counting stays off the common no-summarization path. 70% leaves room for the summary
      // request and the next turn; the count trigger preserves the legacy short-message fallback.
      function shouldCompact(sessionLength: unknown, summaryTrigger: unknown): boolean {
        const length = asNumber(sessionLength, 0);
        if (length <= 4) return false;
        const limit = ctxLimitForCompact();
        const watermark = limit > 0 && sessTokensForCompact() >= limit * 0.7;
        return watermark || length > asNumber(summaryTrigger, 0);
      }

      function toRenderableMessages(arr: ChatMessage[]) {
        const next: ChatMessage[] = [];
        for (const m of arr || []) {
          if (!m || typeof m.content !== "string") continue;
          const role = m.role;
          if (role !== "user" && role !== "assistant" && role !== "tool") continue;
          const e: ChatMessage = { role, content: m.content };
          const hasTC = role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length;
          if (hasTC) {
            e.tool_calls = m.tool_calls;
            if (typeof m.agentPreamble === "string" && m.agentPreamble) e.agentPreamble = m.agentPreamble;
          }
          if (role === "tool") {
            if (typeof m.tool_call_id === "string") e.tool_call_id = m.tool_call_id;
            if (m._tool && typeof m._tool === "object") e._tool = m._tool;
          }
          if (typeof m.sc === "string" && m.sc) e.sc = m.sc;
          if (role === "assistant" && typeof m.reasoning_content === "string" && m.reasoning_content) {
            e.reasoning_content = m.reasoning_content;
          }
          if (role === "assistant") {
            if (typeof m.speakerId === "string") e.speakerId = m.speakerId;
            if (typeof m.speakerName === "string") e.speakerName = m.speakerName;
            if (typeof m.speakerIcon === "string") e.speakerIcon = m.speakerIcon;
            if (m._meta && typeof m._meta === "object") e._meta = m._meta;
          }
          if (Array.isArray(m.images) && m.images.length) e.images = m.images;
          if (m._uiOnly) e._uiOnly = true;
          if (role === "user") {
            if (Array.isArray(m.files) && m.files.length) e.files = m.files;
            if (Array.isArray(m.images) && m.images.length) e.images = m.images;
          }
          next.push(e);
        }
        return next;
      }

      // A33b: pure projection from kernel messages to session messages.
      function kernelMessagesToSession(allMsgs: ChatMessage[], o?: Record<string, unknown>) {
        const opt = o || {};
        const startLen = Number(opt.startLen) || 0;
        const isSteered: SteeredFn = isSteeredFn(opt.isSteered) ? opt.isSteered : function () { return false; };
        const card: ScopeCard | null = isScopeCard(opt.characterCard) ? opt.characterCard : null;
        const newMsgs = Array.isArray(allMsgs) ? allMsgs.slice(startLen) : [];
        if (newMsgs.length && newMsgs[newMsgs.length - 1].role === "assistant") newMsgs.pop();
        const out: ChatMessage[] = [];
        newMsgs.forEach((m) => {
          if (!m) return;
          if (isSteered(m)) return;
          if (m.role === "tool") {
            const t: ChatMessage = scopeTag({ role: "tool", tool_call_id: m.tool_call_id, content: m.content });
            if (m._tool) t._tool = m._tool;
            out.push(t);
            return;
          }
          if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            const a: ChatMessage = scopeTag({ role: "assistant", content: "", tool_calls: m.tool_calls });
            if (m.reasoning_content) a.reasoning_content = m.reasoning_content;
            if (m.content) a.agentPreamble = m.content;
            if (card) { a.speakerId = card.id; a.speakerName = card.name; a.speakerIcon = card.icon || "🙂"; }
            out.push(a);
            return;
          }
          out.push(scopeTag({ role: m.role, content: typeof m.content === "string" ? m.content : "" }));
        });
        return out;
      }

      return { currentScopeKey, scopeTag, scopeLabel, selectSpeakerView, sanitizeToolProtocol,
        kernelMessagesToSession,
        estimateTokens, ctxLimitForCompact, sessTokensForCompact,
        shouldCompact, planCompact, readSummary,
        toRenderableMessages };
    },
  };
}
