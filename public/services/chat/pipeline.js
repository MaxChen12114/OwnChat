(function () {
/**
 * Cleaning-pipeline probe: replays every sanitizing stage over one raw model output and records,
 * stage by stage, how the text changed — this is what the dev console's trace view renders.
 *
 * The stages themselves belong to text-format and reasoning; this module only sequences them,
 * diffs each step and catches failures so a broken stage cannot take the whole trace down.
 *
 * Dependencies arrive through {@link PipelinePorts}. The old code captured the two bridge objects
 * at load time, so l0/wiring/pipeline.js captures them once at the top of its IIFE and passes them
 * in, instead of looking them up per call.
 *
 * Equivalence: test/chat-migration-equiv.test.mjs runs the old JS and this product side by side,
 * test/pipeline.test.mjs pins the golden fingerprint.
 * @module services/chat/pipeline
 */

                                 
               
                   
 

                                   
                  
                
 

                                 
                                         
                                                     
                                            
                                       
                                           
                                           
                                        
                                                                    
 

                                
                                         
 

                                
                             
                           
 

                                
               
               
               
                
                
                  
                
                                                      
                    
 

                                       
                   
 

                                      
                          
                      
                    
 

                                   
                                             
                                                         
                                                
                                           
                                               
                                               
                                            
                                             
 

                           
                             
                                                                        
 

// Implementation mirrors the old pipeline.js statement by statement; only the window bridge became ports.

function createPipeline(ports               )           {
  const tf = ports.textFormat;
  const rg = ports.reasoning;
  const stripFns                   = {
    stripThinkBlocks: tf.stripThinkBlocks,
    splitJailbreakPrefix: tf.splitJailbreakPrefix,
    stripResidualMarkup: tf.stripResidualMarkup,
    stripVoiceTags: tf.stripVoiceTags,
    stripChoiceSignals: tf.stripChoiceSignals,
    stripWechatActions: tf.stripWechatActions,
    autoSplitWechat: tf.autoSplitWechat,
    extractThinkText: rg.extractThinkText,
  };
  const diffPrefixSuffix = tf.diffPrefixSuffix;
  const {
    stripThinkBlocks, splitJailbreakPrefix, stripResidualMarkup, stripVoiceTags,
    stripChoiceSignals, stripWechatActions, autoSplitWechat, extractThinkText,
  } = stripFns;

  function trace(raw         , opts                       )                      {
    const o = opts || {};
    const stages                  = [];
    let prev = String(raw == null ? "" : raw);
    stages.push({ name: "原始输出", note: "模型 content 原文(未清洗)", text: prev, chars: prev.length, delta: 0, removed: "", added: "" });
    const step = (name        , note        , fn                           ) => {
      let out         ;
      try { out = fn(prev); } catch (e) { out = prev; }
      const next = String(out == null ? "" : out);
      const d = diffPrefixSuffix(prev, next);
      stages.push({ name, note, text: next, chars: next.length, delta: next.length - prev.length, removed: d.removed, added: d.added });
      prev = next;
    };
    step("去 <think> 块", "stripThinkBlocks:删成对/未闭合 <think>…</think>", stripThinkBlocks);
    let split                ;
    try { split = splitJailbreakPrefix(prev); } catch (e) { split = { body: prev, thinking: "" }; }
    {
      const out = String(split.body == null ? "" : split.body);
      const d = diffPrefixSuffix(prev, out);
      stages.push({ name: "拆解限哨兵", note: "splitJailbreakPrefix:剥 [^420]/[^69] 哨兵区间 + 启发式越狱行(裁掉的归档进思考折叠块)", text: out, chars: out.length, delta: out.length - prev.length, removed: d.removed, added: d.added, captured: split.thinking || "" });
      prev = out;
    }
    step("去残括号/残标记", "stripResidualMarkup:清空壳 []/【】、残缺 [好感]、写崩的 [发图:] 等", stripResidualMarkup);
    step("去语音/场景标签", "stripVoiceTags:剥句首/行内 [键:值] 标签(显示层隐藏,朗读前也剥;无冒号的 [害羞]/[选项] 不动。多情绪切换系统 2026-10-06 已删,协议本身保留)", stripVoiceTags);
    step("去选择信号块", "stripChoiceSignals:剥 [选项]…[/选项] 选择信号块(choices.js 提取成可点芯片后从气泡抹除;此处仅 dev 可视,TTS 朗读文本时同样剥除不念选项)", stripChoiceSignals);
    if (o.wechat) {
      step("微信去动作描写", "stripWechatActions:删 （…）/(…)/*…*", stripWechatActions);
      let auto = "";
      try { auto = autoSplitWechat(prev) || ""; } catch (e) { /* as before: a throw means no split is needed */ }
      stages.push({ name: "微信兜底拆条", note: "autoSplitWechat:长段按句切多条气泡(空=无需拆)", text: auto || prev, chars: (auto || "").length, delta: 0, removed: "", added: auto ? auto : "" });
    }
    let inlineThink = "";
    try { inlineThink = extractThinkText(String(raw == null ? "" : raw)); } catch (e) { /* as before: a throw leaves it empty */ }
    return { stages, inlineThink, finalBody: prev };
  }

  return { stripFns, trace };
}

// Browser wiring (injected by l0/emit.mjs): binds the service to the existing window contract.
// Line for line the old pipeline.js: the bridge functions are captured once at the top of the IIFE
// and handed to the service, not re-read on every trace — so `stripFns` still holds the original
// function references and reference equality survives.
// Every bridge is spelled out with the `window.` prefix: an alias drops the contract count to zero.
(function () {
  if (window.__pipeline) return;

  var ports = {
    textFormat: {
      stripThinkBlocks: window.__textFormat.stripThinkBlocks,
      splitJailbreakPrefix: window.__textFormat.splitJailbreakPrefix,
      stripResidualMarkup: window.__textFormat.stripResidualMarkup,
      stripVoiceTags: window.__textFormat.stripVoiceTags,
      stripChoiceSignals: window.__textFormat.stripChoiceSignals,
      stripWechatActions: window.__textFormat.stripWechatActions,
      autoSplitWechat: window.__textFormat.autoSplitWechat,
      diffPrefixSuffix: window.__textFormat.diffPrefixSuffix,
    },
    reasoning: {
      extractThinkText: window.__reasoning.extractThinkText,
    },
  };

  var pipeline = createPipeline(ports);
  window.__pipeline = {
    stripFns: pipeline.stripFns,
    trace: pipeline.trace,
  };
})();

globalThis.createPipeline = createPipeline;
})();
