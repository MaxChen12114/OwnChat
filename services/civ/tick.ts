/**
 * The tick orchestrator: one turn is collect -> validate -> resolve -> account -> trace.
 *
 * Ordering is part of the contract, not an accident:
 *   1. clock advance and economy (production, upkeep, recruitment happens later from intents);
 *   2. expiry of proposals, treaties, grievances and ceasefires;
 *   3. intents in fixed phases: communications -> proposals/responses -> war -> recruit;
 *   4. end-of-turn bookkeeping (war exhaustion, burnout ceasefire, reputation decay).
 *
 * The parser (`intent`) and the per-action handlers (`actions`) are injected as values, not imported:
 * each service file stays independently loadable by `l0/load-service.mjs`, and the orchestrator keeps
 * only ordering, bookkeeping and the trace. Every random draw is inside a battle; the trace hash is a
 * canonical JSON digest of the whole engine state.
 *
 * @module services/civ/tick
 */

import type {
  ChannelsApi,
  ChannelState,
  CivEngine,
  CivEvent,
  CivIntent,
  CivRules,
  CivWorld,
  DiplomacyApi,
  DiplomacyState,
  EngineConfig,
  EngineView,
  FactionId,
  RejectedIntent,
  SubmitResult,
  TickResult,
  WarApi,
  WarState,
} from "./types";

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

export function createEngine(config: EngineConfig): CivEngine {
  const state = config.state;
  const world = state.createWorld({ seed: config.seed, factions: config.factions, clock: config.clock });
  const exists = (id: FactionId): boolean => state.faction(world, id) !== null;
  const rules: CivRules = config.rules;
  const diplomacy: DiplomacyApi = config.diplomacy(rules.diplomacy, { exists });
  const channels: ChannelsApi = config.channels({ exists });
  const war: WarApi = config.war;
  const diploState: DiplomacyState = diplomacy.createState();
  const warState: WarState = war.createState();
  const channelState: ChannelState = channels.createState();
  const actions = config.actions({
    state,
    world,
    rules,
    diplomacy,
    war,
    channels,
    diploState,
    warState,
    channelState,
  });
  const pending: CivIntent[] = [];

  if (config.scenario) {
    const scenario = config.scenario;
    if (scenario.relations) {
      for (const item of scenario.relations) {
        const rel = diplomacy.ensure(diploState, item.a, item.b, 0);
        if (item.status !== undefined) rel.status = item.status;
        if (item.trust !== undefined) rel.trust = clamp(item.trust, rules.diplomacy.trustMin, rules.diplomacy.trustMax);
      }
    }
    if (scenario.treaties) {
      for (const item of scenario.treaties) {
        const tick = item.signedTick === undefined ? 0 : item.signedTick;
        const signed = diplomacy.signTreaty(
          diploState,
          { kind: item.kind, parties: item.parties, signedTick: tick },
          tick,
        );
        if (!signed.ok) throw new Error("scenario 条约无效: " + signed.error);
      }
    }
    if (scenario.grievances) {
      for (const item of scenario.grievances) {
        diplomacy.addGrievance(
          diploState,
          { by: item.by, against: item.against, type: item.type, weight: item.weight },
          0,
        );
      }
    }
  }

  function endTurn(tick: number, events: CivEvent[], expiredCeasefires: { a: FactionId; b: FactionId }[]): void {
    const atWar: string[] = [];
    for (const item of war.active(warState)) {
      if (item.status !== "active") continue;
      atWar.push(item.attacker, item.defender);
      state.adjust(world, item.attacker, { warExhaustion: rules.war.combat.exhaustionPerTurn });
      state.adjust(world, item.defender, { warExhaustion: rules.war.combat.exhaustionPerTurn });
      const attacker = state.faction(world, item.attacker);
      const defender = state.faction(world, item.defender);
      if (attacker === null || defender === null) continue;
      if (
        attacker.warExhaustion >= rules.war.combat.forcedCeasefireAt ||
        defender.warExhaustion >= rules.war.combat.forcedCeasefireAt
      ) {
        war.setStatus(warState, item.id, "ceasefire");
        diplomacy.setCeasefire(
          diploState,
          item.attacker,
          item.defender,
          tick + rules.diplomacy.ceasefireTicks,
          tick,
        );
        events.push({
          type: "war_burnout",
          tick,
          faction: item.attacker,
          to: item.defender,
          id: item.id,
          data: {
            attackerExhaustion: attacker.warExhaustion,
            defenderExhaustion: defender.warExhaustion,
            forcedCeasefireAt: rules.war.combat.forcedCeasefireAt,
          },
        });
      }
    }
    for (const item of state.factions(world)) {
      if (atWar.indexOf(item.id) >= 0) continue;
      if (rules.economy.warExhaustionDecay > 0) {
        state.adjust(world, item.id, { warExhaustion: -rules.economy.warExhaustionDecay });
      }
    }
    if (rules.economy.reputationDecayRate > 0) {
      for (const item of state.factions(world)) {
        const delta = (rules.economy.reputationAnchor - item.reputation) * rules.economy.reputationDecayRate;
        if (Math.abs(delta) > 0.000001) state.adjust(world, item.id, { reputation: delta });
      }
    }
    for (const pair of expiredCeasefires) {
      const rel = diplomacy.relation(diploState, pair.a, pair.b);
      if (rel === null || rel.status !== "ceasefire") continue;
      const active = war.find(warState, pair.a, pair.b);
      if (active === null) {
        diplomacy.lapseCeasefire(diploState, pair.a, pair.b, tick);
        events.push({ type: "ceasefire_lapsed", tick, faction: pair.a, to: pair.b });
        continue;
      }
      war.setStatus(warState, active.id, "active");
      diplomacy.startWar(diploState, pair.a, pair.b, tick, "ceasefire_expired");
      events.push({
        type: "war_resumed",
        tick,
        faction: pair.a,
        to: pair.b,
        id: active.id,
        reason: "ceasefire_expired",
      });
    }
  }

  function runTick(): TickResult {
    const tick = state.advance(world).tick;
    const events: CivEvent[] = [];
    const rejected: RejectedIntent[] = [];
    for (const result of state.produce(world, rules.economy)) {
      events.push({
        type: "production",
        tick,
        faction: result.faction,
        data: {
          resources: result.resources,
          population: result.population,
          morale: result.morale,
          shortage: result.shortage,
        },
      });
    }
    const expired = diplomacy.expire(diploState, tick);
    for (const proposal of expired.proposals) {
      events.push({ type: "proposal_expired", tick, faction: proposal.from, to: proposal.to, id: proposal.id });
    }
    for (const treaty of expired.treaties) {
      events.push({ type: "treaty_expired", tick, id: treaty.id, data: { kind: treaty.kind } });
    }
    const batch = pending.splice(0, pending.length);
    const orderIndex: Record<FactionId, number> = {};
    world.order.forEach((id, index) => {
      orderIndex[id] = index;
    });
    const ordered = batch.map((intent, index) => ({ intent, index }));
    ordered.sort((left, right) => {
      const phase = config.intents.phaseOf(left.intent.type) - config.intents.phaseOf(right.intent.type);
      if (phase !== 0) return phase;
      const leftOrder = orderIndex[left.intent.faction] === undefined ? 999 : orderIndex[left.intent.faction];
      const rightOrder = orderIndex[right.intent.faction] === undefined ? 999 : orderIndex[right.intent.faction];
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.index - right.index;
    });
    for (const entry of ordered) actions.resolve(entry.intent, tick, events, rejected);
    endTurn(tick, events, expired.ceasefires.map((rel) => ({ a: rel.a, b: rel.b })));
    const hash = state.stableHash({
      world,
      diplomacy: diploState,
      war: warState,
      channels: channelState,
    });
    events.push({ type: "tick_end", tick, data: { hash } });
    return { tick, events, rejected, hash };
  }

  function snapshotObject(): EngineView {
    return { world, diplomacy: diploState, war: warState, channels: channelState };
  }

  return {
    submit(raw: unknown): SubmitResult {
      const parsed = config.intents.parse(raw, world, state);
      if (!parsed.ok || parsed.intent === null) return parsed;
      pending.push(parsed.intent);
      return parsed;
    },
    runTick,
    hash(): number {
      return state.stableHash(snapshotObject());
    },
    dump(): string {
      return state.canonicalJSON(snapshotObject());
    },
    inspect(): EngineView {
      return snapshotObject();
    },
  };
}
