// Browser wiring for services/platform/deployer.ts: publish the executor under a non-`__` name.
// The executor is stateless per call; ports (HTTP / command / journal / handoff) arrive from the
// settings card, so nothing here touches the network or storage.
(function (g) {
  "use strict";
  if (g.deployerSvc) return;
  g.deployerSvc = createDeployer();
})(window);
