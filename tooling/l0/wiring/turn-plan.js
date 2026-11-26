// Browser wiring for services/chat/turn-plan.ts: the pure send/cancel/retry decisions.
//
// The service takes snapshots, never page state, so this wiring is a name binding and nothing else.
// `sendOne` / `sendOneAgent` read the plan once per send and then execute it; the threshold tables
// and the retry budget stay with their owners (context.ts / retry.ts) and are copied in as inputs.
(function () {
  if (window.turnPlanSvc && window.turnPlanSvc.v === 1) return;
  window.turnPlanSvc = {
    v: 1,
    planSend: planSend,
    planCancel: planCancel,
    planRetry: planRetry,
    compactGateOf: compactGateOf,
  };
})();
