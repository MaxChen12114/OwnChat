/**
 * Structural contracts for the civilization/diplomacy engine.
 *
 * This module is type-only on purpose: every runtime module imports it with `import type`, which
 * Node's type stripper erases before evaluation. That keeps `services/civ/*` loadable one file at a
 * time (tests use `tooling/l0/load-service.mjs`), while the dependency graph stays explicit in the types.
 *
 * Ownership:
 *   - `state` owns faction facts, the turn clock and deterministic RNG.
 *   - `diplomacy` owns relations, proposals, treaties and grievances.
 *   - `war` owns casus belli validation, battles, war score and peace-term arithmetic.
 *   - `channels` owns message visibility (public council / private envoy / bloc).
 *   - `tick` is the only orchestrator; it applies every state mutation and writes the trace.
 *
 * @module services/civ/types
 */

export type FactionId = string;

/** Resource keys are authored in the rule pack, never hard-coded here. */
export type ResourceMap = Record<string, number>;

export type RelationStatus =
  | "contact"
  | "negotiating"
  | "treaty"
  | "alliance"
  | "war"
  | "ceasefire"
  | "peace";

export type ProposalStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "expired"
  | "countered"
  | "withdrawn";

export type TreatyStatus = "active" | "expired" | "breached" | "terminated";

export type WarStatus = "active" | "ceasefire" | "ended";

/** What a scenario author supplies for one faction. Missing stats fall back to safe defaults. */
export interface FactionSeed {
  id: FactionId;
  name: string;
  resources: ResourceMap;
  population: number;
  territory: number;
  army: number;
  morale?: number;
  reputation?: number;
  warExhaustion?: number;
}

export interface Faction {
  id: FactionId;
  name: string;
  /** Current stockpiles. Values are rounded to 4 decimals after every mutation. */
  resources: ResourceMap;
  population: number;
  /** Abstract province/land count; war settlement is the only transfer path. */
  territory: number;
  army: number;
  /** 0..100; combat strength and recovery read this. */
  morale: number;
  /** 0..100; breach penalties and casus belli legitimacy read this. */
  reputation: number;
  /** 0..100; crossing the rule threshold forces a ceasefire. */
  warExhaustion: number;
}

export interface Clock {
  /** Turn counter; one tick is one season in the default pack. */
  tick: number;
  year: number;
  season: number;
  seasonsPerYear: number;
}

export interface CivWorld {
  schemaVersion: 1;
  seed: number;
  clock: Clock;
  /** Authored order. Every multi-faction loop uses this array, never object key order. */
  order: FactionId[];
  factions: Record<FactionId, Faction>;
}

export interface FactionDelta {
  resources?: ResourceMap;
  population?: number;
  territory?: number;
  army?: number;
  morale?: number;
  reputation?: number;
  warExhaustion?: number;
}

export interface Rng {
  /** Uniform in [0,1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform in [min,max). */
  range(min: number, max: number): number;
}

export interface CreateWorldOptions {
  seed: number;
  factions: FactionSeed[];
  clock?: Partial<Clock>;
}

export interface ProductionResult {
  faction: FactionId;
  resources: ResourceMap;
  population: number;
  morale: number;
  shortage: boolean;
}

export interface StateApi {
  createWorld(opts: CreateWorldOptions): CivWorld;
  faction(world: CivWorld, id: FactionId): Faction | null;
  factions(world: CivWorld): Faction[];
  adjust(world: CivWorld, id: FactionId, delta: FactionDelta): Faction | null;
  canAfford(world: CivWorld, id: FactionId, cost: ResourceMap): boolean;
  spend(world: CivWorld, id: FactionId, cost: ResourceMap): boolean;
  produce(world: CivWorld, economy: EconomyRules): ProductionResult[];
  advance(world: CivWorld): Clock;
  rng(seed: number, ...domain: (string | number)[]): Rng;
  stableHash(value: unknown): number;
  canonicalJSON(value: unknown): string;
  cloneWorld(world: CivWorld): CivWorld;
}

export interface EconomyRules {
  resources: string[];
  productionPerTurn: ResourceMap;
  perPopulation: ResourceMap;
  perTerritory: ResourceMap;
  upkeepPerArmy: ResourceMap;
  maxMorale: number;
  maxReputation: number;
  maxWarExhaustion: number;
  moraleRecovery: number;
  starvationMoralePenalty: number;
  populationGrowthPerTurn: number;
  reputationAnchor: number;
  reputationDecayRate: number;
  warExhaustionDecay: number;
  recruitCostPerSoldier: ResourceMap;
  maxRecruitPerTurn: number;
}

export interface Relation {
  /** Canonical pair: `a` sorts before `b`. */
  a: FactionId;
  b: FactionId;
  status: RelationStatus;
  /** -100..100, pair-local. Treaties raise it; breaches slash it. */
  trust: number;
  sinceTick: number;
  lastContactTick: number;
  ceasefireUntil: number | null;
}

export interface ProposalTerm {
  /** Term id from the rule pack (peace terms) or a generic `resource_transfer`. */
  id: string;
  params?: Record<string, number | string>;
}

export interface Proposal {
  id: string;
  from: FactionId;
  to: FactionId;
  kind: string;
  terms: ProposalTerm[];
  counterOf: string | null;
  createdTick: number;
  expiresTick: number;
  status: ProposalStatus;
  responseTick: number | null;
  reason: string;
  /** Verifiable message refs attached by the caller (never parsed as instructions). */
  messageRefs: string[];
}

export interface TreatyBreach {
  tick: number;
  by: FactionId;
  kind: string;
  penalty: number;
}

export interface Treaty {
  id: string;
  kind: string;
  /** Sorted for stable comparison. */
  parties: FactionId[];
  obligations: string[];
  terms: ProposalTerm[];
  signedTick: number;
  /** 0 means no expiry. */
  expiresTick: number;
  status: TreatyStatus;
  breaches: TreatyBreach[];
}

export interface Grievance {
  id: string;
  by: FactionId;
  against: FactionId;
  /** Data string from the breach/casus-belli vocabulary, never interpreted as code. */
  type: string;
  weight: number;
  createdTick: number;
  expiresTick: number;
  settled: boolean;
}

export interface DiplomacyState {
  relations: Record<string, Relation>;
  proposals: Proposal[];
  treaties: Treaty[];
  grievances: Grievance[];
  nextProposalId: number;
  nextTreatyId: number;
  nextGrievanceId: number;
}

export interface TreatyKindRule {
  id: string;
  label: string;
  obligations: string[];
  durationTicks: number;
  trustOnSign: number;
  /** Breach-penalty key used when a signatory attacks another signatory. */
  breachOnAttack: string;
  /** Relation status this treaty kind establishes while active. */
  status: "treaty" | "alliance" | "peace";
}

export interface ProposalKindRule {
  id: string;
  label: string;
  /**
   * How acceptance is applied: `treaty` signs immediately; `peace` asks the tick to settle war
   * terms first; `ceasefire` starts a timer; `none` only records the answer.
   */
  mode: "treaty" | "peace" | "ceasefire" | "none";
  /** Treaty kind to sign when mode is `treaty`. */
  createsTreaty: string | null;
  requiresWar: boolean;
  allowedStatus: RelationStatus[];
  requiresTerms: boolean;
}

export interface DiplomacyRules {
  proposalTtlTicks: number;
  ceasefireTicks: number;
  grievanceTtlTicks: number;
  trustMin: number;
  trustMax: number;
  trustOnAccept: number;
  trustOnReject: number;
  trustOnSign: number;
  trustOnBreach: number;
  /** breach kind -> positive reputation points removed from the breaker. */
  breachPenalties: Record<string, number>;
  treatyKinds: TreatyKindRule[];
  proposalKinds: ProposalKindRule[];
}

export interface DiplomacyPorts {
  exists(id: FactionId): boolean;
}

export interface ProposalInput {
  from: FactionId;
  to: FactionId;
  kind: string;
  terms?: ProposalTerm[];
  messageRefs?: string[];
}

export interface ProposalResult {
  ok: boolean;
  error: string;
  proposal: Proposal | null;
}

export interface RespondInput {
  responder: FactionId;
  proposalId: string;
  accept: boolean;
  reason?: string;
}

export interface ResponseResult {
  ok: boolean;
  error: string;
  proposal: Proposal | null;
  accepted: boolean;
  treaty: Treaty | null;
  /** True for peace: the tick must settle terms through `war.settlePeace` before closing the war. */
  needsSettlement: boolean;
}

export interface SignTreatyInput {
  kind: string;
  parties: FactionId[];
  terms?: ProposalTerm[];
  signedTick?: number;
}

export interface TreatyResult {
  ok: boolean;
  error: string;
  treaty: Treaty | null;
}

export interface BreachResult {
  ok: boolean;
  error: string;
  treaty: Treaty | null;
  breach: TreatyBreach | null;
  /** Negative: the breaker loses this much reputation. Zero when the rule has no penalty. */
  reputationDelta: number;
  grievances: Grievance[];
}

export interface GrievanceInput {
  by: FactionId;
  against: FactionId;
  type: string;
  weight: number;
  ttlTicks?: number;
}

export interface ExpireResult {
  proposals: Proposal[];
  treaties: Treaty[];
  grievances: Grievance[];
  /** Ceasefires whose timer elapsed. The tick decides whether war resumes or peace holds. */
  ceasefires: Relation[];
}

export interface DiplomacyApi {
  createState(): DiplomacyState;
  ensure(state: DiplomacyState, a: FactionId, b: FactionId, tick: number): Relation;
  relation(state: DiplomacyState, a: FactionId, b: FactionId): Relation | null;
  status(state: DiplomacyState, a: FactionId, b: FactionId): RelationStatus;
  contact(state: DiplomacyState, a: FactionId, b: FactionId, tick: number): Relation;
  propose(state: DiplomacyState, input: ProposalInput, tick: number): ProposalResult;
  withdraw(state: DiplomacyState, proposalId: string, tick: number): Proposal | null;
  respond(state: DiplomacyState, input: RespondInput, tick: number): ResponseResult;
  signTreaty(state: DiplomacyState, input: SignTreatyInput, tick: number): TreatyResult;
  breach(state: DiplomacyState, treatyId: string, by: FactionId, kind: string, tick: number): BreachResult;
  addGrievance(state: DiplomacyState, input: GrievanceInput, tick: number): Grievance;
  grievances(state: DiplomacyState, by: FactionId, against?: FactionId): Grievance[];
  findObligation(state: DiplomacyState, a: FactionId, b: FactionId, obligation: string): Treaty | null;
  activeTreaties(state: DiplomacyState, faction?: FactionId): Treaty[];
  treatiesBetween(state: DiplomacyState, a: FactionId, b: FactionId): Treaty[];
  startWar(state: DiplomacyState, a: FactionId, b: FactionId, tick: number, casusBelli: string): Relation;
  setCeasefire(state: DiplomacyState, a: FactionId, b: FactionId, untilTick: number, tick: number): Relation;
  lapseCeasefire(state: DiplomacyState, a: FactionId, b: FactionId, tick: number): Relation;
  signPeace(state: DiplomacyState, a: FactionId, b: FactionId, terms: ProposalTerm[], tick: number): TreatyResult;
  terminate(state: DiplomacyState, treatyId: string, tick: number, reason: string): Treaty | null;
  terminateAlliances(state: DiplomacyState, faction: FactionId, tick: number): Treaty[];
  expire(state: DiplomacyState, tick: number): ExpireResult;
}

export interface CasusBelliCondition {
  grievance?: { types: string[]; min: number };
  resourceDeficit?: { resource: string; actorBelow: number; targetAtLeast: number };
  requiresStatus?: RelationStatus[];
  requiresTreatyObligation?: string;
}

export interface CasusBelliRule {
  id: string;
  label: string;
  /** Empty condition = always available (an undeclared attack, priced by reputation). */
  condition: CasusBelliCondition;
  /** Positive points removed from the declarer's reputation. */
  reputationCost: number;
  /** Added to attacker strength and subtracted on defeat; may be negative. */
  legitimacy: number;
}

export interface CombatRules {
  attackFactor: number;
  defenseFactor: number;
  moraleFactor: number;
  randomSwing: number;
  casualtyFraction: number;
  warScorePerWin: number;
  warScorePerLoss: number;
  moraleGain: number;
  moraleLoss: number;
  exhaustionPerBattle: number;
  exhaustionPerTurn: number;
  forcedCeasefireAt: number;
  maxWarScore: number;
  minArmyToAttack: number;
}

export interface PeaceEffectRule {
  /** Engine primitive: reparations | transfer_territory | demilitarize | release_alliance. */
  type: string;
  resource?: string;
  fraction?: number;
  amount?: number;
  /** Role names resolved against the war's winner/loser/proposer. */
  payer?: string;
  beneficiary?: string;
  from?: string;
  to?: string;
  faction?: string;
}

export interface PeaceTermRule {
  id: string;
  label: string;
  /** Minimum war score the proposer must hold for this term to be offerable. */
  minWarScore: number;
  maxWarScore: number | null;
  effects: PeaceEffectRule[];
}

export interface WarRules {
  combat: CombatRules;
  casusBelli: CasusBelliRule[];
  peaceTerms: PeaceTermRule[];
}

export interface War {
  id: string;
  attacker: FactionId;
  defender: FactionId;
  startedTick: number;
  /** Positive = attacker advantage, negative = defender advantage. */
  score: number;
  battles: number;
  status: WarStatus;
  casusBelli: string;
  legitimacy: number;
  lastBattleTick: number;
}

export interface WarState {
  wars: War[];
  nextWarId: number;
}

export interface CasusBelliContext {
  actor: Faction;
  target: Faction;
  status: RelationStatus;
  grievances: Grievance[];
  treatyObligation: string | null;
}

export interface CasusBelliValidation {
  ok: boolean;
  rule: CasusBelliRule | null;
  reason: string;
}

export interface BattleResult {
  ok: boolean;
  reason: string;
  warId: string;
  winner: "attacker" | "defender" | "";
  ratio: number;
  attackerLoss: number;
  defenderLoss: number;
  warScore: number;
  warScoreDelta: number;
  attackerMoraleDelta: number;
  defenderMoraleDelta: number;
  attackerExhaustionDelta: number;
  defenderExhaustionDelta: number;
}

export interface SettlementEffect {
  type: string;
  from?: FactionId;
  to?: FactionId;
  resource?: string;
  amount?: number;
  fraction?: number;
  faction?: FactionId;
}

export interface PeaceSettlement {
  ok: boolean;
  reason: string;
  warId: string;
  proposer: FactionId;
  winner: FactionId;
  loser: FactionId;
  terms: string[];
  effects: SettlementEffect[];
  warScore: number;
}

export interface PeaceValidation {
  ok: boolean;
  reason: string;
}

export interface OpenWarInput {
  attacker: FactionId;
  defender: FactionId;
  tick: number;
  casusBelli: string;
  legitimacy: number;
}

export interface WarApi {
  createState(): WarState;
  open(state: WarState, input: OpenWarInput): War;
  find(state: WarState, a: FactionId, b: FactionId): War | null;
  byId(state: WarState, id: string): War | null;
  active(state: WarState): War[];
  validateDeclaration(
    ctx: CasusBelliContext,
    rules: WarRules,
    requestedId?: string,
  ): CasusBelliValidation;
  resolveBattle(
    state: WarState,
    world: CivWorld,
    warId: string,
    rules: WarRules,
    rng: Rng,
  ): BattleResult;
  warScoreFor(state: WarState, war: War, faction: FactionId): number;
  termsFor(state: WarState, war: War, rules: WarRules, proposer: FactionId): PeaceTermRule[];
  validatePeace(
    state: WarState,
    warId: string,
    terms: ProposalTerm[],
    rules: WarRules,
    world: CivWorld,
    proposer: FactionId,
  ): PeaceValidation;
  settlePeace(
    state: WarState,
    warId: string,
    terms: ProposalTerm[],
    rules: WarRules,
    world: CivWorld,
    proposer: FactionId,
  ): PeaceSettlement;
  setStatus(state: WarState, warId: string, status: WarStatus): War | null;
}

export type ChannelKind = "council" | "envoy" | "bloc";
export type MessageKind = "speech" | "proposal" | "response" | "notice";

export interface BlocEvent {
  tick: number;
  type: "create" | "join" | "leave" | "expel";
  by: FactionId;
  member: FactionId;
}

export interface Bloc {
  id: string;
  name: string;
  founder: FactionId;
  /** Current members, authored order. */
  members: FactionId[];
  events: BlocEvent[];
}

export interface ChannelMessage {
  id: string;
  tick: number;
  channel: ChannelKind;
  from: FactionId;
  /** Envoy recipient; null for council and bloc messages. */
  to: FactionId | null;
  blocId: string | null;
  kind: MessageKind;
  text: string;
  refs: string[];
  /** Snapshot of who could read it at post time. New bloc members never gain history. */
  audience: FactionId[];
  proposalId: string | null;
}

export interface ChannelState {
  messages: ChannelMessage[];
  blocs: Record<string, Bloc>;
  nextMessageId: number;
  nextBlocId: number;
}

export interface ChannelRules {
  maxTextLength: number;
  maxRefs: number;
  maxRefLength: number;
  requireRefsFor: MessageKind[];
  maxBlocMembers: number;
}

export interface PostInput {
  tick: number;
  from: FactionId;
  channel: ChannelKind;
  to?: FactionId;
  blocId?: string;
  kind: MessageKind;
  text: string;
  refs?: string[];
  proposalId?: string;
}

export interface PostResult {
  ok: boolean;
  error: string;
  message: ChannelMessage | null;
}

export interface CreateBlocInput {
  tick: number;
  founder: FactionId;
  name: string;
  members: FactionId[];
}

export interface BlocResult {
  ok: boolean;
  error: string;
  bloc: Bloc | null;
}

export interface ChannelProjection {
  faction: FactionId;
  messages: ChannelMessage[];
  /** How many messages exist but are not visible to this faction (content never leaks). */
  omitted: number;
}

export interface ChannelsPorts {
  exists(id: FactionId): boolean;
}

export interface ChannelsApi {
  createState(): ChannelState;
  post(state: ChannelState, input: PostInput, rules: ChannelRules, factionIds: FactionId[]): PostResult;
  createBloc(state: ChannelState, input: CreateBlocInput, rules: ChannelRules): BlocResult;
  invite(state: ChannelState, blocId: string, by: FactionId, members: FactionId[], tick: number, rules: ChannelRules): BlocResult;
  leave(state: ChannelState, blocId: string, faction: FactionId, tick: number): BlocResult;
  expel(state: ChannelState, blocId: string, by: FactionId, member: FactionId, tick: number): BlocResult;
  projectFor(state: ChannelState, faction: FactionId): ChannelProjection;
  publicLog(state: ChannelState): ChannelMessage[];
  message(state: ChannelState, id: string): ChannelMessage | null;
  visibleTo(message: ChannelMessage, faction: FactionId): boolean;
}

/** One model-authored intent. Text is data; the engine never executes it. */
export type CivIntent =
  | { type: "council_speech"; faction: FactionId; text: string; refs?: string[] }
  | { type: "envoy"; faction: FactionId; to: FactionId; text: string; refs?: string[] }
  | { type: "bloc_create"; faction: FactionId; name: string; members: FactionId[] }
  | { type: "bloc_invite"; faction: FactionId; blocId: string; members: FactionId[] }
  | { type: "bloc_leave"; faction: FactionId; blocId: string }
  | { type: "bloc_expel"; faction: FactionId; blocId: string; member: FactionId }
  | { type: "bloc_message"; faction: FactionId; blocId: string; text: string; refs?: string[] }
  | {
      type: "propose";
      faction: FactionId;
      to: FactionId;
      kind: string;
      terms?: ProposalTerm[];
      channel?: "council" | "envoy";
      refs?: string[];
    }
  | {
      type: "respond";
      faction: FactionId;
      proposalId: string;
      accept: boolean;
      reason?: string;
      channel?: "council" | "envoy";
      refs?: string[];
    }
  | { type: "declare_war"; faction: FactionId; to: FactionId; casusBelli?: string; refs?: string[] }
  | { type: "attack"; faction: FactionId; to: FactionId }
  | {
      type: "offer_peace";
      faction: FactionId;
      to: FactionId;
      terms: ProposalTerm[];
      channel?: "council" | "envoy";
      refs?: string[];
    }
  | { type: "recruit"; faction: FactionId; amount: number };

export interface CivRules {
  id: string;
  schemaVersion: 1;
  economy: EconomyRules;
  diplomacy: DiplomacyRules;
  war: WarRules;
  channels: ChannelRules;
}

export interface CivEvent {
  type: string;
  tick: number;
  faction?: FactionId;
  to?: FactionId;
  id?: string;
  ok?: boolean;
  reason?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface RejectedIntent {
  type: string;
  faction: FactionId;
  reason: string;
}

export interface TickResult {
  tick: number;
  events: CivEvent[];
  rejected: RejectedIntent[];
  hash: number;
}

export interface ScenarioSeed {
  relations?: { a: FactionId; b: FactionId; status?: RelationStatus; trust?: number }[];
  grievances?: { by: FactionId; against: FactionId; type: string; weight: number }[];
  treaties?: { kind: string; parties: FactionId[]; signedTick?: number }[];
}

export interface EngineView {
  world: CivWorld;
  diplomacy: DiplomacyState;
  war: WarState;
  channels: ChannelState;
}

export interface IntentApi {
  parse(raw: unknown, world: CivWorld, state: StateApi): SubmitResult;
  phaseOf(type: string): number;
}

export interface ActionDeps {
  state: StateApi;
  world: CivWorld;
  rules: CivRules;
  diplomacy: DiplomacyApi;
  war: WarApi;
  channels: ChannelsApi;
  diploState: DiplomacyState;
  warState: WarState;
  channelState: ChannelState;
}

export interface ActionApi {
  resolve(intent: CivIntent, tick: number, events: CivEvent[], rejected: RejectedIntent[]): void;
  applySettlement(settlement: PeaceSettlement, tick: number, events: CivEvent[]): void;
}

export interface EngineConfig {
  seed: number;
  factions: FactionSeed[];
  rules: CivRules;
  clock?: Partial<Clock>;
  state: StateApi;
  /** Stateless intent parser/phase table; injected so tick keeps no runtime imports. */
  intents: IntentApi;
  /** Factory so the engine can hand the action handlers its world and module instances. */
  actions: (deps: ActionDeps) => ActionApi;
  /** Factory so the engine can hand the module its rule slice and an `exists` port bound to its world. */
  diplomacy: (rules: DiplomacyRules, ports: DiplomacyPorts) => DiplomacyApi;
  war: WarApi;
  channels: (ports: ChannelsPorts) => ChannelsApi;
  scenario?: ScenarioSeed;
}

export interface SubmitResult {
  ok: boolean;
  error: string;
  intent: CivIntent | null;
}

export interface CivEngine {
  submit(raw: unknown): SubmitResult;
  runTick(): TickResult;
  hash(): number;
  dump(): string;
  inspect(): EngineView;
}

export interface RulesParseResult {
  ok: boolean;
  errors: string[];
  rules: CivRules | null;
}
