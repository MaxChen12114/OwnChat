// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the existing window contract.
// Line for line the old pipeline.js: the bridge functions are captured once at the top of the IIFE
// and handed to the service, not re-read on every trace — so `stripFns` still holds the original
// function references and reference equality survives.
// Every bridge is spelled out with the `window.` prefix: an alias drops the contract count to zero.
(function () {
  if (window.pipelineSvc) return;

  var ports = {
    textFormat: {
      stripThinkBlocks: window.textFormatSvc.stripThinkBlocks,
      splitJailbreakPrefix: window.textFormatSvc.splitJailbreakPrefix,
      stripResidualMarkup: window.textFormatSvc.stripResidualMarkup,
      stripVoiceTags: window.textFormatSvc.stripVoiceTags,
      stripChoiceSignals: window.textFormatSvc.stripChoiceSignals,
      stripWechatActions: window.textFormatSvc.stripWechatActions,
      autoSplitWechat: window.textFormatSvc.autoSplitWechat,
      diffPrefixSuffix: window.textFormatSvc.diffPrefixSuffix,
    },
    reasoning: {
      extractThinkText: window.__reasoning.extractThinkText,
    },
  };

  var pipeline = createPipeline(ports);
  window.pipelineSvc = {
    stripFns: pipeline.stripFns,
    trace: pipeline.trace,
  };
})();
