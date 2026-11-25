(function () {
/**
 * Settings card mount order: the sequential `mountXxxCard()` calls carry order semantics (slot
 * occupancy, prepend-vs-append interactions, cards that must exist before others read them), but
 * that order used to live only as source line order — invisible to tests and easy to shuffle in a
 * merge. The table makes it reviewable; the wiring walks the plan and calls its mapping table.
 *
 * `why` keeps the one non-obvious ordering fact per card. Cards listed here but missing a mount
 * function are skipped by the plan (a stale id must not break the whole panel).
 * @module services/ui/settings-card-order
 */

/** One mount step: the mount-function id (camelCase, `mount` prefix) and its ordering reason. */
                                   
                      
                       
 

/** The frozen order. Keep it byte-stable: the lock compares the mapping table against it. */
const SETTINGS_CARDS                              = [
  { id: "mountConvAutonameCard", why: "对话分类首屏（A34）" },
  { id: "mountAuthCard", why: "账号页" },
  { id: "mountLocalHistoryCard", why: "常用：放账号页第一屏" },
  { id: "mountSyncCard", why: "同步卡跟在账号后" },
  { id: "mountTopbarCostCard", why: "费用卡在同步后" },
  { id: "mountThemeCard", why: "外观分类首卡" },
  { id: "mountAmbientCard", why: "氛围音，全主题可用、不随解锁门显隐" },
  { id: "mountBackgroundCard", why: "背景图（外观分类）" },
  { id: "mountMobileAppLayoutCard", why: "壳内布局卡" },
  { id: "mountDisplayCard", why: "字号/字体属于外观" },
  { id: "mountAppFxCard", why: "壳内特效档位（仅壳内出现）" },
  { id: "mountI18nCard", why: "界面语言" },
  { id: "mountNeutralCard", why: "锁定态准则，与底座卡互斥显隐" },
  { id: "mountStateLayerCard", why: "角色状态层开关把手" },
  { id: "mountWebSearchCard", why: "联网搜索（Worker 代查）" },
  { id: "mountBaseIdCard", why: "基座放「对话」首卡——它影响一切" },
  { id: "mountBaseRegistryCard", why: "基座目录切换，prepend 后落在底座卡之上（顺序敏感）" },
  { id: "mountChatModeCard", why: "聊天模式卡" },
  { id: "mountAutopilotCard", why: "自动驾驶卡" },
  { id: "mountAgentToolsCard", why: "Agent 工具开关" },
  { id: "mountMultiAgentCard", why: "多智能体独立成卡" },
  { id: "mountDevToolsCard", why: "开发工具卡" },
  { id: "mountPersonaCard", why: "Persona 卡（M1）" },
  { id: "mountPersonalizeCard", why: "Agent 个性化（独立分类）" },
  { id: "mountByoCard", why: "自定义直连归「模型 API」分类" },
  { id: "mountCustomPricingCard", why: "自定义定价跟在渠道卡后" },
  { id: "mountGenParamsCard", why: "生成参数跟在定价卡后（同属模型 API）" },
];

/** Filter the frozen order down to the mounts actually available this boot. */
function planCardMounts(available                   )           {
  const have = new Set(available);
  const out           = [];
  for (let i = 0; i < SETTINGS_CARDS.length; i++) {
    const id = SETTINGS_CARDS[i].id;
    if (have.has(id)) out.push(id);
  }
  return out;
}

// Browser wiring for services/ui/settings-card-order.ts: the plan functions bridge onto globalThis
// by emit (SETTINGS_CARDS / planCardMounts); settings.js consumes them through its mapping table.
// Nothing to bind here.
(function () {
  "use strict";
})();

globalThis.SETTINGS_CARDS = SETTINGS_CARDS;
globalThis.planCardMounts = planCardMounts;
})();
