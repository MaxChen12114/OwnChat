// Browser wiring for services/chat/turn-events.ts: the five formal turn events and the recorder.
//
// `create({sink})` builds a recorder; the sink is the T3-D event service, resolved per call so a
// page whose DB port is not ready yet still records the trace locally. `feed`/`end` are fail-soft by
// contract — a broken log must never break a turn — so this wiring has no error policy of its own.
(function () {
  if (window.turnEventsSvc && window.turnEventsSvc.v === 1) return;
  window.turnEventsSvc = {
    v: 1,
    create: createTurnRecorder,
    validateTraceEvent: validateTraceEvent,
    traceEventOf: traceEventOf,
    sessionInputOf: sessionInputOf,
    TRACE_TYPES: TRACE_TYPES,
  };
})();
