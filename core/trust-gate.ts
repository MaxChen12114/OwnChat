// core/trust-gate.ts — admission gate for externally sourced bundles: pure verdict functions,
// no loader, no signature verification, no window access.
//
// Why a single gate: once bundles can come from outside the repo, "may this load and what may it
// touch" must be decided in exactly one place. Scattered checks fail silently — a wrong verdict
// never turns red, it just quietly grants one permission too many.
//
// Scope boundary (this is a contract skeleton, not wired admission):
//   · Types, one error-code table, one pure function. No loader, no file IO, no verification.
//     Every environment fact (capability universe, slot specs, builtin whitelist) is injected by
//     the caller via TrustContext; an empty universe means reject-everything — fail-closed by
//     design, not a bug.
//   · No signature verification: there is no key infrastructure in this repo, and a signature
//     check that only pretends to verify is worse than none. The `signed` tier is therefore
//     always rejected (TRUST_UNVERIFIED) until a real verifier exists.
//   · Zero runtime imports (`import type` only): the gate never holds a second copy of the
//     capability or slot lists.
//   · No loose escapes by the usual rules (no any / no assertions / no suppression comments).
//
// Deliberately NOT shared with the other two security filters (workflow-schema, zip-read,
// skills-import): a skill package must NOT contain code (it rejects .js entries), while a bundle
// IS code (it must ship entry.js/mjs). The admission directions are opposite, which is exactly
// why one shared gate would be wrong.
//
// The manifest carries a 7th required field `format` beyond the original six: classic scripts
// loaded as modules (or the reverse) die with a SyntaxError + white screen, a symptom that does
// not point at format at all. Failing at admission is cheaper than failing at runtime.
//
// Exit criteria: 30 days without change; and every bundle load in L3 must pass through the single
// `allow === true` verdict here.
//
// @module core/trust-gate

import type { CapabilityStatus } from "./capability";
import type { SlotId, SlotSpec } from "./slot-registry";

// Manifest shape (v0; the fields are the contract).

/** Trust source declaration. Note: this is a *claim*, not evidence — the gate never takes it at
 *  face value (see gate 4). */
export type BundleTrustLevel = "core" | "signed" | "unsigned";

/** Load mode. classic = plain script, module = type="module"; the two are incompatible. */
export type BundleEntryFormat = "module" | "classic";

/**
 * Manifest v0. `capabilities` / `slots` are *requests*, not grants — the grant result lives only
 * in `TrustVerdict.grants`, and any failed gate rejects the whole bundle. No partial grants: a
 * half-capability set makes tools silently missing, which shows up as "this feature sometimes
 * works" and is far harder to debug than a clean rejection.
 */
export interface BundleManifest {
  /** Bundle identity; also the key the builtin whitelist matches (the core tier only knows it). */
  readonly id: string;
  /** Semantic three-part version, e.g. `0.1.0`. */
  readonly version: string;
  /** Entry script path relative to the bundle root, e.g. `shell/mobile-entry.js`; no absolute
   *  paths / `..` / drive letters / NUL. */
  readonly entry: string;
  readonly format: BundleEntryFormat;
  readonly capabilities: readonly string[];
  readonly slots: readonly string[];
  readonly trust: BundleTrustLevel;
}

/** Required fields, in report order (stable order so tests can pin each one). */
export const BUNDLE_MANIFEST_REQUIRED_FIELDS: readonly string[] = [
  "id",
  "version",
  "entry",
  "format",
  "capabilities",
  "slots",
  "trust",
];

export const BUNDLE_TRUST_LEVELS: readonly BundleTrustLevel[] = ["core", "signed", "unsigned"];
export const BUNDLE_ENTRY_FORMATS: readonly BundleEntryFormat[] = ["module", "classic"];

/**
 * Admission error codes. The string values are the contract: UI and logs use them verbatim, so
 * changing one is a contract change. Prefix classes: BAD_* shape / UNKNOWN_* out of universe /
 * MISSING_* undeclared / TRUST_* source tier.
 */
export type BundleIssueCode =
  | "BAD_ROOT"
  | "UNKNOWN_FIELD"
  | "MISSING_FIELD"
  | "MISSING_CAPABILITY_UNIVERSE"
  | "BAD_ID"
  | "BAD_VERSION"
  | "BAD_ENTRY"
  | "BAD_FORMAT"
  | "BAD_CAPABILITIES"
  | "BAD_CAPABILITY_SOURCE"
  | "BAD_SLOTS"
  | "UNKNOWN_CAPABILITY"
  | "UNKNOWN_SLOT"
  | "DUPLICATE_CAPABILITY"
  | "DUPLICATE_CAPABILITY_SOURCE"
  | "DUPLICATE_SLOT"
  | "BAD_TRUST"
  | "TRUST_UNVERIFIED"
  | "TRUST_UNSIGNED"
  | "TRUST_NOT_BUILTIN"
  | "CAPABILITY_NOT_READY"
  | "SLOT_OWNED_BY_INDEX";

/** One verdict opinion. Shape follows the workflow-schema error item so UI and logs need no
 *  second translation layer. */
export interface BundleIssue {
  readonly code: BundleIssueCode;
  /** Field path of the problem, e.g. `capabilities[2]`. */
  readonly field: string;
  readonly message: string;
}

/** The grant sheet. Empty = nothing granted (the only legal value when rejecting). */
export interface BundleGrants {
  readonly capabilities: readonly string[];
  readonly slots: readonly SlotId[];
}

export interface TrustVerdict {
  readonly allow: boolean;
  readonly grants: BundleGrants;
  readonly errors: readonly BundleIssue[];
  readonly warnings: readonly BundleIssue[];
}

/**
 * The external world the verdict needs, fully injected — the gate invents no lists of its own.
 * `capabilities` is the L1c status list (not a snapshot: the gate must distinguish "no such
 * capability" from "present but not ready").
 * `capabilityIds` is the *authorization universe* (in practice L1c's `CAPABILITY_IDS`) — the
 * ruler used to check that every injected status id actually exists; a missing declaration
 * rejects the bundle (gate 0).
 * `slots` is L1b's SLOT_SPECS (owner/area needed, not just ids).
 * `builtinIds` is the bundle-id whitelist shipped with the app; absent/empty = everything
 * non-builtin is rejected.
 */
export interface TrustContext {
  readonly capabilities: readonly CapabilityStatus[];
  readonly capabilityIds: readonly string[];
  readonly slots: readonly SlotSpec[];
  readonly builtinIds?: readonly string[];
}

const NO_GRANTS: BundleGrants = { capabilities: [], slots: [] };

// Shape checks — same lineage as zip-read / skills-import, but with the opposite direction: a
// bundle MUST have an executable entry.

/** 1~40 chars, lowercase start, segmented by dot/underscore/hyphen (`shell`, `agent.tools`,
 *  `img-gen` all valid). */
const BUNDLE_ID_RE = /^[a-z][a-z0-9._-]{0,39}$/;
const BUNDLE_VERSION_RE = /^\d+\.\d+\.\d+$/;
/** Entry must be .js / .mjs — the exact opposite of skills-import's executable-extension ban. */
const BUNDLE_ENTRY_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:js|mjs)$/;

/**
 * Entry path safety, aligned rule-by-rule with zip-read.safeName / skills-import.safePath:
 * relative, no backslash, no `..` segment, no empty segment, no drive letter, no NUL.
 * One extra rule: a `//` segment (`a//b.js` parses as host-absolute in some resolvers).
 */
function isSafeEntryPath(raw: string): boolean {
  const p = raw;
  if (!p) return false;
  if (p.indexOf("\0") >= 0) return false;
  if (p.charAt(0) === "/") return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p.indexOf("\\") >= 0) return false;
  const parts = p.split("/");
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is readonly string[] {
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i++) if (typeof v[i] !== "string") return false;
  return true;
}

function issue(code: BundleIssueCode, field: string, message: string): BundleIssue {
  return { code: code, field: field, message: message };
}

// Gate 0: the authorization universe. The ruler is checked before the thing being measured.
//
// Why the gate validates the *injected* capability statuses, not just the bundle's request: gate
// 3 decides "known / unknown capability" using ctx.capabilities as the universe. If that
// injection itself is polluted:
//   · an id the app never had → treated as known and granted; the bundle gets a capability the
//     host can never satisfy;
//   · the same id twice → which entry wins depends on array order, making the grant
//     nondeterministic — and nondeterminism in a security decision equals unauditability.
// Neither failure throws; both just quietly over-grant. So the ruler must prove itself first:
// ids inside the caller-declared capabilityIds, no duplicates, state one of the three legal
// values. Any violation rejects the whole bundle (not just that one entry): when the ruler is
// untrustworthy, "which capabilities are legal" fails as a whole, and dropping one entry would
// leave the illusion of a half-valid grant.

function checkCapabilityUniverse(ctx: TrustContext): BundleIssue[] {
  const out: BundleIssue[] = [];
  const universe = ctx.capabilityIds;
  if (universe === undefined) {
    // Required by types, but ctx comes from runtime (the L3 loader may be plain JS) — absence
    // must reject, never degrade into "skip the check", or this gate becomes bypassable decor.
    out.push(issue("MISSING_CAPABILITY_UNIVERSE", "ctx.capabilityIds",
      "未声明授权宇宙，无法核对注入的能力位，整包拒（应传 L1c 的 CAPABILITY_IDS）"));
    return out;
  }
  const seen: string[] = [];
  for (let i = 0; i < ctx.capabilities.length; i++) {
    const status = ctx.capabilities[i];
    const id = status.id;
    // Emptiness via length, not `id === ""`: CapabilityId is a literal union without the empty
    // string, so TS2367 would flag that comparison as a typo — while the runtime value this line
    // guards against is exactly the empty string.
    if (typeof id !== "string" || id.length === 0) {
      out.push(issue("BAD_CAPABILITY_SOURCE", "ctx.capabilities[" + i + "]", "注入的能力位 id 必须是非空字符串"));
      continue;
    }
    if (seen.indexOf(id) >= 0) {
      out.push(issue("DUPLICATE_CAPABILITY_SOURCE", "ctx.capabilities[" + i + "]", "同一能力位被注入两次: " + id + "（授权会取决于数组顺序）"));
      continue;
    }
    seen.push(id);
    // The core of gate 0: an injected id must be inside the universe the caller declared.
    if (universe.indexOf(id) < 0) {
      out.push(issue("BAD_CAPABILITY_SOURCE", "ctx.capabilities[" + i + "]", "注入的能力位不在授权宇宙内: " + id));
    }
    if (status.state !== "ready" && status.state !== "off-user" && status.state !== "off-env") {
      out.push(issue("BAD_CAPABILITY_SOURCE", "ctx.capabilities[" + i + "]", "能力位状态非法: " + String(status.state)));
    }
  }
  return out;
}

// Admission pipeline. Order is fixed: gate 0 universe → shape → identity → grants → source →
// grant sheet.
//
// Why the order cannot change: each later gate relies on shapes already narrowed by the earlier
// ones. Checking trust before structure means deciding *whether* to validate using an unvalidated
// `trust` — the canonical bypassable pattern. Gate 0 runs first because it validates not the
// manifest but the ruler the other gates measure with.
// Gates 1–3 collect all errors (fix every field in one pass); gate 4 only makes sense once 1–3
// are clean (checking a whitelist with a dirty id produces a fake rejection reason). Any gate-0
// error returns immediately: with a broken ruler, per-item errors are all false conclusions.

export function evaluateBundle(input: unknown, ctx: TrustContext): TrustVerdict {
  const errors: BundleIssue[] = [];
  const warnings: BundleIssue[] = [];

  // ── Gate 0: authorization universe (self-check of the ruler; runs before everything because
  // every later gate's "known / unknown" is measured with it) ──
  const universeErrors = checkCapabilityUniverse(ctx);
  if (universeErrors.length > 0) {
    return {
      allow: false,
      grants: NO_GRANTS,
      errors: universeErrors,
      warnings: warnings,
    };
  }

  // ── Gate 1: shape ──
  if (!isRecord(input)) {
    return {
      allow: false,
      grants: NO_GRANTS,
      errors: [issue("BAD_ROOT", "", "manifest 必须是对象")],
      warnings: warnings,
    };
  }
  const raw = input;
  const declared = Object.keys(raw);
  for (let i = 0; i < declared.length; i++) {
    const key = declared[i];
    if (BUNDLE_MANIFEST_REQUIRED_FIELDS.indexOf(key) >= 0) continue;
    // Unknown fields must reject, not be ignored: a silently ignored typo like `capabilites`
    // lets the bundle pass admission with zero requests while its author believes the wanted
    // permissions are declared — the symptom is features that work only sometimes.
    errors.push(issue("UNKNOWN_FIELD", key, "未知字段: " + key + "（拼写错误会被静默忽略，故直接拒）"));
  }
  for (let i = 0; i < BUNDLE_MANIFEST_REQUIRED_FIELDS.length; i++) {
    const key = BUNDLE_MANIFEST_REQUIRED_FIELDS[i];
    if (raw[key] === undefined) errors.push(issue("MISSING_FIELD", key, "缺少必填字段: " + key));
  }

  // ── Gate 2: identity (id / version / entry / format) ──
  const idValue = raw["id"];
  if (idValue !== undefined) {
    if (typeof idValue !== "string" || !BUNDLE_ID_RE.test(idValue)) {
      errors.push(issue("BAD_ID", "id", "id 必须是 1~40 位小写字母开头的 [a-z0-9._-]"));
    }
  }
  const versionValue = raw["version"];
  if (versionValue !== undefined) {
    if (typeof versionValue !== "string" || !BUNDLE_VERSION_RE.test(versionValue)) {
      errors.push(issue("BAD_VERSION", "version", "version 必须是 x.y.z 三段数字"));
    }
  }
  const entryValue = raw["entry"];
  if (entryValue !== undefined) {
    if (typeof entryValue !== "string" || !BUNDLE_ENTRY_RE.test(entryValue) || !isSafeEntryPath(entryValue)) {
      errors.push(issue("BAD_ENTRY", "entry", "entry 必须是包内相对路径且以 .js/.mjs 结尾"));
    }
  }
  // Tier check without a type assertion: `as` would count against the escape ratchet, and plain
  // value comparison is all that is needed — the enum tables exist for external declaration only.
  const formatValue = raw["format"];
  if (formatValue !== undefined) {
    if (formatValue !== "module" && formatValue !== "classic") {
      errors.push(issue("BAD_FORMAT", "format", "format 必须是 module / classic"));
    }
  }
  const trustValue = raw["trust"];
  if (trustValue !== undefined) {
    if (trustValue !== "core" && trustValue !== "signed" && trustValue !== "unsigned") {
      errors.push(issue("BAD_TRUST", "trust", "trust 必须是 core / signed / unsigned"));
    }
  }

  // ── Gate 3: grants (every requested capability / slot must be known, no duplicates) ──
  const capabilityGrants: string[] = [];
  const capsValue = raw["capabilities"];
  if (capsValue !== undefined) {
    if (!isStringArray(capsValue)) {
      errors.push(issue("BAD_CAPABILITIES", "capabilities", "capabilities 必须是字符串数组"));
    } else {
      const seen: string[] = [];
      for (let i = 0; i < capsValue.length; i++) {
        const name = capsValue[i];
        if (seen.indexOf(name) >= 0) {
          errors.push(issue("DUPLICATE_CAPABILITY", "capabilities[" + i + "]", "能力位重复申请: " + name));
          continue;
        }
        seen.push(name);
        let known = false;
        for (let j = 0; j < ctx.capabilities.length; j++) {
          const status = ctx.capabilities[j];
          if (status.id !== name) continue;
          known = true;
          capabilityGrants.push(status.id);
          // Admission and readiness are decoupled: whitelisted means granted; an environment that
          // is not ready is folded away by policy at the tool layer. Otherwise "the remote PC is
          // off today" would turn into "this bundle is permanently broken".
          if (status.state !== "ready") {
            warnings.push(issue("CAPABILITY_NOT_READY", "capabilities[" + i + "]", "能力位当前未就绪: " + name + "（" + status.state + "）"));
          }
          break;
        }
        if (!known) {
          // Whole-bundle rejection, not dropping one entry — see the BundleManifest note
          // (a half-granted set is harder to debug than a clean rejection).
          errors.push(issue("UNKNOWN_CAPABILITY", "capabilities[" + i + "]", "未知能力位: " + name));
        }
      }
    }
  }

  const slotGrants: SlotId[] = [];
  const slotsValue = raw["slots"];
  if (slotsValue !== undefined) {
    if (!isStringArray(slotsValue)) {
      errors.push(issue("BAD_SLOTS", "slots", "slots 必须是字符串数组"));
    } else {
      const seenSlots: string[] = [];
      for (let i = 0; i < slotsValue.length; i++) {
        const name = slotsValue[i];
        if (seenSlots.indexOf(name) >= 0) {
          errors.push(issue("DUPLICATE_SLOT", "slots[" + i + "]", "槽位重复申请: " + name));
          continue;
        }
        seenSlots.push(name);
        let known = false;
        for (let j = 0; j < ctx.slots.length; j++) {
          const spec = ctx.slots[j];
          if (spec.id !== name) continue;
          known = true;
          slotGrants.push(spec.id);
          // index-inline slots get their content from inline scripts in index.html today
          // (agentConsoleSlot / fishbowlSlot and friends). A bundle mounting there would
          // double-mount, and until L0a lands the inline script writes the same node.
          if (spec.owner === "index-inline") {
            warnings.push(issue("SLOT_OWNED_BY_INDEX", "slots[" + i + "]", "槽位现由 index.html 内联脚本持有，抢挂会双挂: " + name));
          }
          break;
        }
        if (!known) {
          errors.push(issue("UNKNOWN_SLOT", "slots[" + i + "]", "未知槽位: " + name));
        }
      }
    }
  }

  // ── Gate 4: source (whitelist only; the trust claim is never taken at face value) ──
  // Skipped while gates 1–3 have errors: checking the whitelist with a dirty id yields a fake
  // "not builtin" reason that misleads debugging.
  if (errors.length === 0 && typeof trustValue === "string") {
    const level = trustValue;
    if (level === "core") {
      const builtin = ctx.builtinIds === undefined ? [] : ctx.builtinIds;
      let listed = false;
      for (let i = 0; i < builtin.length; i++) {
        if (builtin[i] === idValue) { listed = true; break; }
      }
      if (!listed) {
        errors.push(issue("TRUST_NOT_BUILTIN", "trust", "声明 core 但不在内置白名单: " + String(idValue) + "（声明不是证据）"));
      }
    } else if (level === "signed") {
      errors.push(issue("TRUST_UNVERIFIED", "trust", "本阶段无签名验证器，signed 一律拒（等 L3）"));
    } else if (level === "unsigned") {
      errors.push(issue("TRUST_UNSIGNED", "trust", "未签名 bundle 不予准入"));
    }
  }

  // ── Gate 5: grant sheet ──
  const allow = errors.length === 0;
  return {
    allow: allow,
    // Rejected bundles always get empty grants: with even one error, no partial capability goes
    // out (avoiding the "rejected but the card still mounted" illusion).
    grants: allow ? { capabilities: capabilityGrants, slots: slotGrants } : NO_GRANTS,
    errors: errors,
    warnings: warnings,
  };
}

// Tool prerequisite validation (§5.3 decision a).
//
// `requires` holds *tool prerequisites* (workspace / network / pcToken); host toggles like
// unlocked / pcEnabled may appear in requires as usage conditions. This is a different taxonomy
// from the bundle's capabilities (host grants):
//   · a missing capability → whole-bundle rejection (the five gates above);
//   · an unknown/duplicate requires entry → only that tool is rejected; the bundle is still
//     admitted (tool-level fail-closed).
// The two taxonomies must stay separate: "the network is down" must kill the networked tool, not
// the whole bundle. Mixing the semantics pollutes host toggles and prerequisites with each other.
// Readiness (is the network up, is the token present) is judged at runtime by the capability
// provider, not in the gate; the gate only checks that a name is in the known prerequisite list
// or the injected universe — an unknown name is a declaration error, rejected rather than
// silently ignored.

/** Known *non-toggle* prerequisites. Host toggles (unlocked/pcEnabled etc.) are not listed here —
 *  they are validated against the injected capability universe (same discipline as gate 0: the
 *  ruler only ever comes from injection; the gate keeps no second copy). Adding a prerequisite =
 *  change this list plus pin it in tests. */
export const TOOL_PREREQUISITE_IDS: readonly string[] = [
  "workspace",
  "network",
  "pcToken",
];

export interface ToolPrereqEntry {
  readonly id: string;
  readonly requires?: readonly string[];
}

/** Injected universe: the caller passes the full capability id set (L1c's CAPABILITY_IDS); the
 *  gate ships no list of its own. */
export interface ToolPrereqContext {
  readonly capabilityIds: readonly string[];
}

export type ToolPrereqIssueCode = "BAD_TOOL_ID" | "UNKNOWN_PREREQUISITE" | "DUPLICATE_PREREQUISITE";

export interface ToolPrereqIssue {
  readonly code: ToolPrereqIssueCode;
  readonly id: string;
  readonly field: string;
  readonly message: string;
}

export interface ToolPrereqVerdict {
  readonly ok: boolean;
  /** Rejected tool ids (tool-level fail-closed: only the bad ones, never the whole bundle). */
  readonly rejected: readonly string[];
  readonly issues: readonly ToolPrereqIssue[];
}

/** Per-tool prerequisite check: bad tools land in rejected, good ones are unaffected. A requires
 *  entry is legal when it is in the prerequisite list OR in the injected capability universe
 *  (a host toggle may double as a prerequisite); anything else is a declaration error and rejects
 *  that tool. */
export function validateToolPrerequisites(entries: readonly ToolPrereqEntry[], ctx: ToolPrereqContext): ToolPrereqVerdict {
  const issues: ToolPrereqIssue[] = [];
  const rejected: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const id = e && typeof e.id === "string" ? e.id : "";
    if (!id) {
      issues.push({ code: "BAD_TOOL_ID", id: "", field: "entries[" + i + "].id", message: "工具缺 id（无法定位，整条拒绝）" });
      rejected.push("");
      continue;
    }
    const seen: Record<string, boolean> = {};
    const requires = e.requires;
    if (requires === undefined || requires === null) continue;
    if (!Array.isArray(requires)) {
      issues.push({ code: "BAD_TOOL_ID", id: id, field: "entries[" + i + "].requires", message: "requires 应为数组" });
      rejected.push(id);
      continue;
    }
    let bad = false;
    for (let r = 0; r < requires.length; r++) {
      const name = requires[r];
      const inPrereq = typeof name === "string" && TOOL_PREREQUISITE_IDS.indexOf(name) >= 0;
      const inUniverse = !inPrereq && typeof name === "string" && ctx.capabilityIds.indexOf(name) >= 0;
      if (typeof name !== "string" || (!inPrereq && !inUniverse)) {
        issues.push({ code: "UNKNOWN_PREREQUISITE", id: id, field: "entries[" + i + "].requires[" + r + "]", message: "未知先决条件：" + String(name) + "（先决清单：" + TOOL_PREREQUISITE_IDS.join(",") + "；能力位须在注入宇宙内）" });
        bad = true;
        continue;
      }
      if (seen[name]) {
        issues.push({ code: "DUPLICATE_PREREQUISITE", id: id, field: "entries[" + i + "].requires[" + r + "]", message: "重复先决条件：" + name });
        bad = true;
      }
      seen[name] = true;
    }
    if (bad) rejected.push(id);
  }
  return { ok: rejected.length === 0, rejected: rejected, issues: issues };
}
