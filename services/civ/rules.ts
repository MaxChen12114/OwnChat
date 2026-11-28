/**
 * The rule-pack boundary: JSON in, typed `CivRules` out, every error reported at once.
 *
 * The pack is authored data, so this module is intentionally boring and strict: unknown keys are
 * errors, missing numbers are errors, and cross-references (a proposal pointing at a missing treaty
 * kind, a casus belli naming a resource the economy never produces) are errors. A typo in a rule
 * pack must fail at load time, not silently remove a mechanic from the simulation.
 *
 * @module services/civ/rules
 */

import type {
  CasusBelliCondition,
  CasusBelliRule,
  ChannelRules,
  CivRules,
  CombatRules,
  DiplomacyRules,
  EconomyRules,
  MessageKind,
  PeaceEffectRule,
  PeaceTermRule,
  ProposalKindRule,
  RelationStatus,
  ResourceMap,
  RulesParseResult,
  TreatyKindRule,
  WarRules,
} from "./types";

const RELATION_STATUSES: string[] = [
  "contact",
  "negotiating",
  "treaty",
  "alliance",
  "war",
  "ceasefire",
  "peace",
];
const MESSAGE_KINDS: string[] = ["speech", "proposal", "response", "notice"];
const PROPOSAL_MODES = ["treaty", "peace", "ceasefire", "none"];
const TREATY_STATUSES = ["treaty", "alliance", "peace"];
const EFFECT_TYPES = ["reparations", "transfer_territory", "demilitarize", "release_alliance"];
const OBLIGATIONS = ["no_attack", "join_defense", "trade_access"];

function isRelationStatus(value: string): value is RelationStatus {
  return RELATION_STATUSES.indexOf(value) >= 0;
}

function isMessageKind(value: string): value is MessageKind {
  return MESSAGE_KINDS.indexOf(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(value)) return out;
  for (const key of Object.keys(value)) out[key] = Reflect.get(value, key);
  return out;
}

function arrOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOf(value: unknown): boolean {
  return value === true;
}

function requireText(rec: Record<string, unknown>, key: string, path: string, errors: string[]): string {
  const value = textOf(rec[key]).trim();
  if (value === "") errors.push(path + "." + key + " 必须是非空字符串");
  return value;
}

function requireNum(rec: Record<string, unknown>, key: string, path: string, errors: string[]): number {
  const value = numOf(rec[key]);
  if (value === null) {
    errors.push(path + "." + key + " 必须是有限数字");
    return 0;
  }
  return value;
}

function optionalNum(rec: Record<string, unknown>, key: string, path: string, errors: string[]): number | undefined {
  if (rec[key] === undefined || rec[key] === null) return undefined;
  const value = numOf(rec[key]);
  if (value === null) {
    errors.push(path + "." + key + " 必须是有限数字");
    return undefined;
  }
  return value;
}

function textArray(value: unknown): string[] {
  const out: string[] = [];
  for (const item of arrOf(value)) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
  }
  return out;
}

function parseResourceMap(value: unknown, path: string, errors: string[]): ResourceMap {
  const out: ResourceMap = {};
  if (!isRecord(value)) {
    errors.push(path + " 必须是对象（资源名 -> 数字）");
    return out;
  }
  const rec = recOf(value);
  for (const key of Object.keys(rec)) {
    const n = numOf(rec[key]);
    if (n === null) {
      errors.push(path + "." + key + " 必须是有限数字");
      continue;
    }
    out[key] = n;
  }
  return out;
}

function parseEconomy(value: unknown, errors: string[]): EconomyRules | null {
  const rec = recOf(value);
  if (!isRecord(value)) {
    errors.push("economy 必须是对象");
    return null;
  }
  const resources = textArray(rec.resources);
  if (resources.length === 0) errors.push("economy.resources 必须是非空字符串数组");
  const uniqueResources: string[] = [];
  for (const resource of resources) {
    if (uniqueResources.indexOf(resource) >= 0) errors.push("economy.resources 重复: " + resource);
    else uniqueResources.push(resource);
  }
  return {
    resources: uniqueResources,
    productionPerTurn: parseResourceMap(rec.productionPerTurn, "economy.productionPerTurn", errors),
    perPopulation: parseResourceMap(rec.perPopulation, "economy.perPopulation", errors),
    perTerritory: parseResourceMap(rec.perTerritory, "economy.perTerritory", errors),
    upkeepPerArmy: parseResourceMap(rec.upkeepPerArmy, "economy.upkeepPerArmy", errors),
    maxMorale: requireNum(rec, "maxMorale", "economy", errors),
    maxReputation: requireNum(rec, "maxReputation", "economy", errors),
    maxWarExhaustion: requireNum(rec, "maxWarExhaustion", "economy", errors),
    moraleRecovery: requireNum(rec, "moraleRecovery", "economy", errors),
    starvationMoralePenalty: requireNum(rec, "starvationMoralePenalty", "economy", errors),
    populationGrowthPerTurn: requireNum(rec, "populationGrowthPerTurn", "economy", errors),
    reputationAnchor: requireNum(rec, "reputationAnchor", "economy", errors),
    reputationDecayRate: requireNum(rec, "reputationDecayRate", "economy", errors),
    warExhaustionDecay: requireNum(rec, "warExhaustionDecay", "economy", errors),
    recruitCostPerSoldier: parseResourceMap(rec.recruitCostPerSoldier, "economy.recruitCostPerSoldier", errors),
    maxRecruitPerTurn: requireNum(rec, "maxRecruitPerTurn", "economy", errors),
  };
}

function parseTreatyKind(value: unknown, index: number, errors: string[]): TreatyKindRule {
  const path = "diplomacy.treatyKinds[" + index + "]";
  const rec = recOf(value);
  const obligations = textArray(rec.obligations);
  for (const obligation of obligations) {
    if (OBLIGATIONS.indexOf(obligation) < 0) errors.push(path + ".obligations 含未知义务: " + obligation);
  }
  const status = textOf(rec.status);
  if (TREATY_STATUSES.indexOf(status) < 0) {
    errors.push(path + ".status 必须是 " + TREATY_STATUSES.join("/") + "，得到 " + JSON.stringify(rec.status));
  }
  return {
    id: requireText(rec, "id", path, errors),
    label: requireText(rec, "label", path, errors),
    obligations,
    durationTicks: requireNum(rec, "durationTicks", path, errors),
    trustOnSign: requireNum(rec, "trustOnSign", path, errors),
    breachOnAttack: requireText(rec, "breachOnAttack", path, errors),
    status: status === "alliance" || status === "peace" ? status : "treaty",
  };
}

function parseProposalKind(value: unknown, index: number, errors: string[]): ProposalKindRule {
  const path = "diplomacy.proposalKinds[" + index + "]";
  const rec = recOf(value);
  const allowed: RelationStatus[] = [];
  for (const item of textArray(rec.allowedStatus)) {
    if (!isRelationStatus(item)) {
      errors.push(path + ".allowedStatus 含未知状态: " + item);
    } else {
      allowed.push(item);
    }
  }
  const mode = textOf(rec.mode);
  if (PROPOSAL_MODES.indexOf(mode) < 0) {
    errors.push(path + ".mode 必须是 " + PROPOSAL_MODES.join("/") + "，得到 " + JSON.stringify(rec.mode));
  }
  const createsRaw = rec.createsTreaty;
  let creates: string | null = null;
  if (createsRaw !== undefined && createsRaw !== null) {
    if (typeof createsRaw !== "string" || createsRaw.trim() === "") {
      errors.push(path + ".createsTreaty 必须是字符串或 null");
    } else {
      creates = createsRaw.trim();
    }
  }
  return {
    id: requireText(rec, "id", path, errors),
    label: requireText(rec, "label", path, errors),
    mode: mode === "peace" || mode === "ceasefire" || mode === "none" ? mode : "treaty",
    createsTreaty: creates,
    requiresWar: boolOf(rec.requiresWar),
    allowedStatus: allowed,
    requiresTerms: boolOf(rec.requiresTerms),
  };
}

function parseDiplomacy(value: unknown, errors: string[]): DiplomacyRules | null {
  if (!isRecord(value)) {
    errors.push("diplomacy 必须是对象");
    return null;
  }
  const rec = recOf(value);
  const treatyKinds: TreatyKindRule[] = [];
  arrOf(rec.treatyKinds).forEach((item, index) => treatyKinds.push(parseTreatyKind(item, index, errors)));
  const proposalKinds: ProposalKindRule[] = [];
  arrOf(rec.proposalKinds).forEach((item, index) => proposalKinds.push(parseProposalKind(item, index, errors)));
  if (treatyKinds.length === 0) errors.push("diplomacy.treatyKinds 不能为空");
  if (proposalKinds.length === 0) errors.push("diplomacy.proposalKinds 不能为空");
  return {
    proposalTtlTicks: requireNum(rec, "proposalTtlTicks", "diplomacy", errors),
    ceasefireTicks: requireNum(rec, "ceasefireTicks", "diplomacy", errors),
    grievanceTtlTicks: requireNum(rec, "grievanceTtlTicks", "diplomacy", errors),
    trustMin: requireNum(rec, "trustMin", "diplomacy", errors),
    trustMax: requireNum(rec, "trustMax", "diplomacy", errors),
    trustOnAccept: requireNum(rec, "trustOnAccept", "diplomacy", errors),
    trustOnReject: requireNum(rec, "trustOnReject", "diplomacy", errors),
    trustOnSign: requireNum(rec, "trustOnSign", "diplomacy", errors),
    trustOnBreach: requireNum(rec, "trustOnBreach", "diplomacy", errors),
    breachPenalties: parseResourceMap(rec.breachPenalties, "diplomacy.breachPenalties", errors),
    treatyKinds,
    proposalKinds,
  };
}

function parseCondition(value: unknown, path: string, errors: string[]): CasusBelliCondition {
  const rec = recOf(value);
  const condition: CasusBelliCondition = {};
  if (!isRecord(value)) {
    errors.push(path + " 必须是对象");
    return condition;
  }
  const known = ["grievance", "resourceDeficit", "requiresStatus", "requiresTreatyObligation"];
  for (const key of Object.keys(rec)) {
    if (known.indexOf(key) < 0) errors.push(path + " 含未知条件键: " + key);
  }
  if (rec.grievance !== undefined) {
    const g = recOf(rec.grievance);
    condition.grievance = {
      types: textArray(g.types),
      min: requireNum(g, "min", path + ".grievance", errors),
    };
  }
  if (rec.resourceDeficit !== undefined) {
    const d = recOf(rec.resourceDeficit);
    condition.resourceDeficit = {
      resource: requireText(d, "resource", path + ".resourceDeficit", errors),
      actorBelow: requireNum(d, "actorBelow", path + ".resourceDeficit", errors),
      targetAtLeast: requireNum(d, "targetAtLeast", path + ".resourceDeficit", errors),
    };
  }
  if (rec.requiresStatus !== undefined) {
    const statuses: RelationStatus[] = [];
    for (const item of textArray(rec.requiresStatus)) {
      if (!isRelationStatus(item)) {
        errors.push(path + ".requiresStatus 含未知状态: " + item);
      } else {
        statuses.push(item);
      }
    }
    condition.requiresStatus = statuses;
  }
  if (rec.requiresTreatyObligation !== undefined) {
    const obligation = requireText(rec, "requiresTreatyObligation", path, errors);
    if (obligation !== "" && OBLIGATIONS.indexOf(obligation) < 0) {
      errors.push(path + ".requiresTreatyObligation 含未知义务: " + obligation);
    }
    condition.requiresTreatyObligation = obligation;
  }
  return condition;
}

function parseCasusBelli(value: unknown, index: number, errors: string[]): CasusBelliRule {
  const path = "war.casusBelli[" + index + "]";
  const rec = recOf(value);
  return {
    id: requireText(rec, "id", path, errors),
    label: requireText(rec, "label", path, errors),
    condition: parseCondition(rec.condition, path + ".condition", errors),
    reputationCost: requireNum(rec, "reputationCost", path, errors),
    legitimacy: requireNum(rec, "legitimacy", path, errors),
  };
}

function parsePeaceEffect(value: unknown, path: string, errors: string[]): PeaceEffectRule {
  const rec = recOf(value);
  const type = requireText(rec, "type", path, errors);
  if (type !== "" && EFFECT_TYPES.indexOf(type) < 0) {
    errors.push(path + ".type 未知效果: " + type);
  }
  const effect: PeaceEffectRule = { type };
  const resource = textOf(rec.resource).trim();
  if (resource !== "") effect.resource = resource;
  const fraction = optionalNum(rec, "fraction", path, errors);
  if (fraction !== undefined) effect.fraction = fraction;
  const amount = optionalNum(rec, "amount", path, errors);
  if (amount !== undefined) effect.amount = amount;
  const payer = textOf(rec.payer).trim();
  if (payer !== "") effect.payer = payer;
  const beneficiary = textOf(rec.beneficiary).trim();
  if (beneficiary !== "") effect.beneficiary = beneficiary;
  const from = textOf(rec.from).trim();
  if (from !== "") effect.from = from;
  const to = textOf(rec.to).trim();
  if (to !== "") effect.to = to;
  const faction = textOf(rec.faction).trim();
  if (faction !== "") effect.faction = faction;
  if (type === "reparations" && effect.resource === undefined) {
    errors.push(path + " reparations 需要 resource");
  }
  if (type === "demilitarize" && effect.fraction === undefined) {
    errors.push(path + " demilitarize 需要 fraction");
  }
  if (type === "transfer_territory" && effect.amount === undefined) {
    errors.push(path + " transfer_territory 需要 amount");
  }
  return effect;
}

function parsePeaceTerm(value: unknown, index: number, errors: string[]): PeaceTermRule {
  const path = "war.peaceTerms[" + index + "]";
  const rec = recOf(value);
  const effects: PeaceEffectRule[] = [];
  arrOf(rec.effects).forEach((item, effectIndex) =>
    effects.push(parsePeaceEffect(item, path + ".effects[" + effectIndex + "]", errors)),
  );
  const maxRaw = rec.maxWarScore;
  let maxWarScore: number | null = null;
  if (maxRaw !== undefined && maxRaw !== null) {
    const n = numOf(maxRaw);
    if (n === null) errors.push(path + ".maxWarScore 必须是有限数字或 null");
    else maxWarScore = n;
  }
  return {
    id: requireText(rec, "id", path, errors),
    label: requireText(rec, "label", path, errors),
    minWarScore: requireNum(rec, "minWarScore", path, errors),
    maxWarScore,
    effects,
  };
}

function parseCombat(value: unknown, errors: string[]): CombatRules {
  const rec = recOf(value);
  return {
    attackFactor: requireNum(rec, "attackFactor", "war.combat", errors),
    defenseFactor: requireNum(rec, "defenseFactor", "war.combat", errors),
    moraleFactor: requireNum(rec, "moraleFactor", "war.combat", errors),
    randomSwing: requireNum(rec, "randomSwing", "war.combat", errors),
    casualtyFraction: requireNum(rec, "casualtyFraction", "war.combat", errors),
    warScorePerWin: requireNum(rec, "warScorePerWin", "war.combat", errors),
    warScorePerLoss: requireNum(rec, "warScorePerLoss", "war.combat", errors),
    moraleGain: requireNum(rec, "moraleGain", "war.combat", errors),
    moraleLoss: requireNum(rec, "moraleLoss", "war.combat", errors),
    exhaustionPerBattle: requireNum(rec, "exhaustionPerBattle", "war.combat", errors),
    exhaustionPerTurn: requireNum(rec, "exhaustionPerTurn", "war.combat", errors),
    forcedCeasefireAt: requireNum(rec, "forcedCeasefireAt", "war.combat", errors),
    maxWarScore: requireNum(rec, "maxWarScore", "war.combat", errors),
    minArmyToAttack: requireNum(rec, "minArmyToAttack", "war.combat", errors),
  };
}

function parseWar(value: unknown, errors: string[]): WarRules | null {
  if (!isRecord(value)) {
    errors.push("war 必须是对象");
    return null;
  }
  const rec = recOf(value);
  const casusBelli: CasusBelliRule[] = [];
  arrOf(rec.casusBelli).forEach((item, index) => casusBelli.push(parseCasusBelli(item, index, errors)));
  const peaceTerms: PeaceTermRule[] = [];
  arrOf(rec.peaceTerms).forEach((item, index) => peaceTerms.push(parsePeaceTerm(item, index, errors)));
  if (casusBelli.length === 0) errors.push("war.casusBelli 不能为空");
  if (peaceTerms.length === 0) errors.push("war.peaceTerms 不能为空");
  return {
    combat: parseCombat(rec.combat, errors),
    casusBelli,
    peaceTerms,
  };
}

function parseChannels(value: unknown, errors: string[]): ChannelRules | null {
  if (!isRecord(value)) {
    errors.push("channels 必须是对象");
    return null;
  }
  const rec = recOf(value);
  const requireRefsFor: MessageKind[] = [];
  for (const item of textArray(rec.requireRefsFor)) {
    if (!isMessageKind(item)) {
      errors.push("channels.requireRefsFor 含未知消息类型: " + item);
    } else {
      requireRefsFor.push(item);
    }
  }
  return {
    maxTextLength: requireNum(rec, "maxTextLength", "channels", errors),
    maxRefs: requireNum(rec, "maxRefs", "channels", errors),
    maxRefLength: requireNum(rec, "maxRefLength", "channels", errors),
    requireRefsFor,
    maxBlocMembers: requireNum(rec, "maxBlocMembers", "channels", errors),
  };
}

function hasId<T extends { id: string }>(list: T[], id: string): boolean {
  for (const item of list) if (item.id === id) return true;
  return false;
}

function duplicateIds<T extends { id: string }>(list: T[], path: string, errors: string[]): void {
  const seen: string[] = [];
  for (const item of list) {
    if (seen.indexOf(item.id) >= 0) errors.push(path + " id 重复: " + item.id);
    else seen.push(item.id);
  }
}

export function parseRules(raw: unknown): RulesParseResult {
  if (!isRecord(raw)) return { ok: false, errors: ["规则包必须是 JSON 对象"], rules: null };
  const root = recOf(raw);
  const errors: string[] = [];
  const id = requireText(root, "id", "规则包", errors);
  if (root.schemaVersion !== 1) {
    errors.push("schemaVersion 必须是 1，得到 " + JSON.stringify(root.schemaVersion));
  }
  const economy = parseEconomy(root.economy, errors);
  const diplomacy = parseDiplomacy(root.diplomacy, errors);
  const war = parseWar(root.war, errors);
  const channels = parseChannels(root.channels, errors);
  if (economy === null || diplomacy === null || war === null || channels === null) {
    return { ok: false, errors, rules: null };
  }

  duplicateIds(diplomacy.treatyKinds, "diplomacy.treatyKinds", errors);
  duplicateIds(diplomacy.proposalKinds, "diplomacy.proposalKinds", errors);
  duplicateIds(war.casusBelli, "war.casusBelli", errors);
  duplicateIds(war.peaceTerms, "war.peaceTerms", errors);

  let peaceKind = false;
  for (const kind of diplomacy.treatyKinds) {
    if (kind.status === "peace") peaceKind = true;
    if (kind.breachOnAttack !== "" && diplomacy.breachPenalties[kind.breachOnAttack] === undefined) {
      errors.push("diplomacy.treatyKinds " + kind.id + " 的 breachOnAttack 未在 breachPenalties 里声明: " + kind.breachOnAttack);
    }
  }
  if (!peaceKind) errors.push("diplomacy.treatyKinds 至少需要一个 status=peace 的条约类型");
  for (const proposal of diplomacy.proposalKinds) {
    if (proposal.mode === "treaty") {
      if (proposal.createsTreaty === null) {
        errors.push("diplomacy.proposalKinds " + proposal.id + " mode=treaty 需要 createsTreaty");
      } else if (!hasId(diplomacy.treatyKinds, proposal.createsTreaty)) {
        errors.push("diplomacy.proposalKinds " + proposal.id + " 指向不存在的条约类型: " + proposal.createsTreaty);
      }
    }
    if ((proposal.mode === "peace" || proposal.mode === "ceasefire") && !proposal.requiresWar) {
      errors.push("diplomacy.proposalKinds " + proposal.id + " mode=" + proposal.mode + " 必须 requiresWar=true");
    }
  }
  for (const term of war.peaceTerms) {
    if (term.maxWarScore !== null && term.minWarScore > term.maxWarScore) {
      errors.push("war.peaceTerms " + term.id + " 的 minWarScore 大于 maxWarScore");
    }
    for (const effect of term.effects) {
      if (effect.resource !== undefined && economy.resources.indexOf(effect.resource) < 0) {
        errors.push("war.peaceTerms " + term.id + " 引用了 economy 未声明的资源: " + effect.resource);
      }
    }
  }
  for (const cb of war.casusBelli) {
    const deficit = cb.condition.resourceDeficit;
    if (deficit !== undefined && economy.resources.indexOf(deficit.resource) < 0) {
      errors.push("war.casusBelli " + cb.id + " 引用了 economy 未声明的资源: " + deficit.resource);
    }
  }

  if (errors.length > 0) return { ok: false, errors, rules: null };
  const rules: CivRules = {
    id,
    schemaVersion: 1,
    economy,
    diplomacy,
    war,
    channels,
  };
  return { ok: true, errors: [], rules };
}
