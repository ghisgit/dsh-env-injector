/**
 * Copy for this plugin's card, in both languages the harness ships.
 *
 * The namespace is registered with `ctx.locale.register(NS, { en, zh })` in the
 * browser half, and the card's slot registration declares `locale: NS` so the
 * framework binds the typed `t` seat. Both dictionaries carry identical key
 * sets — the typed registration overload checks that at compile time — because
 * a key that exists in one language only is a hole a reader falls into after a
 * language switch.
 *
 * @module dsh-env-injector/client/locales
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * The namespace this card owns: the settings namespace it edits (so the tab's
 * keyed dispatch and this dictionary namespace are one name) and the locale
 * namespace its copy lives under.
 */
export const NS = 'env-injector'

/** Locale keys the card renders. */
export type EnvInjectorLocaleKey =
  | 'cardTitle'
  | 'cardDescription'
  | 'unsaved'
  | 'expand'
  | 'collapse'
  | 'readOnly'
  | 'save'
  | 'saving'
  | 'discard'
  | 'saveFailed'
  | 'overridden'
  | 'reset'
  | 'layerHint'
  | 'rulesLabel'
  | 'rulesHint'
  | 'rulesEmpty'
  | 'addRule'
  | 'removeRule'
  | 'ruleCommand'
  | 'ruleArgsPattern'
  | 'ruleEnvVar'
  | 'ruleFlags'
  | 'ruleEnabled'
  | 'ruleFieldLabel'
  | 'errorCommand'
  | 'errorEnvVar'
  | 'errorFlags'
  | 'errorRegex'
  | 'optionOverrideExisting'
  | 'optionOverrideExistingHint'
  | 'optionTerminal'
  | 'optionTerminalHint'
  | 'optionLogMatches'
  | 'optionLogMatchesHint'

/** The card's translate seat, narrowed to this namespace's keys. */
export type CardTranslate = Translate<EnvInjectorLocaleKey>

/** English copy. */
export const en: Record<EnvInjectorLocaleKey, string> = {
  cardTitle: 'Environment injection',
  cardDescription: 'Rules that forward a harness-process variable into the child commands they match.',
  unsaved: 'Unsaved',
  expand: 'Expand',
  collapse: 'Collapse',
  readOnly: 'This deployment keeps settings in memory; the card is read-only.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'The save was refused. Your edits are still here.',
  overridden: 'Overridden',
  reset: 'Reset',
  layerHint: 'Saving writes the user layer of the settings document; resetting a field makes it follow the deployment again.',
  rulesLabel: 'Rules',
  rulesHint: 'Each enabled rule whose command matches contributes its variable to that child only. Lists replace wholesale.',
  rulesEmpty: 'No rules. This plugin injects nothing.',
  addRule: 'Add rule',
  removeRule: 'Remove',
  ruleCommand: 'Command',
  ruleArgsPattern: 'Arguments',
  ruleEnvVar: 'Variable',
  ruleFlags: 'Flags',
  ruleEnabled: 'Enabled',
  ruleFieldLabel: 'Rule {index} {field}',
  errorCommand: 'A rule needs a command pattern; write .* to match every command.',
  errorEnvVar: 'A rule needs a non-empty variable name.',
  errorFlags: 'Not valid regular-expression flags.',
  errorRegex: 'Not a valid regular expression.',
  optionOverrideExisting: 'Override existing values',
  optionOverrideExistingHint: 'The harness-process value replaces one the caller passed in the spawn spec.',
  optionTerminal: 'Cover terminal sessions',
  optionTerminalHint: 'Also apply the rules to spawnTerminal (PTY sessions); a persistent shell needs its rule on the shell itself.',
  optionLogMatches: 'Log matches',
  optionLogMatchesHint: 'One line per spawn (info) and per miss (debug), through the env-injector logger and stderr.',
}

/** Simplified Chinese copy. */
export const zh: Record<EnvInjectorLocaleKey, string> = {
  cardTitle: '环境变量注入',
  cardDescription: '按规则把 harness 进程中的变量转发给它命中的子命令。',
  unsaved: '未保存',
  expand: '展开',
  collapse: '收起',
  readOnly: '该部署把设置保存在内存中，卡片为只读。',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  saveFailed: '保存被拒绝，你的修改仍然保留。',
  overridden: '已覆盖',
  reset: '重置',
  layerHint: '保存写入设置文档的用户层；重置某字段后，它将重新跟随部署配置。',
  rulesLabel: '规则',
  rulesHint: '每条启用且命中命令的规则，只把它的变量注入该子进程。列表是整体替换。',
  rulesEmpty: '暂无规则，本插件不注入任何变量。',
  addRule: '添加规则',
  removeRule: '删除',
  ruleCommand: '命令',
  ruleArgsPattern: '参数',
  ruleEnvVar: '变量名',
  ruleFlags: '标志',
  ruleEnabled: '启用',
  ruleFieldLabel: '第 {index} 条规则的{field}',
  errorCommand: '规则需要命令模式；匹配所有命令请写 .*。',
  errorEnvVar: '规则需要非空变量名。',
  errorFlags: '不是合法的正则标志。',
  errorRegex: '不是合法的正则。',
  optionOverrideExisting: '覆盖已有值',
  optionOverrideExistingHint: 'harness 进程中的值会替换调用方在 spawn spec 中传入的值。',
  optionTerminal: '覆盖终端会话',
  optionTerminalHint: '同时对 spawnTerminal（PTY 会话）生效；持久 shell 需要把规则写在 shell 自身。',
  optionLogMatches: '记录命中',
  optionLogMatchesHint: '每次命中（info）与未命中（debug）各写一行，走 env-injector logger 与 stderr。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This card's own copy. */
    'env-injector': EnvInjectorLocaleKey
  }
}
