// Browser wiring (injected by l0/emit.mjs): binds the service to the existing window contract.
// Line for line the old pipeline.js: the bridge functions are captured once at the top of the IIFE
// and handed to the service, not re-read on every trace — so `stripFns` still holds the original
// function references and reference equality survives.
// Every bridge is spelled out with the `window.` prefix: an alias drops the contract count to zero.
(function () {
  if (window.__pipeline) return;

  var ports = {
    textFormat: {
      stripThinkBlocks: window.__textFormat.stripThinkBlocks,
      splitJailbreakPrefix: window.__textFormat.splitJailbreakPrefix,
      stripResidualMarkup: window.__textFormat.stripResidualMarkup,
      stripVoiceTags: window.__textFormat.stripVoiceTags,
      stripChoiceSignals: window.__textFormat.stripChoiceSignals,
      stripWechatActions: window.__textFormat.stripWechatActions,
      autoSplitWechat: window.__textFormat.autoSplitWechat,
      diffPrefixSuffix: window.__textFormat.diffPrefixSuffix,
    },
    reasoning: {
      extractThinkText: window.__reasoning.extractThinkText,
    },
  };

  var pipeline = createPipeline(ports);
  window.__pipeline = {
    stripFns: pipeline.stripFns,
    trace: pipeline.trace,
  };
})();
