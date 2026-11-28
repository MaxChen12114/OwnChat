/**
 * Structural parsing and phase ordering for model-authored intents.
 *
 * The parser is the boundary between untrusted JSON and the engine's typed intent union: it checks
 * shape, faction membership, text/ref types and number ranges, but never gameplay validity (that is
 * the tick's job). Keeping the phase table here means the orchestrator cannot accidentally sort a
 * declaration before the council speech that justified it.
 *
 * @module services/civ/intent
 */

import type { CivWorld, ProposalTerm, StateApi, SubmitResult, IntentApi } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(value)) return out;
  for (const key of Object.keys(value)) out[key] = Reflect.get(value, key);
  return out;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
  }
  return out;
}

function parseTerms(raw: unknown): { ok: boolean; error: string; terms: ProposalTerm[] } {
  if (raw === undefined || raw === null) return { ok: true, error: "", terms: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "terms 必须是数组", terms: [] };
  const terms: ProposalTerm[] = [];
  for (const item of raw) {
    const rec = recOf(item);
    const id = textOf(rec.id).trim();
    if (id === "") return { ok: false, error: "条款缺少 id", terms: [] };
    let params: Record<string, number | string> | undefined = undefined;
    if (rec.params !== undefined && rec.params !== null) {
      if (!isRecord(rec.params)) return { ok: false, error: "条款 " + id + " 的 params 必须是对象", terms: [] };
      const copy: Record<string, number | string> = {};
      const paramsRec = recOf(rec.params);
      for (const key of Object.keys(paramsRec)) {
        const value = paramsRec[key];
        if (typeof value !== "number" && typeof value !== "string") {
          return { ok: false, error: "条款 " + id + " 的参数 " + key + " 必须是数字或字符串", terms: [] };
        }
        copy[key] = value;
      }
      params = copy;
    }
    terms.push({ id, params });
  }
  return { ok: true, error: "", terms };
}

function parseRefs(raw: unknown): { ok: boolean; error: string; refs: string[] | undefined } {
  if (raw === undefined || raw === null) return { ok: true, error: "", refs: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: "refs 必须是字符串数组", refs: undefined };
  const refs: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return { ok: false, error: "refs 里每一项都必须是字符串", refs: undefined };
    const ref = item.trim();
    if (ref === "") return { ok: false, error: "refs 不能有空字符串", refs: undefined };
    refs.push(ref);
  }
  return { ok: true, error: "", refs };
}

function parseChannel(raw: unknown): { ok: boolean; error: string; channel: "council" | "envoy" | undefined } {
  if (raw === undefined || raw === null) return { ok: true, error: "", channel: undefined };
  if (raw === "council" || raw === "envoy") return { ok: true, error: "", channel: raw };
  return { ok: false, error: "channel 只能是 council 或 envoy", channel: undefined };
}

function fail(error: string): SubmitResult {
  return { ok: false, error, intent: null };
}

/** Structural parser for model-authored JSON. Gameplay validity is checked when the tick runs. */
function parseIntent(raw: unknown, world: CivWorld, stateApi: StateApi): SubmitResult {
  if (!isRecord(raw)) return fail("intent 必须是 JSON 对象");
  const rec = recOf(raw);
  const type = textOf(rec.type).trim();
  const faction = textOf(rec.faction).trim();
  if (faction === "") return fail("intent 缺少 faction");
  if (stateApi.faction(world, faction) === null) return fail("未知派系: " + faction);
  const refsResult = parseRefs(rec.refs);
  if (!refsResult.ok) return fail(refsResult.error);
  const refs = refsResult.refs;

  if (type === "council_speech") {
    const text = textOf(rec.text).trim();
    if (text === "") return fail("council_speech 需要 text");
    return { ok: true, error: "", intent: { type: "council_speech", faction, text, refs } };
  }
  if (type === "envoy") {
    const to = textOf(rec.to).trim();
    const text = textOf(rec.text).trim();
    if (to === "") return fail("envoy 需要 to");
    if (to === faction) return fail("不能给自己发私信");
    if (text === "") return fail("envoy 需要 text");
    if (stateApi.faction(world, to) === null) return fail("未知收件人: " + to);
    return { ok: true, error: "", intent: { type: "envoy", faction, to, text, refs } };
  }
  if (type === "bloc_create") {
    const name = textOf(rec.name).trim();
    if (name === "") return fail("bloc_create 需要 name");
    return { ok: true, error: "", intent: { type: "bloc_create", faction, name, members: stringArray(rec.members) } };
  }
  if (type === "bloc_invite") {
    const blocId = textOf(rec.blocId).trim();
    if (blocId === "") return fail("bloc_invite 需要 blocId");
    return { ok: true, error: "", intent: { type: "bloc_invite", faction, blocId, members: stringArray(rec.members) } };
  }
  if (type === "bloc_leave") {
    const blocId = textOf(rec.blocId).trim();
    if (blocId === "") return fail("bloc_leave 需要 blocId");
    return { ok: true, error: "", intent: { type: "bloc_leave", faction, blocId } };
  }
  if (type === "bloc_expel") {
    const blocId = textOf(rec.blocId).trim();
    const member = textOf(rec.member).trim();
    if (blocId === "") return fail("bloc_expel 需要 blocId");
    if (member === "") return fail("bloc_expel 需要 member");
    return { ok: true, error: "", intent: { type: "bloc_expel", faction, blocId, member } };
  }
  if (type === "bloc_message") {
    const blocId = textOf(rec.blocId).trim();
    const text = textOf(rec.text).trim();
    if (blocId === "") return fail("bloc_message 需要 blocId");
    if (text === "") return fail("bloc_message 需要 text");
    return { ok: true, error: "", intent: { type: "bloc_message", faction, blocId, text, refs } };
  }
  if (type === "propose" || type === "offer_peace") {
    const to = textOf(rec.to).trim();
    if (to === "") return fail(type + " 需要 to");
    if (to === faction) return fail("不能向自己提案");
    if (stateApi.faction(world, to) === null) return fail("未知提案对象: " + to);
    const termsResult = parseTerms(rec.terms);
    if (!termsResult.ok) return fail(termsResult.error);
    const channelResult = parseChannel(rec.channel);
    if (!channelResult.ok) return fail(channelResult.error);
    const kind = type === "offer_peace" ? "peace" : textOf(rec.kind).trim();
    if (kind === "") return fail("propose 需要 kind");
    if (type === "offer_peace" && termsResult.terms.length === 0) {
      return fail("offer_peace 需要至少一条 terms");
    }
    return {
      ok: true,
      error: "",
      intent: {
        type: type === "offer_peace" ? "offer_peace" : "propose",
        faction,
        to,
        kind,
        terms: termsResult.terms,
        channel: channelResult.channel,
        refs,
      },
    };
  }
  if (type === "respond") {
    const proposalId = textOf(rec.proposalId).trim();
    if (proposalId === "") return fail("respond 需要 proposalId");
    if (typeof rec.accept !== "boolean") return fail("respond 需要布尔 accept");
    const channelResult = parseChannel(rec.channel);
    if (!channelResult.ok) return fail(channelResult.error);
    return {
      ok: true,
      error: "",
      intent: {
        type: "respond",
        faction,
        proposalId,
        accept: rec.accept,
        reason: textOf(rec.reason),
        channel: channelResult.channel,
        refs,
      },
    };
  }
  if (type === "declare_war") {
    const to = textOf(rec.to).trim();
    if (to === "") return fail("declare_war 需要 to");
    if (to === faction) return fail("不能对自己宣战");
    if (stateApi.faction(world, to) === null) return fail("未知宣战对象: " + to);
    const casusBelli = textOf(rec.casusBelli).trim();
    return {
      ok: true,
      error: "",
      intent: { type: "declare_war", faction, to, casusBelli: casusBelli === "" ? undefined : casusBelli, refs },
    };
  }
  if (type === "attack") {
    const to = textOf(rec.to).trim();
    if (to === "") return fail("attack 需要 to");
    if (stateApi.faction(world, to) === null) return fail("未知攻击对象: " + to);
    return { ok: true, error: "", intent: { type: "attack", faction, to } };
  }
  if (type === "recruit") {
    const amount = numOf(rec.amount);
    if (amount === null || !Number.isInteger(amount) || amount <= 0) {
      return fail("recruit 需要正整数 amount");
    }
    return { ok: true, error: "", intent: { type: "recruit", faction, amount } };
  }
  return fail("未知 intent 类型: " + type);
}

function phaseOf(type: string): number {
  if (
    type === "council_speech" ||
    type === "envoy" ||
    type === "bloc_create" ||
    type === "bloc_invite" ||
    type === "bloc_leave" ||
    type === "bloc_expel" ||
    type === "bloc_message"
  ) {
    return 1;
  }
  if (type === "propose" || type === "respond" || type === "offer_peace") return 2;
  if (type === "declare_war" || type === "attack") return 3;
  if (type === "recruit") return 4;
  return 9;
}
export function createIntent(): IntentApi {
  return { parse: parseIntent, phaseOf };
}
