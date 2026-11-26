// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/chat/retry.ts; this file only binds the name and guards
// against a second install.
(function () {
  if (window.__retry && window.__retry.v === 1) return;
  window.__retry = {
    v: 1,
    cfg: cfg,
    tag: tag,
    classify: classify,
    isRetryable: isRetryable,
    budget: budget,
    delay: delay,
    whyText: whyText,
    finalError: finalError,
  };
})();
