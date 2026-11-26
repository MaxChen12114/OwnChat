// Browser wiring for services/chat/compact.ts: the context instance, the summarize-body builder,
// the summary table, the event archive and the HTTP call are injected here; the app owns the DOM
// row removal and the turn-local persist closure through the call snapshot.
//
// The archive port is late-bound: the events service may not have answered a single call yet, but
// it is loaded before this script and resolves its DbPort on first use. When it is absent (an old
// shell build) the compactor falls back to the legacy save/splice path without a seq anchor.
(function () {
  if (window.chatCompactSvc) return;
  function defaultRequest(body) {
    return fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    });
  }
  function archive(input) {
    var svc = window.sessionEventsSvc;
    if (!svc || typeof svc.archiveCompact !== "function") return Promise.resolve(null);
    return svc.archiveCompact(input.convId, input.messages, input.summary);
  }
  window.chatCompactSvc = {
    create: function (host) {
      var h = host || {};
      var ctx = h.context;
      if (!ctx) throw new Error("chat-compact: 缺少 context 实例（压缩配置/计划会静默丢失，所以必须显式给）");
      return createCompactor({
        config: function () { return ctx.compactConfig(); },
        historyEnabled: function () { return !!h.historyEnabled(); },
        shouldCompact: function (length, trigger) { return ctx.shouldCompact(length, trigger); },
        plan: function (session, keep) { return ctx.planCompact(session, keep); },
        readSummary: function (payload) { return ctx.readSummary(payload); },
        summarizeBody: function (snapshot) { return window.__request.summarizeBody(snapshot); },
        request: h.request || defaultRequest,
        saveSummary: function (convId, text) {
          if (window.convSummarySvc) window.convSummarySvc.save(convId, text);
          try { window.localStorage.removeItem("cfw_summary_chip_hidden_v1"); } catch (e) {}
        },
        applySummary: function (text) { if (h.applySummary) h.applySummary(text); },
        renderChip: function () { if (h.renderChip) h.renderChip(); },
        busy: function (on) { if (h.busy) h.busy(on); },
        warn: h.warn || function (message, error) {
          try { console.warn(message, error); } catch (e) {}
        },
        archive: archive,
      });
    },
  };
})();
