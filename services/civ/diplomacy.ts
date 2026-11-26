/**
 * Relations, proposals, treaties, promises and grievances — the binding half of diplomacy.
 *
 * A spoken promise is not a promise here. The only objects that can obligate a faction are
 * {@link Treaty} records with a kind, parties, obligations and an expiry; a council speech or a
 * private envoy line is stored by `channels` and never parsed for commitments. That is deliberate:
 * an LLM can say anything, but only a registered proposal + explicit acceptance can move numbers.
 *
 * Relation status is derived from active treaties, not set by prose:
 *   contact -> negotiating -> treaty / alliance -> war -> ceasefire -> peace
 * A breach marks the treaty `breached`, creates a grievance for every other signatory, and reports
 * the reputation penalty for the orchestrator to apply.
 *
 * @module services/civ/diplomacy
 */

import type {
  BreachResult,
  DiplomacyApi,
  DiplomacyPorts,
  DiplomacyRules,
  DiplomacyState,
  ExpireResult,
  FactionId,
  Grievance,
  GrievanceInput,
  Proposal,
  ProposalInput,
  ProposalKindRule,
  ProposalResult,
  ProposalTerm,
  Relation,
  RelationStatus,
  RespondInput,
  ResponseResult,
  SignTreatyInput,
  Treaty,
  TreatyKindRule,
  TreatyResult,
} from "./types";

const SEP = "\u001f";

function pairOf(a: FactionId, b: FactionId): { a: FactionId; b: FactionId } {
  return a <= b ? { a, b } : { a: b, b: a };
}

function pairKey(a: FactionId, b: FactionId): string {
  const pair = pairOf(a, b);
  return "r:" + pair.a + SEP + pair.b;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

function copyTerms(terms: ProposalTerm[] | undefined): ProposalTerm[] {
  const out: ProposalTerm[] = [];
  if (!terms) return out;
  for (const term of terms) {
    const params: Record<string, number | string> = {};
    if (term.params) {
      for (const key of Object.keys(term.params)) params[key] = term.params[key];
    }
    out.push({ id: term.id, params: Object.keys(params).length > 0 ? params : undefined });
  }
  return out;
}

function validateTerms(terms: ProposalTerm[]): string {
  if (terms.length > 12) return "条款过多（最多 12 条）";
  for (const term of terms) {
    if (!term || typeof term.id !== "string" || term.id.trim() === "") return "条款缺少 id";
    if (term.params) {
      for (const key of Object.keys(term.params)) {
        const value = term.params[key];
        if (typeof value !== "number" && typeof value !== "string") {
          return "条款 " + term.id + " 的参数 " + key + " 必须是数字或字符串";
        }
      }
    }
  }
  return "";
}

function findProposalKind(rules: DiplomacyRules, id: string): ProposalKindRule | null {
  for (const rule of rules.proposalKinds) if (rule.id === id) return rule;
  return null;
}

function findTreatyKind(rules: DiplomacyRules, id: string): TreatyKindRule | null {
  for (const rule of rules.treatyKinds) if (rule.id === id) return rule;
  return null;
}

function statusRank(status: "treaty" | "alliance" | "peace"): number {
  if (status === "alliance") return 3;
  if (status === "peace") return 2;
  return 1;
}

export function createDiplomacy(rules: DiplomacyRules, ports: DiplomacyPorts): DiplomacyApi {
  const exists = ports.exists;

  function createState(): DiplomacyState {
    return {
      relations: {},
      proposals: [],
      treaties: [],
      grievances: [],
      nextProposalId: 0,
      nextTreatyId: 0,
      nextGrievanceId: 0,
    };
  }

  function ensure(state: DiplomacyState, a: FactionId, b: FactionId, tick: number): Relation {
    if (a === b) throw new Error("关系两端不能是同一派系: " + a);
    const key = pairKey(a, b);
    const found = state.relations[key];
    if (found !== undefined) return found;
    const pair = pairOf(a, b);
    const relation: Relation = {
      a: pair.a,
      b: pair.b,
      status: "contact",
      trust: 0,
      sinceTick: tick,
      lastContactTick: tick,
      ceasefireUntil: null,
    };
    state.relations[key] = relation;
    return relation;
  }

  function relation(state: DiplomacyState, a: FactionId, b: FactionId): Relation | null {
    const found = state.relations[pairKey(a, b)];
    return found === undefined ? null : found;
  }

  function status(state: DiplomacyState, a: FactionId, b: FactionId): RelationStatus {
    const found = relation(state, a, b);
    return found === null ? "contact" : found.status;
  }

  function contact(state: DiplomacyState, a: FactionId, b: FactionId, tick: number): Relation {
    const rel = ensure(state, a, b, tick);
    rel.lastContactTick = tick;
    return rel;
  }

  function setStatus(rel: Relation, next: RelationStatus, tick: number): void {
    if (rel.status === next) return;
    rel.status = next;
    rel.sinceTick = tick;
  }

  function refreshRelation(state: DiplomacyState, rel: Relation, tick: number): void {
    if (rel.status === "war" || rel.status === "ceasefire") return;
    let best: "treaty" | "alliance" | "peace" | null = null;
    let bestRank = 0;
    for (const treaty of state.treaties) {
      if (treaty.status !== "active") continue;
      if (treaty.parties.indexOf(rel.a) < 0 || treaty.parties.indexOf(rel.b) < 0) continue;
      const rule = findTreatyKind(rules, treaty.kind);
      if (rule === null) continue;
      const rank = statusRank(rule.status);
      if (rank > bestRank) {
        bestRank = rank;
        best = rule.status;
      }
    }
    if (best !== null) {
      setStatus(rel, best, tick);
      return;
    }
    let pending = false;
    for (const proposal of state.proposals) {
      if (proposal.status !== "pending") continue;
      const touches =
        (proposal.from === rel.a && proposal.to === rel.b) ||
        (proposal.from === rel.b && proposal.to === rel.a);
      if (touches) {
        pending = true;
        break;
      }
    }
    setStatus(rel, pending ? "negotiating" : "contact", tick);
  }

  function propose(state: DiplomacyState, input: ProposalInput, tick: number): ProposalResult {
    if (typeof input.from !== "string" || typeof input.to !== "string") {
      return { ok: false, error: "from/to 必须是派系 id", proposal: null };
    }
    if (input.from === input.to) return { ok: false, error: "不能向自己提案", proposal: null };
    if (!exists(input.from) || !exists(input.to)) {
      return { ok: false, error: "提案方或对方不是已知派系", proposal: null };
    }
    const kind = findProposalKind(rules, input.kind);
    if (kind === null) return { ok: false, error: "未知提案类型: " + input.kind, proposal: null };
    const terms = copyTerms(input.terms);
    const termError = validateTerms(terms);
    if (termError) return { ok: false, error: termError, proposal: null };
    if (kind.requiresTerms && terms.length === 0) {
      return { ok: false, error: kind.label + " 需要至少一条条款", proposal: null };
    }
    const current = status(state, input.from, input.to);
    if (kind.requiresWar && current !== "war" && current !== "ceasefire") {
      return { ok: false, error: kind.label + " 只能在战争或停火状态提出", proposal: null };
    }
    if (kind.allowedStatus.indexOf(current) < 0) {
      return {
        ok: false,
        error: "当前关系 " + current + " 不允许提出 " + kind.label,
        proposal: null,
      };
    }
    for (const existing of state.proposals) {
      if (
        existing.status === "pending" &&
        existing.from === input.from &&
        existing.to === input.to &&
        existing.kind === input.kind
      ) {
        return { ok: false, error: "已有同类型的待应答提案", proposal: null };
      }
    }
    const rel = ensure(state, input.from, input.to, tick);
    if (rel.status === "contact") setStatus(rel, "negotiating", tick);
    rel.lastContactTick = tick;
    const refs: string[] = [];
    if (input.messageRefs) for (const ref of input.messageRefs) refs.push(ref);
    const proposal: Proposal = {
      id: "p:" + tick + ":" + state.nextProposalId,
      from: input.from,
      to: input.to,
      kind: input.kind,
      terms,
      counterOf: null,
      createdTick: tick,
      expiresTick: tick + rules.proposalTtlTicks,
      status: "pending",
      responseTick: null,
      reason: "",
      messageRefs: refs,
    };
    state.nextProposalId += 1;
    state.proposals.push(proposal);
    return { ok: true, error: "", proposal };
  }

  function withdraw(state: DiplomacyState, proposalId: string, tick: number): Proposal | null {
    for (const proposal of state.proposals) {
      if (proposal.id !== proposalId) continue;
      if (proposal.status !== "pending") return proposal;
      proposal.status = "withdrawn";
      proposal.responseTick = tick;
      const rel = ensure(state, proposal.from, proposal.to, tick);
      refreshRelation(state, rel, tick);
      return proposal;
    }
    return null;
  }

  function signTreaty(state: DiplomacyState, input: SignTreatyInput, tick: number): TreatyResult {
    const kind = findTreatyKind(rules, input.kind);
    if (kind === null) return { ok: false, error: "未知条约类型: " + input.kind, treaty: null };
    if (!Array.isArray(input.parties) || input.parties.length < 2) {
      return { ok: false, error: "条约至少需要两个签署方", treaty: null };
    }
    const parties: FactionId[] = [];
    for (const party of input.parties) {
      if (!exists(party)) return { ok: false, error: "未知签署方: " + party, treaty: null };
      if (parties.indexOf(party) >= 0) return { ok: false, error: "签署方重复: " + party, treaty: null };
      parties.push(party);
    }
    parties.sort();
    const terms = copyTerms(input.terms);
    const termError = validateTerms(terms);
    if (termError) return { ok: false, error: termError, treaty: null };
    const baseTick = input.signedTick === undefined ? tick : input.signedTick;
    const treaty: Treaty = {
      id: "t:" + baseTick + ":" + state.nextTreatyId,
      kind: kind.id,
      parties,
      obligations: [...kind.obligations],
      terms,
      signedTick: baseTick,
      expiresTick: kind.durationTicks > 0 ? baseTick + kind.durationTicks : 0,
      status: "active",
      breaches: [],
    };
    state.nextTreatyId += 1;
    state.treaties.push(treaty);
    for (let i = 0; i < parties.length; i++) {
      for (let j = i + 1; j < parties.length; j++) {
        const rel = ensure(state, parties[i], parties[j], baseTick);
        rel.trust = clamp(rel.trust + kind.trustOnSign, rules.trustMin, rules.trustMax);
        if (rel.status === "war" || rel.status === "ceasefire") continue;
        if (kind.status === "peace") {
          setStatus(rel, "peace", baseTick);
          rel.ceasefireUntil = null;
        } else if (kind.status === "alliance") {
          setStatus(rel, "alliance", baseTick);
        } else if (rel.status !== "alliance" && rel.status !== "peace") {
          setStatus(rel, "treaty", baseTick);
        }
      }
    }
    return { ok: true, error: "", treaty };
  }

  function respond(state: DiplomacyState, input: RespondInput, tick: number): ResponseResult {
    let proposal: Proposal | null = null;
    for (const item of state.proposals) {
      if (item.id === input.proposalId) {
        proposal = item;
        break;
      }
    }
    if (proposal === null) return { ok: false, error: "找不到提案", proposal: null, accepted: false, treaty: null, needsSettlement: false };
    if (proposal.to !== input.responder) {
      return { ok: false, error: "只有提案的接收方可以应答", proposal, accepted: false, treaty: null, needsSettlement: false };
    }
    if (proposal.status !== "pending") {
      return { ok: false, error: "提案已是 " + proposal.status + " 状态", proposal, accepted: false, treaty: null, needsSettlement: false };
    }
    if (tick <= proposal.createdTick) {
      return { ok: false, error: "提案需要至少过一回合才能应答", proposal, accepted: false, treaty: null, needsSettlement: false };
    }
    if (tick >= proposal.expiresTick && proposal.expiresTick > 0) {
      proposal.status = "expired";
      return { ok: false, error: "提案已过期", proposal, accepted: false, treaty: null, needsSettlement: false };
    }
    const kind = findProposalKind(rules, proposal.kind);
    if (kind === null) {
      return { ok: false, error: "提案类型已不在规则包里", proposal, accepted: false, treaty: null, needsSettlement: false };
    }
    const rel = ensure(state, proposal.from, proposal.to, tick);
    proposal.responseTick = tick;
    proposal.reason = input.reason ? input.reason : "";
    if (!input.accept) {
      proposal.status = "rejected";
      rel.trust = clamp(rel.trust + rules.trustOnReject, rules.trustMin, rules.trustMax);
      refreshRelation(state, rel, tick);
      return { ok: true, error: "", proposal, accepted: false, treaty: null, needsSettlement: false };
    }
    proposal.status = "accepted";
    rel.trust = clamp(rel.trust + rules.trustOnAccept, rules.trustMin, rules.trustMax);
    if (kind.mode === "treaty") {
      if (kind.createsTreaty === null) {
        return { ok: false, error: "提案规则缺少 createsTreaty", proposal, accepted: true, treaty: null, needsSettlement: false };
      }
      const signed = signTreaty(
        state,
        { kind: kind.createsTreaty, parties: [proposal.from, proposal.to], terms: proposal.terms, signedTick: tick },
        tick,
      );
      return { ok: signed.ok, error: signed.error, proposal, accepted: true, treaty: signed.treaty, needsSettlement: false };
    }
    if (kind.mode === "ceasefire") {
      setStatus(rel, "ceasefire", tick);
      rel.ceasefireUntil = tick + rules.ceasefireTicks;
      return { ok: true, error: "", proposal, accepted: true, treaty: null, needsSettlement: false };
    }
    if (kind.mode === "peace") {
      return { ok: true, error: "", proposal, accepted: true, treaty: null, needsSettlement: true };
    }
    return { ok: true, error: "", proposal, accepted: true, treaty: null, needsSettlement: false };
  }

  function addGrievance(state: DiplomacyState, input: GrievanceInput, tick: number): Grievance {
    if (!exists(input.by) || !exists(input.against)) {
      throw new Error("冤屈的持有方或对象不是已知派系");
    }
    if (input.by === input.against) throw new Error("不能对自己记冤屈");
    const ttl = input.ttlTicks === undefined ? rules.grievanceTtlTicks : input.ttlTicks;
    const grievance: Grievance = {
      id: "g:" + tick + ":" + state.nextGrievanceId,
      by: input.by,
      against: input.against,
      type: input.type,
      weight: Math.max(0, Number.isFinite(input.weight) ? input.weight : 0),
      createdTick: tick,
      expiresTick: ttl > 0 ? tick + ttl : 0,
      settled: false,
    };
    state.nextGrievanceId += 1;
    state.grievances.push(grievance);
    return grievance;
  }

  function grievances(state: DiplomacyState, by: FactionId, against?: FactionId): Grievance[] {
    const out: Grievance[] = [];
    for (const item of state.grievances) {
      if (item.settled) continue;
      if (item.by !== by) continue;
      if (against !== undefined && item.against !== against) continue;
      out.push(item);
    }
    return out;
  }

  function activeTreaties(state: DiplomacyState, faction?: FactionId): Treaty[] {
    const out: Treaty[] = [];
    for (const treaty of state.treaties) {
      if (treaty.status !== "active") continue;
      if (faction !== undefined && treaty.parties.indexOf(faction) < 0) continue;
      out.push(treaty);
    }
    return out;
  }

  function treatiesBetween(state: DiplomacyState, a: FactionId, b: FactionId): Treaty[] {
    const out: Treaty[] = [];
    for (const treaty of state.treaties) {
      if (treaty.status !== "active") continue;
      if (treaty.parties.indexOf(a) < 0 || treaty.parties.indexOf(b) < 0) continue;
      out.push(treaty);
    }
    return out;
  }

  function findObligation(state: DiplomacyState, a: FactionId, b: FactionId, obligation: string): Treaty | null {
    for (const treaty of treatiesBetween(state, a, b)) {
      if (treaty.obligations.indexOf(obligation) >= 0) return treaty;
    }
    return null;
  }

  function breach(state: DiplomacyState, treatyId: string, by: FactionId, kind: string, tick: number): BreachResult {
    let treaty: Treaty | null = null;
    for (const item of state.treaties) {
      if (item.id === treatyId) {
        treaty = item;
        break;
      }
    }
    if (treaty === null) return { ok: false, error: "找不到条约", treaty: null, breach: null, reputationDelta: 0, grievances: [] };
    if (treaty.status !== "active") {
      return { ok: false, error: "条约不是生效状态", treaty, breach: null, reputationDelta: 0, grievances: [] };
    }
    if (treaty.parties.indexOf(by) < 0) {
      return { ok: false, error: "毁约方不是签署方", treaty, breach: null, reputationDelta: 0, grievances: [] };
    }
    const penalty = rules.breachPenalties[kind] === undefined ? 0 : rules.breachPenalties[kind];
    const record = { tick, by, kind, penalty };
    treaty.breaches.push(record);
    treaty.status = "breached";
    const created: Grievance[] = [];
    for (const party of treaty.parties) {
      if (party === by) continue;
      const rel = ensure(state, by, party, tick);
      rel.trust = clamp(rel.trust + rules.trustOnBreach, rules.trustMin, rules.trustMax);
      created.push(
        addGrievance(
          state,
          { by: party, against: by, type: "treaty_breach", weight: penalty > 0 ? penalty : 1 },
          tick,
        ),
      );
    }
    for (const party of treaty.parties) {
      for (const other of treaty.parties) {
        if (party >= other) continue;
        const rel = ensure(state, party, other, tick);
        refreshRelation(state, rel, tick);
      }
    }
    return {
      ok: true,
      error: "",
      treaty,
      breach: record,
      reputationDelta: -penalty,
      grievances: created,
    };
  }

  function startWar(state: DiplomacyState, a: FactionId, b: FactionId, tick: number, casusBelli: string): Relation {
    const rel = ensure(state, a, b, tick);
    rel.status = "war";
    rel.sinceTick = tick;
    rel.lastContactTick = tick;
    rel.ceasefireUntil = null;
    return rel;
  }

  function setCeasefire(state: DiplomacyState, a: FactionId, b: FactionId, untilTick: number, tick: number): Relation {
    const rel = ensure(state, a, b, tick);
    setStatus(rel, "ceasefire", tick);
    rel.ceasefireUntil = untilTick;
    return rel;
  }

  function lapseCeasefire(state: DiplomacyState, a: FactionId, b: FactionId, tick: number): Relation {
    const rel = ensure(state, a, b, tick);
    rel.ceasefireUntil = null;
    if (rel.status === "ceasefire") setStatus(rel, "contact", tick);
    refreshRelation(state, rel, tick);
    return rel;
  }

  function signPeace(state: DiplomacyState, a: FactionId, b: FactionId, terms: ProposalTerm[], tick: number): TreatyResult {
    let peaceKind: TreatyKindRule | null = null;
    for (const rule of rules.treatyKinds) {
      if (rule.status === "peace") {
        peaceKind = rule;
        break;
      }
    }
    if (peaceKind === null) return { ok: false, error: "规则包没有 status=peace 的条约类型", treaty: null };
    const signed = signTreaty(state, { kind: peaceKind.id, parties: [a, b], terms, signedTick: tick }, tick);
    if (!signed.ok || signed.treaty === null) return signed;
    const rel = ensure(state, a, b, tick);
    rel.status = "peace";
    rel.sinceTick = tick;
    rel.ceasefireUntil = null;
    return signed;
  }

  function terminate(state: DiplomacyState, treatyId: string, tick: number, reason: string): Treaty | null {
    let treaty: Treaty | null = null;
    for (const item of state.treaties) {
      if (item.id === treatyId) {
        treaty = item;
        break;
      }
    }
    if (treaty === null) return null;
    if (treaty.status === "active") treaty.status = "terminated";
    for (const party of treaty.parties) {
      for (const other of treaty.parties) {
        if (party >= other) continue;
        const rel = ensure(state, party, other, tick);
        if (rel.status !== "war" && rel.status !== "ceasefire") refreshRelation(state, rel, tick);
      }
    }
    return treaty;
  }

  function terminateAlliances(state: DiplomacyState, faction: FactionId, tick: number): Treaty[] {
    const allianceKinds: string[] = [];
    for (const rule of rules.treatyKinds) if (rule.status === "alliance") allianceKinds.push(rule.id);
    const ended: Treaty[] = [];
    for (const treaty of state.treaties) {
      if (treaty.status !== "active") continue;
      if (treaty.parties.indexOf(faction) < 0) continue;
      const defensive = treaty.obligations.indexOf("join_defense") >= 0;
      if (allianceKinds.indexOf(treaty.kind) < 0 && !defensive) continue;
      const done = terminate(state, treaty.id, tick, "peace_settlement");
      if (done !== null) ended.push(done);
    }
    return ended;
  }

  function expire(state: DiplomacyState, tick: number): ExpireResult {
    const proposals: Proposal[] = [];
    const treaties: Treaty[] = [];
    const expiredGrievances: Grievance[] = [];
    const ceasefires: Relation[] = [];
    for (const proposal of state.proposals) {
      if (proposal.status === "pending" && proposal.expiresTick > 0 && tick >= proposal.expiresTick) {
        proposal.status = "expired";
        proposals.push(proposal);
        const rel = ensure(state, proposal.from, proposal.to, tick);
        if (rel.status !== "war" && rel.status !== "ceasefire") refreshRelation(state, rel, tick);
      }
    }
    for (const treaty of state.treaties) {
      if (treaty.status !== "active") continue;
      if (treaty.expiresTick > 0 && tick >= treaty.expiresTick) {
        treaty.status = "expired";
        treaties.push(treaty);
      }
    }
    for (const treaty of treaties) {
      for (const party of treaty.parties) {
        for (const other of treaty.parties) {
          if (party >= other) continue;
          const rel = ensure(state, party, other, tick);
          if (rel.status !== "war" && rel.status !== "ceasefire") refreshRelation(state, rel, tick);
        }
      }
    }
    for (const grievance of state.grievances) {
      if (grievance.settled) continue;
      if (grievance.expiresTick > 0 && tick >= grievance.expiresTick) {
        grievance.settled = true;
        expiredGrievances.push(grievance);
      }
    }
    for (const key of Object.keys(state.relations)) {
      const rel = state.relations[key];
      if (rel === undefined) continue;
      if (rel.status === "ceasefire" && rel.ceasefireUntil !== null && tick >= rel.ceasefireUntil) {
        ceasefires.push(rel);
      }
    }
    return { proposals, treaties, grievances: expiredGrievances, ceasefires };
  }

  return {
    createState,
    ensure,
    relation,
    status,
    contact,
    propose,
    withdraw,
    respond,
    signTreaty,
    breach,
    addGrievance,
    grievances,
    findObligation,
    activeTreaties,
    treatiesBetween,
    startWar,
    setCeasefire,
    lapseCeasefire,
    signPeace,
    terminate,
    terminateAlliances,
    expire,
  };
}
