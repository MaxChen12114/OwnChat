/**
 * The choice-chip rules, minus the DOM: the [选项]…[/选项] protocol block parser, the list-bullet
 * stripper, option normalization, and the auto-scan gate.
 *
 * The parser is deliberately indexOf-based, not regex: the delimiters are plain CJK brackets and
 * regex-escaping them was the original bug farm. One block per message — the first recognized
 * opener wins, and text outside it survives verbatim in `clean` so the bubble never shows the
 * protocol tags.
 *
 * `stripBullet` handles what models actually emit inside the block: circled numbers, "1." / "1、"
 * / "1)", dash/bullet markers. It strips one leading marker only — a literal sentence that starts
 * with a dash mid-option stays intact after trim.
 *
 * The scan gate mirrors the 2026-09-10 fix ordering: a streaming tail or an already-processed row
 * skips before parsing, and an empty parse result must NOT mark the row done — the moment a
 * stream just finished is exactly when a half-delivered block gets seen, and marking it done then
 * is what made chips appear intermittently.
 * @module services/ui/choices
 */

/** Recognized openers, in match order. */
export const CH_OPENS = ["[选项]", "[opt]", "[OPT]"];

/** Close tag per opener (mirrors the wiring's original CLOSES table). */
const CH_CLOSES: Record<string, string> = {
  "[选项]": "[/选项]",
  "[opt]": "[/opt]",
  "[OPT]": "[/OPT]",
};

export function chCloseFor(opener: string): string {
  return CH_CLOSES[opener] || "[/OPT]";
}

/** Locate the first [选项]…[/选项] block. Returns null when no opener has a matching closer —
 * an unterminated block stays in the text rather than swallowing the rest of the message. */
export function chFindBlock(
  src: string,
): { close: string; start: number; end: number; inner: string } | null {
  for (const o of CH_OPENS) {
    const start = src.indexOf(o);
    if (start < 0) continue;
    const c = chCloseFor(o);
    const end = src.indexOf(c, start + o.length);
    if (end < 0) continue;
    return { close: c, start, end, inner: src.slice(start + o.length, end) };
  }
  return null;
}

/** Strip one leading list marker (circled digit / "1." / "1、" / "1)" / "- • *") plus whitespace. */
export function chStripBullet(t: string): string {
  if (!t) return "";
  let s = t;
  s = s.replace(/^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]\s*/, "");
  s = s.replace(/^\d+[\.、\)]\s*/, "");
  s = s.replace(/^[-•*]\s*/, "");
  return s.trim();
}

export interface ChParse {
  clean: string;
  options: { label: string }[];
}

/** Parse the protocol block out of a reply: `clean` is the reply without the block (trimmed),
 * `options` one entry per non-empty inner line. No block → clean is the input, options empty. */
export function chParseChoices(text: unknown): ChParse {
  const src = String(text == null ? "" : text);
  const blk = chFindBlock(src);
  if (!blk) return { clean: src, options: [] };
  const options: { label: string }[] = [];
  blk.inner.split("\n").forEach((line) => {
    const t = chStripBullet(line.trim());
    if (t) options.push({ label: t });
  });
  const clean = (src.slice(0, blk.start) + src.slice(blk.end + blk.close.length)).trim();
  return { clean, options };
}

export interface ChOption {
  label: string;
  value: unknown;
}

/** Normalize a caller-supplied options array: plain strings become {label,value} pairs, objects
 * keep their label and fall back to the label when value is missing (non-null values pass
 * through as-is — the wiring sends them verbatim), labelless entries drop. */
export function chNormalize(options: unknown[]): ChOption[] {
  return options
    .map((o) => {
      if (typeof o === "string") return { label: o, value: o };
      const rec: Record<string, unknown> = {};
      if (o && typeof o === "object" && !Array.isArray(o)) {
        for (const [k, x] of Object.entries(o)) rec[k] = x;
      }
      const label = rec["label"];
      return {
        label: typeof label === "string" ? label : "",
        value: rec["value"] != null ? rec["value"] : label,
      };
    })
    .filter((o) => o.label);
}

/** Auto-scan pre-check for the latest AI row: skip when scanning is off, the row is still
 * streaming or was already processed, or the raw text carries no protocol block. The caller must
 * still treat an empty parse as "not done" (no ocDone stamp) per the 2026-09-10 fix. */
export function chScanSkip(
  autoScan: boolean,
  streaming: boolean,
  ocDone: boolean,
  raw: string,
): boolean {
  return !autoScan || streaming || ocDone || !chFindBlock(raw);
}
