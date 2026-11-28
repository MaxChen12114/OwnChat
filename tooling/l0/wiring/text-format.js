// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/chat/text-format.ts; this file carries every window bridge
// with the same try/catch shape as the old inline code. Bridges are resolved per call, never
// captured, because the modules behind them load later.
(function () {
  if (window.textFormatSvc) return;
  var ports = {
    storage: {
      getItem: function (key) { return window.localStorage.getItem(key); },
      setItem: function (key, value) { window.localStorage.setItem(key, value); },
    },
    // Scene member names, the equivalent of the old inline `stripSceneSpeakerLabel` block.
    sceneNames: function () {
      var names = [];
      try {
        if (window.multiSvc && window.multiSvc.getSceneCards) {
          names = window.multiSvc.getSceneCards().map(function (c) { return (c && c.name) || ""; }).filter(Boolean);
        }
      } catch (e) {}
      return names;
    },
    // Strip the image-send signal during streaming, as the old inline block did. A missing bridge
    // or a throw returns the text untouched.
    stripPhotoSignal: function (text) {
      try {
        if (window.chatImageTextSvc && window.chatImageTextSvc.stripSignalForDisplay) {
          return window.chatImageTextSvc.stripSignalForDisplay(text);
        }
      } catch (e) {}
      return text;
    },
    // Run the ambient-sound tags, as step ③ of the old finalizeReply did. Null means the bridge is
    // missing, threw, or produced no cleaned text.
    applyAmbientTags: function (text) {
      try {
        var at = window.__ambientTags;
        if (at && typeof at.apply === "function") return at.apply(text) || null;
      } catch (e) {}
      return null;
    },
    // Parse the WeChat image signal, as step ④ of the old finalizeReply did. Whether a non-null
    // scene means anything stays on the service side.
    extractPhotoSignal: function (text) {
      try {
        var cit = window.chatImageTextSvc;
        if (cit && typeof cit.extractSignal === "function") return cit.extractSignal(text) || null;
      } catch (e) {}
      return null;
    },
  };
  var tf = createTextFormat(ports);
  window.textFormatSvc = {
    isJailbreakStripOn: tf.isJailbreakStripOn,
    setJailbreakStripOn: tf.setJailbreakStripOn,
    splitJailbreakPrefix: tf.splitJailbreakPrefix,
    stripJailbreakPrefix: tf.stripJailbreakPrefix,
    stripSceneSpeakerLabel: tf.stripSceneSpeakerLabel,
    stripThinkBlocks: tf.stripThinkBlocks,
    stripPhotoSignalLive: tf.stripPhotoSignalLive,
    stripUnpairedSquareBrackets: tf.stripUnpairedSquareBrackets,
    stripResidualMarkup: tf.stripResidualMarkup,
    stripWechatActions: tf.stripWechatActions,
    autoSplitWechat: tf.autoSplitWechat,
    finalizeReply: tf.finalizeReply,
    splitWechatParts: tf.splitWechatParts,
    stripVoiceTags: tf.stripVoiceTags,
    stripChoiceSignals: tf.stripChoiceSignals,
    diffPrefixSuffix: tf.diffPrefixSuffix,
  };
})();
