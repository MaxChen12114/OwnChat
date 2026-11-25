// Browser adapter, appended by l0/emit.mjs. Engine: services/sync/chat-events.ts.
//
// The engine is pure and knows nothing about globals; this file only publishes it under the frozen
// name that the realtime channel and the session tests read. Keep the object shape exact — callers
// destructure members (`MESSAGE_ID_RE`, `applyReplace`, …) instead of holding the object.
(function () {
  "use strict";

  window.__chatEvents = {
    MAX_EVENT_BYTES: MAX_EVENT_BYTES,
    MAX_BATCH: MAX_BATCH,
    MESSAGE_ID_RE: MESSAGE_ID_RE,
    EVENT_ID_RE: EVENT_ID_RE,
    CONV_ID_RE: CONV_ID_RE,
    hash32: hash32,
    newMessageId: newMessageId,
    newEventId: newEventId,
    isMessageId: isMessageId,
    isValidMessage: isValidMessage,
    isValidConvId: isValidConvId,
    isValidEventType: isValidEventType,
    ensureMessageIds: ensureMessageIds,
    diffMessages: diffMessages,
    applyAppend: applyAppend,
    applyReplace: applyReplace,
    eventBytes: eventBytes,
    eventFitsLimit: eventFitsLimit,
  };
})();
