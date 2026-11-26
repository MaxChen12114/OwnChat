// Browser wiring for services/chat/model-caps.ts: a pure bridge used by app.js before it builds a
// chat request. The storage read and the model id stay in the caller.
(function (global) {
  "use strict";
  if (global.modelCaps) return;
  global.modelCaps = {
    PC_VISION_KEY: PC_VISION_KEY,
    pcVisionOn: pcVisionOn,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
