/**
 * Cloud speech configuration for the DeepSeek tool API.
 *
 * This module owns only the decisions that must stay identical between the settings card and the
 * playback loop: which localStorage keys hold the switches, the two allowed voices, the text budget
 * and the rule that turns a reply into the chunks sent to /api/tts. It deliberately does not fetch,
 * touch the DOM or play audio — those ports live in the wiring, so this logic can be exercised
 * without a browser or a key.
 *
 * The cloud path is opt-in and device-local. It exists beside the desktop-only GPT-SoVITS path and
 * never silently replaces it: the caller chooses which engine to use before any request is made.
 * @module services/media/cloud-tts
 */

/** Storage keys. Kept in one place so the card and the playback loop cannot drift. */
export const CLOUD_TTS_KEYS: Readonly<Record<"enabled" | "voice", string>> = {
  enabled: "cfw_cloud_tts_enabled_v1",
  voice: "cfw_cloud_tts_voice_v1",
};

/** The only two voices the upstream accepts. */
export const CLOUD_VOICES: readonly string[] = ["stella", "tide"];

/** Characters sent per request. The upstream bills Chinese as two; stay well under its 10k ceiling. */
export const CLOUD_TTS_CHUNK_CHARS = 4000;

export interface CloudTtsPorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CloudTtsConfig {
  readonly enabled: boolean;
  readonly voice: string;
}

export interface CloudTtsApi {
  cfg(): CloudTtsConfig;
  setEnabled(on: boolean): void;
  setVoice(voice: unknown): void;
  /** Splits reply text into upstream-sized chunks without cutting mid-sentence. */
  chunks(text: unknown): string[];
}

function read(port: CloudTtsPorts, key: string): string {
  try {
    const v = port.getItem(key);
    return typeof v === "string" ? v : "";
  } catch (e) { return ""; }
}

function write(port: CloudTtsPorts, key: string, value: string): void {
  try { port.setItem(key, value); } catch (e) {}
}

function isVoice(value: unknown): value is "stella" | "tide" {
  return value === "stella" || value === "tide";
}

/**
 * Split on sentence ends first, then pack sentences into chunks no longer than the budget. A single
 * sentence beyond the budget is hard-cut — the upstream would reject it otherwise.
 */
export function splitChunks(text: unknown, budget: number): string[] {
  const raw = text == null ? "" : typeof text === "string" ? text : String(text);
  const limit = budget > 0 && budget < 20000 ? budget : CLOUD_TTS_CHUNK_CHARS;
  const sentences = raw.replace(/\r/g, "").split(/(?<=[。！？!?…\n])/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && buf.length + s.length > limit) { out.push(buf); buf = ""; }
    if (s.length > limit) {
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit));
      continue;
    }
    buf += s;
  }
  if (buf) out.push(buf);
  return out;
}

export function createCloudTts(port: CloudTtsPorts): CloudTtsApi {
  function cfg(): CloudTtsConfig {
    const storedVoice = read(port, CLOUD_TTS_KEYS.voice);
    return {
      enabled: read(port, CLOUD_TTS_KEYS.enabled) === "1",
      voice: isVoice(storedVoice) ? storedVoice : "stella",
    };
  }
  return {
    cfg: cfg,
    setEnabled: function (on: boolean): void {
      write(port, CLOUD_TTS_KEYS.enabled, on ? "1" : "0");
    },
    setVoice: function (voice: unknown): void {
      write(port, CLOUD_TTS_KEYS.voice, isVoice(voice) ? voice : "stella");
    },
    chunks: function (text: unknown): string[] {
      return splitChunks(text, CLOUD_TTS_CHUNK_CHARS);
    },
  };
}
