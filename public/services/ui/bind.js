(function () {
/**
 * Declarative control-binding micro-primitives for settings cards. One call per control replaces
 * the hand-written five-step chain (find the element, reflect the stored value, attach the change
 * listener, write through the service, fall back to raw storage when the service is absent) that
 * every card used to spell out — including its per-control `if (svc) … else …` double paths.
 *
 * Two rules keep this testable despite touching controls: every DOM reach goes through the
 * injected {@link BindPorts} (the wiring passes the real document, tests pass a stub), and the
 * binders never throw on a missing control — they return `null`, because a stale selector must not
 * abort the whole card mount. Port calls are NOT wrapped here: the port is the boundary, and a
 * throwing port is a broken port (same posture as settings-gen-params, whose wiring owns the
 * try/catch around localStorage).
 *
 * Service-vs-fallback is encoded by the caller as the presence of `read`/`write`: the card
 * resolves its service once (`var svc = window.x || null`) and passes `svc ? fn : null`; the
 * binder picks the fallback pair when either service function is missing, skips the initial
 * reflection when the active getter is missing and skips the write when the active setter is
 * missing — degradation never throws.
 *
 * Echo contract: after a change the control is repainted with the effective value, so clamped
 * input visibly snaps back exactly as the hand-written loops did. The number binder echoes its own
 * normalized result on the fallback path and the service `write` return on the service path (the
 * service owns clamping there and must return the effective number).
 * @module services/ui/bind
 */

/** Structural surface of one control; a real input / select / textarea satisfies it. */
                         
                
                   
 

/** DOM port: the only surface the binders touch; the wiring injects the real document wrapper. */
                            
                                                                                               
                                                                
                                                                                              
                                           
 

/** Handle for a bound control; `refresh()` is the old `sync()` shape for external repaints. */
                             
             
                                                                 
                  
 

/** Options of {@link BindApi.bindToggle}: a boolean switch with a service path and a fallback. */
                                 
                                                                                           
              
                                                                                
                               
                                        
                                                                                           
                                      
                                              
                                                                    
                                           
 

/** Options of {@link BindApi.bindNumber}: blank/NaN falls back to `default`, then clamps. */
                                 
              
              
              
                                                                 
                  
                                                       
                                          
                                                                                                     
                              
                                          
                                                                                                
                                            
                                               
                                         
 

/** Options of {@link BindApi.bindText}: the string generalisation for text inputs and selects. */
                               
              
                                                                                        
                              
                                          
                                                                                                     
                                     
                                              
                                         
 

/** The three binders, bound to one port set. Published as a non-`__` global by the wiring. */
                          
                                                                                       
                                                                                       
                                                                                   
 

function parseInt10(raw        )         {
  return parseInt(raw, 10);
}

function clamp(v        , lo        , hi        )         {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Stored text to effective number: parse, `def` on NaN, then clamp into `[lo, hi]`. `null`/missing
 * parses as NaN, so an absent key lands on the default — the exact arithmetic the settings cards'
 * hand-written fallback loops spelled inline.
 */
function normalizeNumber(
  raw                           ,
  def        ,
  lo        ,
  hi        ,
  parse                                  ,
)         {
  const p = typeof parse === "function" ? parse : parseInt10;
  const n = p(raw === null || raw === undefined ? "" : raw);
  return isNaN(n) ? def : clamp(n, lo, hi);
}

/** True only when both halves of the service path arrived; either one missing selects fallback. */
function hasServicePath(
  read         ,
  write         ,
)          {
  return typeof read === "function" && typeof write === "function";
}

/**
 * Create the binder set. The port set is the only IO surface; storage never appears here, because
 * both paths read and write through caller-supplied closures.
 * @param ports - DOM access from the wiring.
 */
function createBind(ports           )          {
  function bindToggle(root         , selector        , opts                )                    {
    const el = ports.querySelector(root, selector);
    if (el === null || el === undefined) return null;
    const service = hasServicePath(opts.read, opts.write);
    const get = service ? opts.read : opts.fallbackGet;
    const set = service ? opts.write : opts.fallbackSet;
    function refresh()       {
      // The contract says `read`/`fallbackGet` return a boolean; anything else reads as off.
      if (typeof get === "function") el.checked = get() === true;
    }
    refresh();
    ports.listen(el, function () {
      const on = el.checked === true;
      if (typeof set === "function") set(on);
      if (typeof opts.onChange === "function") opts.onChange(on);
    });
    return { el: el, refresh: refresh };
  }

  function bindNumber(root         , selector        , opts                )                    {
    const el = ports.querySelector(root, selector);
    if (el === null || el === undefined) return null;
    const service = hasServicePath(opts.read, opts.write);
    function fallbackWrite(raw        )         {
      const n = normalizeNumber(raw, opts.default, opts.min, opts.max, opts.parse);
      if (typeof opts.fallbackSet === "function") opts.fallbackSet(String(n));
      return n;
    }
    function writeRaw(raw        )         {
      // Service path passes the raw input through: the service's write owns the clamping and
      // returns the effective number, which is what gets echoed.
      if (service) return typeof opts.write === "function" ? opts.write(raw) : NaN;
      return fallbackWrite(raw);
    }
    function refresh()       {
      el.value = String(service && typeof opts.read === "function" ? opts.read() : normalizeNumber(
        typeof opts.fallbackGet === "function" ? opts.fallbackGet() : null,
        opts.default, opts.min, opts.max, opts.parse,
      ));
    }
    refresh();
    ports.listen(el, function () {
      const n = writeRaw(el.value);
      el.value = String(n);
      if (typeof opts.onChange === "function") opts.onChange(n);
    });
    return { el: el, refresh: refresh };
  }

  function bindText(root         , selector        , opts              )                    {
    const el = ports.querySelector(root, selector);
    if (el === null || el === undefined) return null;
    const service = hasServicePath(opts.read, opts.write);
    function writeRaw(raw        )         {
      if (service) return typeof opts.write === "function" ? opts.write(raw) : raw;
      if (typeof opts.fallbackSet === "function") opts.fallbackSet(raw);
      return raw;
    }
    function refresh()       {
      el.value = service && typeof opts.read === "function" ? opts.read()
        : (typeof opts.fallbackGet === "function" ? opts.fallbackGet() : "");
    }
    refresh();
    ports.listen(el, function () {
      const v = writeRaw(el.value);
      el.value = String(v);
      if (typeof opts.onChange === "function") opts.onChange(v);
    });
    return { el: el, refresh: refresh };
  }

  return { bindToggle: bindToggle, bindNumber: bindNumber, bindText: bindText };
}

// Browser wiring for services/ui/bind.ts: the real document arrives as the DOM port and the facade
// is published as a non-`__` global (window.bindEl — no frozen-contract growth). Must load before
// the settings wiring: the settings cards call window.bindEl instead of hand-writing the
// find/reflect/listen/write/fallback chain per control. The port guards an unusable root so a bad
// caller degrades to "element missing" instead of throwing inside a card mount.
(function () {
  window.bindEl = createBind({
    querySelector: function (root, selector) {
      if (!root || typeof root.querySelector !== "function") return null;
      var el = root.querySelector(selector);
      return el == null ? null : el;
    },
    listen: function (el, fn) {
      el.addEventListener("change", fn);
    },
  });
})();

globalThis.normalizeNumber = normalizeNumber;
globalThis.createBind = createBind;
})();
