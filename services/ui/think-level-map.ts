/**
 * Thinking-effort alias normalisation for the mobile toggle badge. The wiring owns the DOM
 * attributes, localStorage and the MutationObserver.
 *
 * Pattern order is significant: xhigh and max must be tested before high, otherwise "xhigh"
 * resolves to "high". Unknown values return an empty string and MUST NOT produce a badge.
 * @module services/ui/think-level-map
 */

export const TLM_MAP: Record<string, string> = {
  minimal: "minimal", "极低": "minimal",
  low: "low", weak: "low", "低": "low", "弱": "low",
  medium: "medium", mid: "medium", auto: "medium", normal: "medium", "中": "medium", "默认": "medium",
  high: "high", strong: "high", "高": "high", "强": "high",
  xhigh: "xhigh", "更高": "xhigh",
  max: "max", "最高": "max",
};

/** Ordered fallback rules; the first match wins. */
export const TLM_PATTERNS: [string, string][] = [
  ["minimal|极低", "minimal"],
  ["xhigh|extra.?high|更高", "xhigh"],
  ["max|最高", "max"],
  ["low|weak|低|弱", "low"],
  ["medium|mid|auto|normal|中|默认", "medium"],
  ["high|strong|高|强", "high"],
];

/** @returns the first truthy value, or an empty string. */
export function tlmFirstNonEmpty(values: (string | null | undefined)[]): string {
  for (const v of values) if (v) return String(v);
  return "";
}

/** @returns the canonical effort level, or "" when the value is not recognised. */
export function tlmPick(v: unknown): string {
  const s = v ? String(v).trim() : "";
  if (!s) return "";
  if (TLM_MAP[s]) return TLM_MAP[s];
  const l = s.toLowerCase();
  if (TLM_MAP[l]) return TLM_MAP[l];
  for (const [pattern, level] of TLM_PATTERNS) {
    if (new RegExp(pattern).test(l)) return level;
  }
  return "";
}

/** A badge is written only while the toggle is active and the effort is recognised. */
export function tlmShouldBadge(active: boolean, effort: string): boolean {
  return active && !!effort;
}
