/**
 * Casus belli validation, deterministic battle resolution, war score and peace-term arithmetic.
 *
 * The rule pack owns every label, threshold and coefficient. This module only understands the
 * *shape* of a condition (grievance / resource deficit / status / treaty obligation) and the four
 * settlement primitives (reparations, territory transfer, demilitarisation, alliance release).
 * Adding a new casus belli or peace term is a JSON edit; adding a new primitive is a code change,
 * which is the honest boundary.
 *
 * `settlePeace` mutates only the war record and returns declarative effects. The tick orchestrator
 * applies them through `state`, so a settlement can be replayed and audited from one trace.
 *
 * @module services/civ/war
 */

import type {
  BattleResult,
  CasusBelliCondition,
  CasusBelliContext,
  CasusBelliRule,
  CasusBelliValidation,
  CivWorld,
  Faction,
  FactionId,
  OpenWarInput,
  PeaceEffectRule,
  PeaceSettlement,
  PeaceTermRule,
  PeaceValidation,
  ProposalTerm,
  SettlementEffect,
  War,
  WarApi,
  WarRules,
  WarState,
  WarStatus,
  Rng,
} from "./types";

const ROUND_SCALE = 10000;

function round4(value: number): number {
  return Math.round(value * ROUND_SCALE) / ROUND_SCALE;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

function factionOf(world: CivWorld, id: FactionId): Faction | null {
  if (!Object.prototype.hasOwnProperty.call(world.factions, id)) return null;
  const found = world.factions[id];
  return found === undefined ? null : found;
}

function warHas(war: War, a: FactionId, b: FactionId): boolean {
  return (
    (war.attacker === a && war.defender === b) || (war.attacker === b && war.defender === a)
  );
}

function activeWar(state: WarState, a: FactionId, b: FactionId): War | null {
  for (const war of state.wars) {
    if (war.status === "ended") continue;
    if (warHas(war, a, b)) return war;
  }
  return null;
}

function conditionMatches(condition: CasusBelliCondition, ctx: CasusBelliContext): boolean {
  if (condition.grievance) {
    const types = condition.grievance.types;
    const min = condition.grievance.min;
    let matched = false;
    for (const grievance of ctx.grievances) {
      if (grievance.against !== ctx.target.id || grievance.by !== ctx.actor.id) continue;
      if (grievance.weight < min) continue;
      if (types.length > 0 && types.indexOf(grievance.type) < 0) continue;
      matched = true;
      break;
    }
    if (!matched) return false;
  }
  if (condition.resourceDeficit) {
    const rule = condition.resourceDeficit;
    const actorHas = ctx.actor.resources[rule.resource] === undefined ? 0 : ctx.actor.resources[rule.resource];
    const targetHas = ctx.target.resources[rule.resource] === undefined ? 0 : ctx.target.resources[rule.resource];
    if (!(actorHas < rule.actorBelow)) return false;
    if (!(targetHas >= rule.targetAtLeast)) return false;
  }
  if (condition.requiresStatus) {
    if (condition.requiresStatus.indexOf(ctx.status) < 0) return false;
  }
  if (condition.requiresTreatyObligation) {
    if (ctx.treatyObligation !== condition.requiresTreatyObligation) return false;
  }
  // An empty condition is the explicit "no justification" rule; it stays available and is priced by
  // reputation. Every constraint above is conjunctive, so reaching here means it holds.
  return true;
}

export function createWar(): WarApi {
  function createState(): WarState {
    return { wars: [], nextWarId: 0 };
  }

  function open(state: WarState, input: OpenWarInput): War {
    const existing = activeWar(state, input.attacker, input.defender);
    if (existing !== null) return existing;
    const war: War = {
      id: "w:" + input.tick + ":" + state.nextWarId,
      attacker: input.attacker,
      defender: input.defender,
      startedTick: input.tick,
      score: 0,
      battles: 0,
      status: "active",
      casusBelli: input.casusBelli,
      legitimacy: input.legitimacy,
      lastBattleTick: -1,
    };
    state.nextWarId += 1;
    state.wars.push(war);
    return war;
  }

  function byId(state: WarState, id: string): War | null {
    for (const war of state.wars) if (war.id === id) return war;
    return null;
  }

  function find(state: WarState, a: FactionId, b: FactionId): War | null {
    return activeWar(state, a, b);
  }

  function active(state: WarState): War[] {
    const out: War[] = [];
    for (const war of state.wars) if (war.status !== "ended") out.push(war);
    return out;
  }

  function validateDeclaration(
    ctx: CasusBelliContext,
    rules: WarRules,
    requestedId?: string,
  ): CasusBelliValidation {
    if (ctx.actor.id === ctx.target.id) {
      return { ok: false, rule: null, reason: "不能对自己宣战" };
    }
    if (ctx.status === "war") return { ok: false, rule: null, reason: "双方已经在战争中" };
    if (ctx.status === "ceasefire") {
      return { ok: false, rule: null, reason: "停火期内不能重新宣战（等停火到期或先签和约）" };
    }
    for (const rule of rules.casusBelli) {
      if (requestedId !== undefined && requestedId !== "" && rule.id !== requestedId) continue;
      if (!conditionMatches(rule.condition, ctx)) continue;
      return { ok: true, rule, reason: "" };
    }
    if (requestedId !== undefined && requestedId !== "") {
      return { ok: false, rule: null, reason: "casus belli " + requestedId + " 不成立" };
    }
    return { ok: false, rule: null, reason: "没有任何成立的开战理由（casus belli）" };
  }

  function resolveBattle(
    state: WarState,
    world: CivWorld,
    warId: string,
    rules: WarRules,
    rng: Rng,
  ): BattleResult {
    const war = byId(state, warId);
    if (war === null) {
      return emptyBattle(warId, "找不到战争");
    }
    if (war.status !== "active") return emptyBattle(warId, "战争不在交战状态");
    if (war.lastBattleTick === world.clock.tick) return emptyBattle(warId, "本回合已经打过一场");
    const attacker = factionOf(world, war.attacker);
    const defender = factionOf(world, war.defender);
    if (attacker === null || defender === null) return emptyBattle(warId, "战争一方不存在");
    if (attacker.army < rules.combat.minArmyToAttack) {
      return emptyBattle(warId, "进攻方兵力不足（至少 " + rules.combat.minArmyToAttack + "）");
    }
    const attackerMorale = 1 + rules.combat.moraleFactor * (attacker.morale / 100);
    const defenderMorale = 1 + rules.combat.moraleFactor * (defender.morale / 100);
    const attackPower =
      attacker.army *
      rules.combat.attackFactor *
      attackerMorale *
      (1 + war.legitimacy / 100);
    const defensePower = defender.army * rules.combat.defenseFactor * defenderMorale;
    const raw = attackPower + defensePower <= 0 ? 0.5 : attackPower / (attackPower + defensePower);
    const swing = (rng.next() * 2 - 1) * rules.combat.randomSwing;
    const ratio = clamp(raw + swing, 0, 1);
    const attackerWins = ratio >= 0.5;
    const attackerLoss = Math.min(
      attacker.army,
      Math.max(attacker.army > 0 ? 1 : 0, Math.round(attacker.army * rules.combat.casualtyFraction * (1 - ratio))),
    );
    const defenderLoss = Math.min(
      defender.army,
      Math.max(defender.army > 0 ? 1 : 0, Math.round(defender.army * rules.combat.casualtyFraction * ratio)),
    );
    const delta = attackerWins ? rules.combat.warScorePerWin : -rules.combat.warScorePerLoss;
    war.score = clamp(war.score + delta, -rules.combat.maxWarScore, rules.combat.maxWarScore);
    war.battles += 1;
    war.lastBattleTick = world.clock.tick;
    return {
      ok: true,
      reason: "",
      warId: war.id,
      winner: attackerWins ? "attacker" : "defender",
      ratio: round4(ratio),
      attackerLoss,
      defenderLoss,
      warScore: war.score,
      warScoreDelta: delta,
      attackerMoraleDelta: attackerWins ? rules.combat.moraleGain : -rules.combat.moraleLoss,
      defenderMoraleDelta: attackerWins ? -rules.combat.moraleLoss : rules.combat.moraleGain,
      attackerExhaustionDelta: rules.combat.exhaustionPerBattle,
      defenderExhaustionDelta: rules.combat.exhaustionPerBattle,
    };
  }

  function warScoreFor(state: WarState, war: War, faction: FactionId): number {
    if (war.attacker === faction) return war.score;
    if (war.defender === faction) return -war.score;
    return 0;
  }

  function termsFor(state: WarState, war: War, rules: WarRules, proposer: FactionId): PeaceTermRule[] {
    const score = warScoreFor(state, war, proposer);
    const out: PeaceTermRule[] = [];
    for (const term of rules.peaceTerms) {
      if (score < term.minWarScore) continue;
      if (term.maxWarScore !== null && score > term.maxWarScore) continue;
      out.push(term);
    }
    return out;
  }

  function validatePeace(
    state: WarState,
    warId: string,
    terms: ProposalTerm[],
    rules: WarRules,
    world: CivWorld,
    proposer: FactionId,
  ): PeaceValidation {
    const war = byId(state, warId);
    if (war === null) return { ok: false, reason: "找不到战争" };
    if (war.status === "ended") return { ok: false, reason: "战争已经结束" };
    if (war.attacker !== proposer && war.defender !== proposer) {
      return { ok: false, reason: "提案方不是战争参与方" };
    }
    if (!Array.isArray(terms) || terms.length === 0) {
      return { ok: false, reason: "和平提案至少需要一条条款" };
    }
    const score = warScoreFor(state, war, proposer);
    const winner = score >= 0 ? war.attacker : war.defender;
    const loser = winner === war.attacker ? war.defender : war.attacker;
    const responder = otherParty(war, proposer);
    for (const term of terms) {
      let rule: PeaceTermRule | null = null;
      for (const candidate of rules.peaceTerms) {
        if (candidate.id === term.id) {
          rule = candidate;
          break;
        }
      }
      if (rule === null) return { ok: false, reason: "未知和平条款: " + term.id };
      if (score < rule.minWarScore) {
        return { ok: false, reason: "战争分数不足，不能要求 " + rule.label };
      }
      if (rule.maxWarScore !== null && score > rule.maxWarScore) {
        return { ok: false, reason: "战争分数过高，不能提出 " + rule.label };
      }
      for (const effectRule of rule.effects) {
        const applied = buildEffect(effectRule, world, winner, loser, proposer, responder);
        if (!applied.ok) return { ok: false, reason: applied.error };
      }
    }
    return { ok: true, reason: "" };
  }

  function resolveRole(
    role: string | undefined,
    fallback: string,
    winner: FactionId,
    loser: FactionId,
    proposer: FactionId,
    responder: FactionId,
  ): FactionId {
    const name = role === undefined || role === "" ? fallback : role;
    if (name === "winner") return winner;
    if (name === "loser") return loser;
    if (name === "proposer") return proposer;
    if (name === "responder") return responder;
    return fallback === "winner" ? winner : loser;
  }

  function otherParty(war: War, faction: FactionId): FactionId {
    return war.attacker === faction ? war.defender : war.attacker;
  }

  function settlePeace(
    state: WarState,
    warId: string,
    terms: ProposalTerm[],
    rules: WarRules,
    world: CivWorld,
    proposer: FactionId,
  ): PeaceSettlement {
    const war = byId(state, warId);
    if (war === null) {
      return emptySettlement(warId, proposer, "找不到战争");
    }
    if (war.status === "ended") {
      return emptySettlement(warId, proposer, "战争已经结束");
    }
    if (war.attacker !== proposer && war.defender !== proposer) {
      return emptySettlement(warId, proposer, "提案方不是战争参与方");
    }
    if (!Array.isArray(terms) || terms.length === 0) {
      return emptySettlement(warId, proposer, "和平提案至少需要一条条款");
    }
    const check = validatePeace(state, warId, terms, rules, world, proposer);
    if (!check.ok) return emptySettlement(warId, proposer, check.reason);
    const score = warScoreFor(state, war, proposer);
    const winner = score >= 0 ? war.attacker : war.defender;
    const loser = winner === war.attacker ? war.defender : war.attacker;
    const responder = otherParty(war, proposer);
    const accepted: string[] = [];
    const effects: SettlementEffect[] = [];
    for (const term of terms) {
      let rule: PeaceTermRule | null = null;
      for (const candidate of rules.peaceTerms) {
        if (candidate.id === term.id) {
          rule = candidate;
          break;
        }
      }
      if (rule === null) {
        return emptySettlement(warId, proposer, "未知和平条款: " + term.id);
      }
      if (score < rule.minWarScore) {
        return emptySettlement(warId, proposer, "战争分数不足，不能要求 " + rule.label);
      }
      if (rule.maxWarScore !== null && score > rule.maxWarScore) {
        return emptySettlement(warId, proposer, "战争分数过高，不能提出 " + rule.label);
      }
      accepted.push(rule.id);
      for (const effectRule of rule.effects) {
        const applied = buildEffect(effectRule, world, winner, loser, proposer, responder);
        if (!applied.ok) return emptySettlement(warId, proposer, applied.error);
        if (applied.effect !== null) effects.push(applied.effect);
      }
    }
    war.status = "ended";
    return {
      ok: true,
      reason: "",
      warId: war.id,
      proposer,
      winner,
      loser,
      terms: accepted,
      effects,
      warScore: score,
    };
  }

  function buildEffect(
    rule: PeaceEffectRule,
    world: CivWorld,
    winner: FactionId,
    loser: FactionId,
    proposer: FactionId,
    responder: FactionId,
  ): { ok: boolean; error: string; effect: SettlementEffect | null } {
    if (rule.type === "reparations") {
      const payer = resolveRole(rule.payer, "loser", winner, loser, proposer, responder);
      const beneficiary = resolveRole(rule.beneficiary, "winner", winner, loser, proposer, responder);
      const resource = rule.resource === undefined ? "" : rule.resource;
      if (!resource) return { ok: false, error: "赔款条款缺少 resource", effect: null };
      const payerFaction = factionOf(world, payer);
      if (payerFaction === null) return { ok: false, error: "赔款方不存在: " + payer, effect: null };
      const current = payerFaction.resources[resource] === undefined ? 0 : payerFaction.resources[resource];
      const raw = rule.fraction === undefined ? (rule.amount === undefined ? 0 : rule.amount) : current * rule.fraction;
      const amount = round4(clamp(raw, 0, current));
      if (amount <= 0) return { ok: true, error: "", effect: null };
      return {
        ok: true,
        error: "",
        effect: { type: "resources", from: payer, to: beneficiary, resource, amount },
      };
    }
    if (rule.type === "transfer_territory") {
      const from = resolveRole(rule.from, "loser", winner, loser, proposer, responder);
      const to = resolveRole(rule.to, "winner", winner, loser, proposer, responder);
      const fromFaction = factionOf(world, from);
      if (fromFaction === null) return { ok: false, error: "割地方不存在: " + from, effect: null };
      const amount = round4(clamp(rule.amount === undefined ? 1 : rule.amount, 0, fromFaction.territory));
      if (amount <= 0) return { ok: true, error: "", effect: null };
      return { ok: true, error: "", effect: { type: "territory", from, to, amount } };
    }
    if (rule.type === "demilitarize") {
      const faction = resolveRole(rule.faction, "loser", winner, loser, proposer, responder);
      const fraction = clamp(rule.fraction === undefined ? 0 : rule.fraction, 0, 1);
      return { ok: true, error: "", effect: { type: "demilitarize", faction, fraction } };
    }
    if (rule.type === "release_alliance") {
      const faction = resolveRole(rule.faction, "loser", winner, loser, proposer, responder);
      return { ok: true, error: "", effect: { type: "release_alliance", faction } };
    }
    return { ok: false, error: "未知和平条款效果: " + rule.type, effect: null };
  }

  function setStatus(state: WarState, warId: string, status: WarStatus): War | null {
    const war = byId(state, warId);
    if (war === null) return null;
    war.status = status;
    return war;
  }

  function emptyBattle(warId: string, reason: string): BattleResult {
    return {
      ok: false,
      reason,
      warId,
      winner: "",
      ratio: 0,
      attackerLoss: 0,
      defenderLoss: 0,
      warScore: 0,
      warScoreDelta: 0,
      attackerMoraleDelta: 0,
      defenderMoraleDelta: 0,
      attackerExhaustionDelta: 0,
      defenderExhaustionDelta: 0,
    };
  }

  function emptySettlement(warId: string, proposer: FactionId, reason: string): PeaceSettlement {
    return {
      ok: false,
      reason,
      warId,
      proposer,
      winner: "",
      loser: "",
      terms: [],
      effects: [],
      warScore: 0,
    };
  }

  return {
    createState,
    open,
    find,
    byId,
    active,
    validateDeclaration,
    resolveBattle,
    warScoreFor,
    termsFor,
    validatePeace,
    settlePeace,
    setStatus,
  };
}
