// Classic binding for services/agent/workflow-runner.ts. The executor reads no global: the schema
// port resolves window.__workflowSchema on every call, so a schema loaded after this product is still
// visible to the next run. This file only publishes the frozen window.__workflowRunner namespace.
(function () {
  "use strict";
  if (window.__workflowRunner) return;
  window.__workflowRunner = createWorkflowRunner(function () {
    return window.__workflowSchema || null;
  });
})();
