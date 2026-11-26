// Browser adapter, appended by l0/emit.mjs. Engine: services/image/chat.ts; this file owns the
// frozen global name and the one load-order dependency on the shared image pipeline.
//
// The pipeline module is captured once, exactly as the classic script did: everything below it in
// the boot list depends on this file having run after `imageCommonSvc`, and reporting that failure
// as a console error (and not defining the global) is what makes the text side fall back to mock
// images instead of throwing on every send.
(function () {
  if (window.chatImageSvc) return;
  if (!window.imageCommonSvc) {
    console.error("[image-chat] 缺少 image-common.js，请确认其在本文件之前加载");
    return;
  }

  var svc = createChatImage({
    ic: window.imageCommonSvc,
    character: function () {
      try { return window.characterSvc || null; } catch (e) { return null; }
    }
  });

  window.chatImageSvc = {
    sendPhoto: svc.sendPhoto,
    editImage: svc.editImage,
    setBaseImage: svc.setBaseImage,
    getBaseImage: svc.getBaseImage,
    clearBaseImage: svc.clearBaseImage
  };
})();
