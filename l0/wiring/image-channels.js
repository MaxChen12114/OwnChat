// Browser adapter, appended by l0/emit.mjs. Engine: services/image/channels.ts; this file owns the
// frozen global name, the three localStorage keys and the wall clock.
//
// Must load before image-common: that module reads the active channel while it initialises, so a
// late registration would leave the first generation on the default provider.
(function () {
  if (window.imageChannelsSvc) return;

  var channels = createChannels({
    storage: {
      getItem: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
      setItem: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} },
      removeItem: function (k) { try { window.localStorage.removeItem(k); } catch (e) {} }
    },
    now: function () { return Date.now(); }
  });

  window.imageChannelsSvc = {
    list: channels.list, get: channels.get, getActive: channels.getActive,
    activeId: channels.activeId, setActive: channels.setActive,
    save: channels.save, create: channels.create, remove: channels.remove,
    hasEdit: channels.hasEdit, models: channels.models, onChange: channels.onChange,
    DEFAULT_GITEE: channels.DEFAULT_GITEE
  };
})();
