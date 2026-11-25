// Browser adapter, appended by l0/emit.mjs. Engine: services/image/quota.ts; this file owns the
// frozen global name, localStorage, the fetch interception, the change event and the settings card.
//
// Two choices are deliberate:
//  - The fetch wrapper charges only after a 2xx response, so a rejected request costs nothing.
//  - renderCard() is called on every emit instead of the card subscribing to the event, because
//    the card may be mounted (or remounted) long after the count changed.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);

  function byId(id) {
    try { return G.document ? G.document.getElementById(id) : null; } catch (e) { return null; }
  }

  function renderCard(snap) {
    var disp = byId("imgQuotaDisplay");
    if (!disp) return;
    var s = snap || quota.snapshot();
    var ratio = s.limit ? s.used / s.limit : 0;
    var color = ratio >= 1 ? "#ff5470" : (ratio >= 0.8 ? "#f80" : "#25c2a0");
    disp.innerHTML =
      '<span style="font-size:22px;font-weight:700;color:' + color + ';">' + s.used + "</span>" +
      '<span style="opacity:.6;"> / ' + s.limit + " 次</span>" +
      '<span style="margin-left:10px;font-size:12px;opacity:.7;">剩余 ' + s.remaining + "</span>";
    var bar = byId("imgQuotaBar");
    if (bar) { bar.style.width = Math.min(100, Math.round(ratio * 100)) + "%"; bar.style.background = color; }
    var lim = byId("imgQuotaLimit");
    if (lim && G.document.activeElement !== lim) lim.value = s.limit;
  }

  var quota = createQuota({
    storage: {
      getItem: function (k) { try { return G.localStorage.getItem(k); } catch (e) { return null; } },
      setItem: function (k, v) { try { G.localStorage.setItem(k, v); } catch (e) {} },
    },
    notify: function (s) {
      try { G.dispatchEvent(new G.CustomEvent("imagequota:changed", { detail: s })); } catch (e) {}
      renderCard(s);
    },
  });

  var rawFetch = G.fetch ? G.fetch.bind(G) : null;
  if (rawFetch) {
    G.fetch = function (input, init) {
      var url = "";
      try { url = (typeof input === "string") ? input : ((input && input.url) || ""); } catch (e) {}
      var charge = 0;
      try { charge = chargeFor(url, init && init.body); } catch (e) { charge = 0; }
      var p = rawFetch(input, init);
      if (charge) {
        p.then(function (res) {
          try { if (res && res.ok) quota.add(charge); } catch (e) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  G.__imageQuota = {
    add: quota.add, getToday: quota.getToday, getLimit: quota.getLimit, setLimit: quota.setLimit,
    getRemaining: quota.getRemaining, reset: quota.reset, onChange: quota.onChange, renderCard: renderCard,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = { chargeFor: chargeFor, dayKey: dayKey, createQuota: createQuota, quota: quota };
  }
})();
