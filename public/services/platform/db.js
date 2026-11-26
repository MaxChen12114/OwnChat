(function () {
/**
 * The DbPort facade: the one object business code (and T3's migrations) see. Adapters register
 * themselves by name; the facade picks one, hands out the port and keeps the runtime context's `db`
 * service in step with it.
 *
 * Why selection is lazy: the facade's script loads before the three adapters (their factories must
 * exist before a provider can be built), and the Tauri probe answers differently depending on when
 * the shell injects its globals. Resolving on the first `get()` — not at load — means both facts
 * are true when the decision is made, and a page that never touches storage pays nothing.
 *
 * Why `provide("db", …)` gets a stable forwarding port instead of the concrete adapter: the runtime
 * kernel cannot replace a service (`provide` fails loud on duplicates), and rebuilding the root
 * context on every switch would dispose whatever T4 mounts into it. A forwarding port keeps the
 * injected service alive across `use()` calls while `get()`/`adapter()` still answer with the
 * concrete implementation, so "switch the host" never invalidates a consumer's captured reference.
 * `get("db") !== dbSvc.adapter()` is therefore by design, not an oversight.
 *
 * Boundary: this file owns selection, registration and the context; it never speaks HTTP, never
 * reads localStorage and never probes the shell itself (the wiring passes `shellAvailable`).
 * @module services/platform/db
 */

                                                                                               
                                                         

// The kernel is a separate emit product; declaring the bridge keeps this module import-free like
// every other service source. `runtimeCore` is published by `l0/wiring/runtime.js`.
                            
                                                                            
  

/** A registered adapter factory. Called once per selection; throws its own configuration errors. */
                                                      

/** What business code and the shell both type against. */
                           
                
                                                                                     
                                   
                                                                                   
                                                   
                                                                                      
                                               
                                                            
                
                                                                         
                    
                                                           
                                                      
                                                                                                  
 

/** Wiring inputs: the shell probe and the fallback name when no shell is present. */
                                  
                                                                                      
                                         
                                                                                             
                             
 

/** Whether a value answers to the whole DbPort shape. Reflection, not a cast: no escape needed. */
function isPort(value         )                  {
  if (value === null || typeof value !== "object") return false;
  try {
    return (
      typeof Reflect.get(value, "exec") === "function" &&
      typeof Reflect.get(value, "transaction") === "function" &&
      typeof Reflect.get(value, "search") === "function"
    );
  } catch (e) {
    // A hostile getter is "not a port", never a boot-time crash.
    return false;
  }
}

/** Build the facade. One instance per page; the wiring publishes it as `window.dbSvc`. */
function createDbFacade(options                 )           {
  if (!options || typeof options.shellAvailable !== "function") {
    throw new Error("db: shellAvailable probe is required");
  }
  const factories = new Map                   ();
  const root = runtimeCore.createContext();
  const fallback = typeof options.fallback === "string" && options.fallback ? options.fallback : "d1";
  let currentName = "";
  let currentPort                = null;

  /** Boot-time decision: the shell wins when it can invoke, everything else is D1. */
  function pickDefault()         {
    let shell = false;
    try {
      shell = options.shellAvailable() === true;
    } catch (e) {
      // A hostile probe must mean "no shell", not a boot-time crash.
      shell = false;
    }
    if (shell && factories.has("tauri")) return "tauri";
    return fallback;
  }

  const facade           = {
    v: 1,
    context: root,

    register(name        , factory           )       {
      if (typeof name !== "string" || !name) throw new Error("db: adapter name is required");
      if (typeof factory !== "function") throw new Error("db: adapter factory must be a function: " + name);
      if (factories.has(name)) throw new Error("db: adapter already registered: " + name);
      factories.set(name, factory);
    },

    use(name        , useOptions          )         {
      const factory = factories.get(name);
      if (factory === undefined) {
        const known = Array.from(factories.keys()).join(",");
        throw new Error('db: unknown adapter "' + String(name) + '" (registered: ' + (known || "none") + ")");
      }
      const port = factory(useOptions);
      if (!isPort(port)) throw new Error('db: adapter "' + String(name) + '" did not return a DbPort');
      currentName = name;
      currentPort = port;
      return port;
    },

    get()         {
      if (currentPort !== null) return currentPort;
      return facade.use(pickDefault());
    },

    adapter()         {
      return currentName;
    },

    exec(sql        , params            )                    {
      return facade.get().exec(sql, params);
    },

    tx   (fn                              )             {
      return facade.get().transaction   (fn);
    },

    search(surface               , scope             , q        , limit         )                   {
      return facade.get().search(surface, scope, q, limit);
    },
  };

  // The service consumers inject. Generic method syntax is required: `transaction` must stay
  // generic, and an arrow assigned here would widen T to unknown.
  const bridge         = {
    exec(sql        , params            )                    {
      return facade.get().exec(sql, params);
    },
    transaction   (fn                              )             {
      return facade.get().transaction   (fn);
    },
    search(surface               , scope             , q        , limit         )                   {
      return facade.get().search(surface, scope, q, limit);
    },
  };
  root.provide("db", bridge);
  return facade;
}

// Browser wiring, appended by l0/emit.mjs. Engine: services/platform/db.ts (the DbPort facade).
//
// Public API: window.dbSvc = { v, context, register, use, get, adapter, exec, tx, search }.
// `context` is the root runtime context that holds the `db` service — T4-A injects from it instead
// of importing an adapter. The shell probe is the only shell knowledge in this file: a hostile or
// absent `tauriSvc` must read as "no shell", and the facade then picks D1.
(function (g) {
  "use strict";
  if (g.dbSvc) return;

  function shellAvailable() {
    try {
      var t = g.tauriSvc;
      return !!(t && typeof t.available === "function" && t.available() && typeof t.invoke === "function");
    } catch (e) {
      return false;
    }
  }

  g.dbSvc = createDbFacade({ shellAvailable: shellAvailable, fallback: "d1" });
})(window);

globalThis.createDbFacade = createDbFacade;
})();
