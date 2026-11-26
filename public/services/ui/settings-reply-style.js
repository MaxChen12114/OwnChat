(function () {
/**
 * Reply-style setting: the single home for `cfw_reply_style_v1`, read by three consumers —
 * services/chat/request.ts (main path), services/agent/peer-calls.ts (peer calls) and
 * services/conv/app-mode.ts (work-mode gate).
 *
 * All four sites used to spell out the same `read(key) || "default"` independently, and none of them
 * validated the value. A dirty localStorage entry (or a bad write from an older build) would be
 * passed straight through to the prompt layer instead of falling back. The whitelist, the default
 * and the safe read now live here once; an equivalence lock pins each consumer's read to this rule.
 *
 * The `isWork()` gate that forces "default" in work mode is a higher-level decision and stays in
 * app-mode.ts — this module owns only "which style is legal and what an absent/dirty value means".
 *
 * Zero window, zero casts: storage arrives through {@link ReplyStylePorts}, and the wiring owns the
 * try/catch around localStorage.
 * @module services/ui/settings-reply-style
 */

const REPLY_STYLE_KEY = "cfw_reply_style_v1";
                                                          
const REPLY_STYLES                        = ["default", "wechat", "verbose"];

                                  
                                      
                                            
 

                                
                                                                                  
                     
                                                                              
                                    
                                                           
                                  
 

/** Legal values only; everything else — including a missing key — is "default". */
function normalizeReplyStyle(v         )             {
  const s = typeof v === "string" ? v : "";
  return s === "wechat" || s === "verbose" ? s : "default";
}

function createSettingsReplyStyle(ports                 )                {
  return {
    read: () => {
      let raw                = null;
      try {
        raw = ports.getItem(REPLY_STYLE_KEY);
      } catch (e) {
        return "default";
      }
      return normalizeReplyStyle(raw);
    },
    write: (value) => {
      const style = normalizeReplyStyle(value);
      try {
        ports.setItem(REPLY_STYLE_KEY, style);
      } catch (e) {
      }
      return style;
    },
    styles: () => REPLY_STYLES,
  };
}

// Browser wiring for services/ui/settings-reply-style.ts: localStorage as the injected port and
// the non-`__` global. The three-value whitelist and default live in the emitted service and are
// shared with chat/request, peer-calls and app-mode via an equivalence lock. The <select> DOM stays
// in the settings card.
(function () {
  window.settingsReplyStyle = createSettingsReplyStyle({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  });
})();

globalThis.REPLY_STYLE_KEY = REPLY_STYLE_KEY;
globalThis.REPLY_STYLES = REPLY_STYLES;
globalThis.normalizeReplyStyle = normalizeReplyStyle;
globalThis.createSettingsReplyStyle = createSettingsReplyStyle;
})();
