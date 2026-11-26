/**
 * Intent handlers: every state-changing action a model can ask for, and nothing else.
 *
 * The tick owns ordering and the trace; this module owns the semantics of one action at a time.
 * Each handler validates gameplay rules, calls the owning module (diplomacy / war / channels) and
 * applies returned effects through `state`. A rejection is an event plus a `RejectedIntent`; it is
 * never a thrown error, because one bad model call must not abort the whole turn.
 *
 * @module services/civ/actions
 */

import type {
  ActionApi,
  ActionDeps,
  CasusBelliContext,
  ChannelKind,
  ChannelsApi,
  ChannelState,
  CivEvent,
  CivIntent,
  CivRules,
  CivWorld,
  DiplomacyApi,
  DiplomacyState,
  FactionId,
  PeaceSettlement,
  Proposal,
  ProposalKindRule,
  ProposalTerm,
  RejectedIntent,
  ResourceMap,
  StateApi,
  Treaty,
  TreatyKindRule,
  WarApi,
  WarState,
} from "./types";

const ROUND_SCALE = 10000;

function round4(value: number): number {
  return Math.round(value * ROUND_SCALE) / ROUND_SCALE;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

function findProposalRule(rules: CivRules, id: string): ProposalKindRule | null {
  for (const rule of rules.diplomacy.proposalKinds) if (rule.id === id) return rule;
  return null;
}

function findTreatyRule(rules: CivRules, id: string): TreatyKindRule | null {
  for (const rule of rules.diplomacy.treatyKinds) if (rule.id === id) return rule;
  return null;
}

function findProposal(state: DiplomacyState, id: string): Proposal | null {
  for (const proposal of state.proposals) if (proposal.id === id) return proposal;
  return null;
}

export function createActions(deps: ActionDeps): ActionApi {
  const state: StateApi = deps.state;
  const world: CivWorld = deps.world;
  const rules: CivRules = deps.rules;
  const diplomacy: DiplomacyApi = deps.diplomacy;
  const war: WarApi = deps.war;
  const channels: ChannelsApi = deps.channels;
  const diploState: DiplomacyState = deps.diploState;
  const warState: WarState = deps.warState;
  const channelState: ChannelState = deps.channelState;

  function reject(
    intent: CivIntent,
    reason: string,
    tick: number,
    events: CivEvent[],
    rejected: RejectedIntent[],
  ): void {
    rejected.push({ type: intent.type, faction: intent.faction, reason });
    events.push({
      type: "intent_rejected",
      tick,
      faction: intent.faction,
      reason,
      data: { intentType: intent.type },
    });
  }

  function post(
    from: FactionId,
    channel: ChannelKind,
    text: string,
    refs: string[],
    tick: number,
    to?: FactionId,
    blocId?: string,
    proposalId?: string,
  ) {
    return channels.post(
      channelState,
      {
        tick,
        from,
        channel,
        to,
        blocId,
        kind: "speech",
        text,
        refs,
        proposalId,
      },
      rules.channels,
      world.order,
    );
  }

  function handleProposal(
    from: FactionId,
    to: FactionId,
    kind: string,
    terms: ProposalTerm[],
    channel: "council" | "envoy",
    refs: string[],
    tick: number,
    events: CivEvent[],
    rejected: RejectedIntent[],
    intentType: string,
  ): void {
    const kindRule = findProposalRule(rules, kind);
    if (kindRule === null) {
      rejected.push({ type: intentType, faction: from, reason: "未知提案类型: " + kind });
      events.push({ type: "intent_rejected", tick, faction: from, reason: "未知提案类型: " + kind });
      return;
    }
    const proposed = diplomacy.propose(diploState, { from, to, kind, terms, messageRefs: refs }, tick);
    if (!proposed.ok || proposed.proposal === null) {
      rejected.push({ type: intentType, faction: from, reason: proposed.error });
      events.push({ type: "intent_rejected", tick, faction: from, reason: proposed.error });
      return;
    }
    const proposal = proposed.proposal;
    if (kindRule.mode === "peace" || kindRule.mode === "ceasefire") {
      const active = war.find(warState, from, to);
      if (active === null) {
        diplomacy.withdraw(diploState, proposal.id, tick);
        const reason = "当前没有可结束的战争";
        rejected.push({ type: intentType, faction: from, reason });
        events.push({ type: "intent_rejected", tick, faction: from, reason });
        return;
      }
      if (kindRule.mode === "peace") {
        const check = war.validatePeace(warState, active.id, terms, rules.war, world, from);
        if (!check.ok) {
          diplomacy.withdraw(diploState, proposal.id, tick);
          rejected.push({ type: intentType, faction: from, reason: check.reason });
          events.push({ type: "intent_rejected", tick, faction: from, reason: check.reason });
          return;
        }
      }
    }
    const text = from + " → " + to + "：提出" + kindRule.label + "（" + proposal.id + "）";
    const posted = channels.post(
      channelState,
      {
        tick,
        from,
        channel,
        to: channel === "envoy" ? to : undefined,
        kind: "proposal",
        text,
        refs: ["proposal:" + proposal.id, ...refs],
        proposalId: proposal.id,
      },
      rules.channels,
      world.order,
    );
    if (!posted.ok || posted.message === null) {
      diplomacy.withdraw(diploState, proposal.id, tick);
      rejected.push({ type: intentType, faction: from, reason: posted.error });
      events.push({ type: "intent_rejected", tick, faction: from, reason: posted.error });
      return;
    }
    proposal.messageRefs.push(posted.message.id);
    events.push({
      type: "proposal_created",
      tick,
      faction: from,
      to,
      id: proposal.id,
      data: { kind, terms: terms.map((term) => term.id), channel, messageId: posted.message.id },
    });
  }

  function applySettlement(settlement: PeaceSettlement, tick: number, events: CivEvent[]): void {
    for (const effect of settlement.effects) {
      if (effect.type === "resources") {
        if (
          effect.from === undefined ||
          effect.to === undefined ||
          effect.resource === undefined ||
          effect.amount === undefined
        ) {
          events.push({ type: "settlement_failed", tick, reason: "资源条款字段不完整" });
          continue;
        }
        const cost: ResourceMap = {};
        cost[effect.resource] = effect.amount;
        if (!state.spend(world, effect.from, cost)) {
          events.push({
            type: "settlement_failed",
            tick,
            faction: effect.from,
            reason: "赔款方资源不足: " + effect.resource,
          });
          continue;
        }
        const gain: ResourceMap = {};
        gain[effect.resource] = effect.amount;
        state.adjust(world, effect.to, { resources: gain });
        events.push({
          type: "settlement_transfer",
          tick,
          faction: effect.from,
          to: effect.to,
          data: { resource: effect.resource, amount: effect.amount },
        });
        continue;
      }
      if (effect.type === "territory") {
        if (effect.from === undefined || effect.to === undefined || effect.amount === undefined) continue;
        state.adjust(world, effect.from, { territory: -effect.amount });
        state.adjust(world, effect.to, { territory: effect.amount });
        events.push({
          type: "settlement_territory",
          tick,
          faction: effect.from,
          to: effect.to,
          data: { amount: effect.amount },
        });
        continue;
      }
      if (effect.type === "demilitarize") {
        if (effect.faction === undefined) continue;
        const target = state.faction(world, effect.faction);
        if (target === null) continue;
        const fraction = effect.fraction === undefined ? 0 : clamp(effect.fraction, 0, 1);
        const loss = round4(target.army * fraction);
        state.adjust(world, target.id, { army: -loss });
        events.push({
          type: "settlement_demilitarize",
          tick,
          faction: target.id,
          data: { amount: loss },
        });
        continue;
      }
      if (effect.type === "release_alliance") {
        if (effect.faction === undefined) continue;
        const ended = diplomacy.terminateAlliances(diploState, effect.faction, tick);
        events.push({
          type: "settlement_release_alliance",
          tick,
          faction: effect.faction,
          data: { treaties: ended.map((treaty) => treaty.id) },
        });
      }
    }
  }

  function handleDeclareWar(
    from: FactionId,
    to: FactionId,
    requestedCasusBelli: string | undefined,
    refs: string[],
    tick: number,
    events: CivEvent[],
    rejected: RejectedIntent[],
    intentType: string,
  ): void {
    const actor = state.faction(world, from);
    const target = state.faction(world, to);
    if (actor === null || target === null) {
      rejected.push({ type: intentType, faction: from, reason: "派系不存在" });
      return;
    }
    const status = diplomacy.status(diploState, from, to);
    if (status === "war") {
      rejected.push({ type: intentType, faction: from, reason: "双方已经在战争中" });
      events.push({ type: "intent_rejected", tick, faction: from, reason: "双方已经在战争中" });
      return;
    }
    if (status === "ceasefire") {
      rejected.push({ type: intentType, faction: from, reason: "停火期内不能宣战" });
      events.push({ type: "intent_rejected", tick, faction: from, reason: "停火期内不能宣战" });
      return;
    }
    const obligation = diplomacy.findObligation(diploState, from, to, "no_attack");
    const ctx: CasusBelliContext = {
      actor,
      target,
      status,
      grievances: diplomacy.grievances(diploState, from, to),
      treatyObligation: obligation === null ? null : "no_attack",
    };
    const validation = war.validateDeclaration(ctx, rules.war, requestedCasusBelli);
    if (!validation.ok || validation.rule === null) {
      rejected.push({ type: intentType, faction: from, reason: validation.reason });
      events.push({ type: "intent_rejected", tick, faction: from, reason: validation.reason });
      return;
    }
    const rule = validation.rule;
    if (rule.reputationCost !== 0) {
      state.adjust(world, from, { reputation: -rule.reputationCost });
      events.push({
        type: "reputation_changed",
        tick,
        faction: from,
        reason: "casus_belli:" + rule.id,
        data: { delta: -rule.reputationCost },
      });
    }
    let breachedTreaty: Treaty | null = null;
    if (obligation !== null) {
      const treatyRule = findTreatyRule(rules, obligation.kind);
      const breachKind = treatyRule === null ? "" : treatyRule.breachOnAttack;
      if (breachKind !== "") {
        const breach = diplomacy.breach(diploState, obligation.id, from, breachKind, tick);
        if (breach.ok) {
          breachedTreaty = breach.treaty;
          if (breach.reputationDelta !== 0) {
            state.adjust(world, from, { reputation: breach.reputationDelta });
          }
          events.push({
            type: "treaty_breached",
            tick,
            faction: from,
            to,
            id: obligation.id,
            reason: breachKind,
            data: { reputationDelta: breach.reputationDelta, grievances: breach.grievances.length },
          });
        }
      }
    }
    diplomacy.startWar(diploState, from, to, tick, rule.id);
    const opened = war.open(warState, {
      attacker: from,
      defender: to,
      tick,
      casusBelli: rule.id,
      legitimacy: rule.legitimacy,
    });
    events.push({
      type: "war_declared",
      tick,
      faction: from,
      to,
      id: opened.id,
      data: {
        casusBelli: rule.id,
        legitimacy: rule.legitimacy,
        breachedTreaty: breachedTreaty === null ? null : breachedTreaty.id,
      },
    });
    const noticeText = from + " 对 " + to + " 宣战（" + rule.label + "）";
    const notice = channels.post(
      channelState,
      {
        tick,
        from,
        channel: "council",
        kind: "notice",
        text: noticeText,
        refs: ["casusbelli:" + rule.id, ...refs],
      },
      rules.channels,
      world.order,
    );
    if (!notice.ok) {
      events.push({ type: "message_failed", tick, faction: from, reason: notice.error });
    }
  }

  function handleAttack(
    from: FactionId,
    to: FactionId,
    tick: number,
    events: CivEvent[],
    rejected: RejectedIntent[],
    intentType: string,
  ): void {
    const active = war.find(warState, from, to);
    if (active === null) {
      rejected.push({ type: intentType, faction: from, reason: "双方不在战争中" });
      events.push({ type: "intent_rejected", tick, faction: from, reason: "双方不在战争中" });
      return;
    }
    if (active.status !== "active") {
      rejected.push({ type: intentType, faction: from, reason: "战争不在交战状态" });
      events.push({ type: "intent_rejected", tick, faction: from, reason: "战争不在交战状态" });
      return;
    }
    if (active.lastBattleTick === tick) {
      rejected.push({ type: intentType, faction: from, reason: "本回合已经打过一场" });
      events.push({ type: "intent_rejected", tick, faction: from, reason: "本回合已经打过一场" });
      return;
    }
    const rng = state.rng(world.seed, "battle", tick, active.id);
    const result = war.resolveBattle(warState, world, active.id, rules.war, rng);
    if (!result.ok) {
      rejected.push({ type: intentType, faction: from, reason: result.reason });
      events.push({ type: "intent_rejected", tick, faction: from, reason: result.reason });
      return;
    }
    state.adjust(world, from, {
      army: -result.attackerLoss,
      morale: result.attackerMoraleDelta,
      warExhaustion: result.attackerExhaustionDelta,
    });
    state.adjust(world, to, {
      army: -result.defenderLoss,
      morale: result.defenderMoraleDelta,
      warExhaustion: result.defenderExhaustionDelta,
    });
    events.push({
      type: "battle",
      tick,
      faction: from,
      to,
      id: active.id,
      data: {
        winner: result.winner,
        ratio: result.ratio,
        attackerLoss: result.attackerLoss,
        defenderLoss: result.defenderLoss,
        warScore: result.warScore,
        warScoreDelta: result.warScoreDelta,
      },
    });
  }

  function handleResponse(
    responder: FactionId,
    proposalId: string,
    accept: boolean,
    reason: string,
    channel: "council" | "envoy",
    refs: string[],
    tick: number,
    events: CivEvent[],
    rejected: RejectedIntent[],
    intentType: string,
  ): void {
    if (accept) {
      const known = findProposal(diploState, proposalId);
      if (known !== null) {
        const candidate = findProposalRule(rules, known.kind);
        if (candidate !== null && (candidate.mode === "peace" || candidate.mode === "ceasefire")) {
          const active = war.find(warState, known.from, known.to);
          if (active === null) {
            rejected.push({ type: intentType, faction: responder, reason: "当前没有可结束的战争" });
            events.push({ type: "intent_rejected", tick, faction: responder, reason: "当前没有可结束的战争" });
            return;
          }
          if (candidate.mode === "peace") {
            const check = war.validatePeace(warState, active.id, known.terms, rules.war, world, known.from);
            if (!check.ok) {
              rejected.push({ type: intentType, faction: responder, reason: check.reason });
              events.push({ type: "intent_rejected", tick, faction: responder, reason: check.reason });
              return;
            }
          }
        }
      }
    }
    const result = diplomacy.respond(diploState, { responder, proposalId, accept, reason }, tick);
    if (!result.ok || result.proposal === null) {
      rejected.push({ type: intentType, faction: responder, reason: result.error });
      events.push({ type: "intent_rejected", tick, faction: responder, reason: result.error });
      return;
    }
    const proposal = result.proposal;
    const kindRule = findProposalRule(rules, proposal.kind);
    events.push({
      type: accept ? "proposal_accepted" : "proposal_rejected",
      tick,
      faction: responder,
      to: proposal.from,
      id: proposal.id,
      data: { kind: proposal.kind },
    });
    if (accept && kindRule !== null) {
      if (kindRule.mode === "treaty" && result.treaty !== null) {
        events.push({
          type: "treaty_signed",
          tick,
          faction: responder,
          to: proposal.from,
          id: result.treaty.id,
          data: { kind: result.treaty.kind, obligations: result.treaty.obligations },
        });
      } else if (kindRule.mode === "ceasefire") {
        const active = war.find(warState, proposal.from, responder);
        if (active !== null) war.setStatus(warState, active.id, "ceasefire");
        events.push({
          type: "ceasefire_started",
          tick,
          faction: responder,
          to: proposal.from,
          id: active === null ? "" : active.id,
        });
      } else if (kindRule.mode === "peace") {
        const active = war.find(warState, proposal.from, responder);
        if (active === null) {
          events.push({ type: "peace_failed", tick, faction: responder, reason: "战争已不存在" });
        } else {
          const check = war.validatePeace(warState, active.id, proposal.terms, rules.war, world, proposal.from);
          if (!check.ok) {
            events.push({ type: "peace_failed", tick, faction: responder, reason: check.reason });
          } else {
            const settlement = war.settlePeace(
              warState,
              active.id,
              proposal.terms,
              rules.war,
              world,
              proposal.from,
            );
            if (!settlement.ok) {
              events.push({ type: "peace_failed", tick, faction: responder, reason: settlement.reason });
            } else {
              applySettlement(settlement, tick, events);
              const peace = diplomacy.signPeace(diploState, proposal.from, responder, proposal.terms, tick);
              events.push({
                type: "peace_settled",
                tick,
                faction: responder,
                to: proposal.from,
                id: active.id,
                data: {
                  terms: settlement.terms,
                  winner: settlement.winner,
                  loser: settlement.loser,
                  warScore: settlement.warScore,
                  treaty: peace.treaty === null ? null : peace.treaty.id,
                },
              });
            }
          }
        }
      }
    }
    const responseText = responder + (accept ? " 接受" : " 拒绝") + " 提案 " + proposalId;
    const posted = channels.post(
      channelState,
      {
        tick,
        from: responder,
        channel,
        to: channel === "envoy" ? proposal.from : undefined,
        kind: "response",
        text: responseText,
        refs: ["proposal:" + proposalId, ...refs],
        proposalId,
      },
      rules.channels,
      world.order,
    );
    if (!posted.ok) {
      events.push({ type: "message_failed", tick, faction: responder, reason: posted.error });
    }
  }

  function handleRecruit(
    from: FactionId,
    amount: number,
    tick: number,
    events: CivEvent[],
    rejected: RejectedIntent[],
    intentType: string,
  ): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      rejected.push({ type: intentType, faction: from, reason: "招募人数必须是正整数" });
      events.push({ type: "intent_rejected", tick, faction: from, reason: "招募人数必须是正整数" });
      return;
    }
    if (amount > rules.economy.maxRecruitPerTurn) {
      const reason = "单回合招募上限 " + rules.economy.maxRecruitPerTurn;
      rejected.push({ type: intentType, faction: from, reason });
      events.push({ type: "intent_rejected", tick, faction: from, reason });
      return;
    }
    const cost: ResourceMap = {};
    for (const key of Object.keys(rules.economy.recruitCostPerSoldier)) {
      cost[key] = rules.economy.recruitCostPerSoldier[key] * amount;
    }
    if (!state.canAfford(world, from, cost)) {
      const reason = "资源不足以招募 " + amount + " 兵";
      rejected.push({ type: intentType, faction: from, reason });
      events.push({ type: "intent_rejected", tick, faction: from, reason });
      return;
    }
    state.spend(world, from, cost);
    state.adjust(world, from, { army: amount });
    events.push({
      type: "recruited",
      tick,
      faction: from,
      data: { amount, cost },
    });
  }

  function resolveIntent(
    intent: CivIntent,
    tick: number,
    events: CivEvent[],
    rejected: RejectedIntent[],
  ): void {
    if (intent.type === "council_speech") {
      const posted = post(intent.faction, "council", intent.text, intent.refs === undefined ? [] : intent.refs, tick);
      if (!posted.ok || posted.message === null) {
        reject(intent, posted.error, tick, events, rejected);
        return;
      }
      events.push({
        type: "council_message",
        tick,
        faction: intent.faction,
        id: posted.message.id,
        text: intent.text,
        data: { refs: posted.message.refs },
      });
      return;
    }
    if (intent.type === "envoy") {
      const posted = post(intent.faction, "envoy", intent.text, intent.refs === undefined ? [] : intent.refs, tick, intent.to);
      if (!posted.ok || posted.message === null) {
        reject(intent, posted.error, tick, events, rejected);
        return;
      }
      diplomacy.contact(diploState, intent.faction, intent.to, tick);
      events.push({
        type: "envoy_message",
        tick,
        faction: intent.faction,
        to: intent.to,
        id: posted.message.id,
        text: intent.text,
        data: { refs: posted.message.refs },
      });
      return;
    }
    if (intent.type === "bloc_create") {
      const created = channels.createBloc(
        channelState,
        { tick, founder: intent.faction, name: intent.name, members: intent.members },
        rules.channels,
      );
      if (!created.ok || created.bloc === null) {
        reject(intent, created.error, tick, events, rejected);
        return;
      }
      events.push({ type: "bloc_created", tick, faction: intent.faction, id: created.bloc.id, data: { name: created.bloc.name, members: created.bloc.members } });
      return;
    }
    if (intent.type === "bloc_invite") {
      const invited = channels.invite(channelState, intent.blocId, intent.faction, intent.members, tick, rules.channels);
      if (!invited.ok || invited.bloc === null) {
        reject(intent, invited.error, tick, events, rejected);
        return;
      }
      events.push({ type: "bloc_invited", tick, faction: intent.faction, id: invited.bloc.id, data: { members: intent.members } });
      return;
    }
    if (intent.type === "bloc_leave") {
      const left = channels.leave(channelState, intent.blocId, intent.faction, tick);
      if (!left.ok || left.bloc === null) {
        reject(intent, left.error, tick, events, rejected);
        return;
      }
      events.push({ type: "bloc_left", tick, faction: intent.faction, id: left.bloc.id });
      return;
    }
    if (intent.type === "bloc_expel") {
      const expelled = channels.expel(channelState, intent.blocId, intent.faction, intent.member, tick);
      if (!expelled.ok || expelled.bloc === null) {
        reject(intent, expelled.error, tick, events, rejected);
        return;
      }
      events.push({ type: "bloc_expelled", tick, faction: intent.faction, to: intent.member, id: expelled.bloc.id });
      return;
    }
    if (intent.type === "bloc_message") {
      const posted = post(
        intent.faction,
        "bloc",
        intent.text,
        intent.refs === undefined ? [] : intent.refs,
        tick,
        undefined,
        intent.blocId,
      );
      if (!posted.ok || posted.message === null) {
        reject(intent, posted.error, tick, events, rejected);
        return;
      }
      events.push({
        type: "bloc_message",
        tick,
        faction: intent.faction,
        id: posted.message.id,
        text: intent.text,
        data: { blocId: intent.blocId, refs: posted.message.refs },
      });
      return;
    }
    if (intent.type === "propose") {
      handleProposal(
        intent.faction,
        intent.to,
        intent.kind,
        intent.terms === undefined ? [] : intent.terms,
        intent.channel === undefined ? "envoy" : intent.channel,
        intent.refs === undefined ? [] : intent.refs,
        tick,
        events,
        rejected,
        intent.type,
      );
      return;
    }
    if (intent.type === "offer_peace") {
      handleProposal(
        intent.faction,
        intent.to,
        "peace",
        intent.terms,
        intent.channel === undefined ? "envoy" : intent.channel,
        intent.refs === undefined ? [] : intent.refs,
        tick,
        events,
        rejected,
        intent.type,
      );
      return;
    }
    if (intent.type === "respond") {
      handleResponse(
        intent.faction,
        intent.proposalId,
        intent.accept,
        intent.reason === undefined ? "" : intent.reason,
        intent.channel === undefined ? "envoy" : intent.channel,
        intent.refs === undefined ? [] : intent.refs,
        tick,
        events,
        rejected,
        intent.type,
      );
      return;
    }
    if (intent.type === "declare_war") {
      handleDeclareWar(
        intent.faction,
        intent.to,
        intent.casusBelli,
        intent.refs === undefined ? [] : intent.refs,
        tick,
        events,
        rejected,
        intent.type,
      );
      return;
    }
    if (intent.type === "attack") {
      handleAttack(intent.faction, intent.to, tick, events, rejected, intent.type);
      return;
    }
    if (intent.type === "recruit") {
      handleRecruit(intent.faction, intent.amount, tick, events, rejected, intent.type);
    }
  }

  return { resolve: resolveIntent, applySettlement };
}
