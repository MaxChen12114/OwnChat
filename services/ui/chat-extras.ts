/**
 * The two chat-page extras: dropping files into the composer, and the sync-conflict panel.
 *
 * **Attachments.** A text or code file becomes a structured attachment (`attachSvc`), not a paragraph
 * pasted into the input: the chip above the composer is removable, the full text rides on the message's
 * `files` field and is expanded into the payload only at send time. Anything past the character budget
 * is truncated — and the user is told, because the old build only put the count in a chip's `title`,
 * which is invisible on a phone.
 *
 * **Images.** The quota counts **images only**, not attachments in general. Counting both meant two
 * text files silently consumed two of the four image slots, and the user experienced it as "only two
 * pictures allowed".
 *
 * **Conflicts.** When the same conversation diverged locally and in the cloud, the panel shows both
 * sides with a preview so a human can pick. The preview is the last non-empty message, cut to 60 chars,
 * because the first message is almost always the same greeting on both sides and tells you nothing.
 *
 * The decisions live here; `FileReader`, the DOM and the event wiring stay in the wiring.
 *
 * Lock: `test/chat-extras.test.mjs` (written with the migration).
 * @module services/ui/chat-extras
 */

export interface AttachResult {
  name: string;
  text: string;
  chars: number;
  truncated: boolean;
}

export interface FileLike {
  name?: string;
  type?: string;
}

export interface ConflictMeta {
  name?: unknown;
}

export interface ChatExtrasApi {
  isTextFile(file: FileLike | null | undefined): boolean;
  isImageFile(file: FileLike | null | undefined): boolean;
  truncateForModel(text: unknown, max?: unknown): AttachResult | null;
  imageRoom(usedImages: unknown, max?: unknown): { take: number; overflow: boolean };
  previewOf(msgs: unknown): string;
  convMetaOf(raw: unknown, slotKey: unknown): ConflictMeta | null;
  slotLabel(raw: unknown, slotKey: unknown): string;
}

/** Extensions accepted as text. Anything else is skipped with a visible notice. */
const EXTRAS_TEXT_EXT =
  /\.(txt|text|md|markdown|mdx|rst|json|jsonc|json5|csv|tsv|log|ya?ml|toml|ini|conf|env|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|sql|graphql|gql|lua|dart|swift|r|pl)$/i;
const EXTRAS_IMG_TYPE = /^image\//i;
const EXTRAS_DEFAULT_MAX_CHARS = 20000;
const EXTRAS_DEFAULT_MAX_IMAGES = 4;
const EXTRAS_PREVIEW_CHARS = 60;

function text(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function arrOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function createChatExtras(): ChatExtrasApi {
  /** A file counts as text when its extension matches or its MIME type is `text/*`. */
  function isTextFile(file: FileLike | null | undefined): boolean {
    const f = recOf(file);
    return EXTRAS_TEXT_EXT.test(text(f.name)) || /^text\//.test(text(f.type));
  }

  function isImageFile(file: FileLike | null | undefined): boolean {
    return EXTRAS_IMG_TYPE.test(text(recOf(file).type));
  }

  /**
   * Truncates to the model budget.
   * @returns null when the file was rejected before reading (not text). `chars` is always the original
   * length, so the notice can say how much was dropped.
   */
  function truncateForModel(value: unknown, max?: unknown): AttachResult | null {
    const f = recOf(value);
    if (!isTextFile(f)) return null;
    const limit = typeof max === "number" && max > 0 ? max : EXTRAS_DEFAULT_MAX_CHARS;
    const raw = text(f.text);
    const chars = raw.length;
    const truncated = chars > limit;
    return { name: text(f.name), text: truncated ? raw.slice(0, limit) : raw, chars: chars, truncated: truncated };
  }

  /**
   * How many more images fit.
   * @returns `take` (0 when full) and whether anything had to be dropped — the caller turns `overflow`
   * into a message naming the cap.
   */
  function imageRoom(usedImages: unknown, max?: unknown): { take: number; overflow: boolean } {
    const cap = typeof max === "number" && max > 0 ? max : EXTRAS_DEFAULT_MAX_IMAGES;
    const used = typeof usedImages === "number" && isFinite(usedImages) ? usedImages : 0;
    const room = Math.max(0, cap - used);
    return { take: room, overflow: room <= 0 };
  }

  /**
   * A one-line preview of a message list: the **last** non-empty content, cut short.
   * The first message is usually the same greeting on both sides of a conflict, so it says nothing.
   */
  function previewOf(msgs: unknown): string {
    const list = arrOf(msgs);
    if (!list.length) return "(空)";
    for (let i = list.length - 1; i >= 0; i--) {
      const m = recOf(list[i]);
      if (typeof m.content === "string" && m.content.trim()) return m.content.trim().slice(0, EXTRAS_PREVIEW_CHARS);
    }
    return "(" + list.length + " 条)";
  }

  /** The conversation's metadata record, or null when the slot is not in the registry. */
  function convMetaOf(raw: unknown, slotKey: unknown): ConflictMeta | null {
    try {
      const m = recOf(typeof raw === "string" ? JSON.parse(raw) : raw);
      const key = text(slotKey);
      if (!key || !m[key]) return null;
      return recOf(m[key]);
    } catch (e) {
      return null;
    }
  }

  /** A readable name for a slot; a slot missing from the registry still gets a label, not a bare id. */
  function slotLabel(raw: unknown, slotKey: unknown): string {
    const m = convMetaOf(raw, slotKey);
    return m && m.name ? text(m.name) : "未命名会话";
  }

  return {
    isTextFile: isTextFile,
    isImageFile: isImageFile,
    truncateForModel: truncateForModel,
    imageRoom: imageRoom,
    previewOf: previewOf,
    convMetaOf: convMetaOf,
    slotLabel: slotLabel,
  };
}
