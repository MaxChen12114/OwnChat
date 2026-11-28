// Classic binding for services/agent/workflow-schema.ts. Every validation and interpolation rule
// lives in the service; this file only publishes the frozen window.__workflowSchema namespace so
// pack authors and the runner's per-call port both see the same object.
(function () {
  "use strict";
  if (window.__workflowSchema) return;
  window.__workflowSchema = createWorkflowSchema();
})();
