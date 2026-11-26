/**
 * How a reply becomes something worth reading aloud.
 *
 * Three steps, in this order, and the order is the whole point:
 *   1. `stripVoiceTags` removes `[情绪:开心]`-shaped tags. The `speak` tool used to read them out loud.
 *   2. `cleanForSpeech` removes parentheticals and emphasis markers — stage directions, not speech.
 *   3. `splitSentences` cuts at sentence ends so each sentence can be synthesised separately.
 *
 * `||` counts as a sentence break. WeChat's "split into several bubbles" mode uses it as a separator;
 * after switching back to normal output the model sometimes still emits it, and treating it as a break
 * both avoids reading a vertical bar aloud and avoids reading the whole reply as one run-on sentence.
 *
 * A block that is only punctuation is dropped: the synthesiser would otherwise produce a click or an
 * empty clip per stray comma.
 *
 * No ports: this is pure string work, and it is deliberately separate from the service calls so the
 * splitting rules can be exercised without a TTS backend.
 *
 * Lock: `test/tts-text.test.mjs` (written with the migration).
 * @module services/media/tts-text
 */

/**
 * `[name:value]` with a short name and a short value — the voice-tag shape. The character class
 * excludes `:`/`：` from the name and digits/commas from it, so a timestamp or a list is not eaten.
 */
const VOICE_TAG_RE = /\[\s*[^\[\]:：\d,，\n]{1,8}\s*[:：]\s*[^\[\]\n]{0,12}\s*\]/g;

function text(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

/** True when the string contains at least one voice tag. */
export function hasVoiceTag(value: unknown): boolean {
  VOICE_TAG_RE.lastIndex = 0;
  return VOICE_TAG_RE.test(text(value));
}

/** Removes voice tags and collapses the gaps they leave. */
export function stripVoiceTags(value: unknown): string {
  return text(value).replace(VOICE_TAG_RE, "").replace(/[ \t]{2,}/g, " ").trim();
}

/** Strips tags, then parentheticals (`（）`, `()`, `【】`) and `*emphasis*`, then collapses whitespace. */
export function cleanForSpeech(value: unknown): string {
  const withoutTags = stripVoiceTags(value);
  return withoutTags
    .replace(/（[^（）]*）/g, " ")
    .replace(/\([^()]*\)/g, " ")
    .replace(/【[^【】]*】/g, " ")
    .replace(/\*+([^*]+)\*+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits into sentences at `。！？!?…` and newlines, treating `||` as a break too.
 * @returns trimmed, non-empty pieces that contain at least one CJK character, letter or digit —
 * punctuation-only fragments are dropped rather than sent to the synthesiser.
 */
export function splitSentences(value: unknown): string[] {
  return text(value)
    .replace(/\s*\|+\s*/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split(/(?<=[。！？!?…\n])/)
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return !!s && /[\u4e00-\u9fa5A-Za-z0-9]/.test(s);
    });
}

export interface TtsTextApi {
  hasVoiceTag(value: unknown): boolean;
  stripVoiceTags(value: unknown): string;
  cleanForSpeech(value: unknown): string;
  splitSentences(value: unknown): string[];
}

export function createTtsText(): TtsTextApi {
  return {
    hasVoiceTag: hasVoiceTag,
    stripVoiceTags: stripVoiceTags,
    cleanForSpeech: cleanForSpeech,
    splitSentences: splitSentences,
  };
}
