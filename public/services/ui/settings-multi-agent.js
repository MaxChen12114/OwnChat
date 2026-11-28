(function () {
/**
 * Multi-agent orchestration settings: three access switches and three numeric caps shared by the
 * settings card (write side in settings.js) and the peer-call engine (read side in
 * services/agent/peer-calls.ts).
 *
 * The two sides used to spell out the same clamp independently — and disagreed on one default:
 * settings.js painted `meetingMax = 3` while peer-calls read `6`, so the number shown in the card
 * was not the number the engine ran with. All six keys, their defaults and their clamp ranges now
 * live here once; both sides consume this module. DOM refs, labels and status text stay in the card.
 *
 * Switch semantics are deliberately "absent = on": an untouched key means the gate is open, so
 * returning users never have to visit the card before the features work. Writes materialise that
 * as an explicit "1"/"0". Numeric caps clamp on both read and write; a dirty value falls back to
 * the documented default rather than leaking NaN into a billing-sensitive call count.
 *
 * Zero window, zero casts: storage arrives through {@link MultiAgentPorts}, and the wiring owns the
 * try/catch around localStorage. Every port call is guarded, matching the card's old safe reads.
 * @module services/ui/settings-multi-agent
 */

const MA_DELEGATE_KEY = "cfw_ma_delegate_v1";
const MA_MEETING_KEY = "cfw_ma_meeting_v1";
const MA_INVITE_KEY = "cfw_ma_invite_v1";
const MA_MEET_MAX_KEY = "cfw_ma_meeting_max_v1";
const MA_MEET_ROUNDS_KEY = "cfw_ma_meeting_rounds_v1";
const MA_CTX_MSGS_KEY = "cfw_ma_ctx_msgs_v1";

/** Storage port; structurally identical to the other settings service ports. */
                                  
                                      
                                            
 

                                   
             
              
 

                                
             
              
              
             
             
 

/** The three access switches, in card order, for the write-side loop. */
const SWITCHES                     = [
  { id: "maDelegate", key: MA_DELEGATE_KEY },
  { id: "maMeeting", key: MA_MEETING_KEY },
  { id: "maInvite", key: MA_INVITE_KEY },
];

/** The three numeric caps. `meetingMax` defaults to 3 here and in the engine — the old drift is gone. */
const CAPS                  = [
  { id: "maMeetMax", key: MA_MEET_MAX_KEY, def: 3, lo: 1, hi: 6 },
  { id: "maMeetRounds", key: MA_MEET_ROUNDS_KEY, def: 1, lo: 1, hi: 2 },
  { id: "maCtxMsgs", key: MA_CTX_MSGS_KEY, def: 60, lo: 0, hi: 400 },
];

                                  
                    
                   
                  
                     
                        
                  
 

                                
                                                                     
                                   
                                              
                                                                                        
                                                                    
                                                                                     
                                                                                              
                                                                                 
 

/** Absent switch means on; only an explicit "0" turns it off. */
function normalizeSwitch(raw               )          {
  return raw !== "0";
}

/** Strict cap parse: a missing or non-numeric value uses `def`, anything else clamps into [lo, hi]. */
function normalizeCap(raw               , def        , lo        , hi        )         {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return isNaN(n) ? def : Math.max(lo, Math.min(hi, n));
}

function safeGet(ports                 , key        )                {
  try {
    return ports.getItem(key);
  } catch (e) {
    return null;
  }
}

function safeSet(ports                 , key        , value        )       {
  try {
    ports.setItem(key, value);
  } catch (e) {
  }
}

function createSettingsMultiAgent(ports                 )                {
  return {
    readSwitch: (key) => normalizeSwitch(safeGet(ports, key)),
    writeSwitch: (key, on) => safeSet(ports, key, on ? "1" : "0"),
    readCap: (key, def, lo, hi) => normalizeCap(safeGet(ports, key), def, lo, hi),
    writeCap: (key, value, def, lo, hi) => {
      const n = normalizeCap(typeof value === "string" ? value : String(value), def, lo, hi);
      safeSet(ports, key, String(n));
      return n;
    },
    engineConfig: () => ({
      meetingMax: normalizeCap(safeGet(ports, MA_MEET_MAX_KEY), 3, 1, 6),
      meetingRounds: normalizeCap(safeGet(ports, MA_MEET_ROUNDS_KEY), 1, 1, 2),
      ctxMsgs: normalizeCap(safeGet(ports, MA_CTX_MSGS_KEY), 60, 0, 400),
    }),
  };
}

// Browser wiring for services/ui/settings-multi-agent.ts: localStorage as the injected port and
// the non-`__` global. The six keys, their defaults and clamp ranges live in the emitted service and
// are shared with peer-calls' read side via an equivalence lock. The switch/cap loops stay in the
// settings card; only storage IO is injected here.
(function () {
  window.settingsMultiAgent = createSettingsMultiAgent({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  });
})();

globalThis.MA_DELEGATE_KEY = MA_DELEGATE_KEY;
globalThis.MA_MEETING_KEY = MA_MEETING_KEY;
globalThis.MA_INVITE_KEY = MA_INVITE_KEY;
globalThis.MA_MEET_MAX_KEY = MA_MEET_MAX_KEY;
globalThis.MA_MEET_ROUNDS_KEY = MA_MEET_ROUNDS_KEY;
globalThis.MA_CTX_MSGS_KEY = MA_CTX_MSGS_KEY;
globalThis.SWITCHES = SWITCHES;
globalThis.CAPS = CAPS;
globalThis.normalizeSwitch = normalizeSwitch;
globalThis.normalizeCap = normalizeCap;
globalThis.createSettingsMultiAgent = createSettingsMultiAgent;
})();
