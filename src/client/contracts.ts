/**
 * The browser half's view of the `env-injector` section, plus the pure checks
 * that decide whether a draft could be written.
 *
 * These are the CLIENT's mirrors: the host schema in `src/index.ts` remains the
 * authority, and everything here exists so the card can refuse an impossible
 * draft with an inline message instead of spending a round trip on a write the
 * host would reject.
 *
 * The section is typed as type aliases rather than interfaces on purpose: the
 * wire sees JSON, and only an object-literal type is assignable to the wire's
 * index-signature value shape.
 *
 * @module dsh-env-injector/client/contracts
 */

/**
 * One rule, as the settings document stores it. Both regex fields are SOURCE
 * strings — that is what makes a rule losslessly serializable — and `flags`
 * carries the flags for both.
 */
export type EnvInjectorRule = {
  command: string
  argsPattern: string
  envVar: string
  enabled: boolean
  flags: string
}

/**
 * The resolved `env-injector` section: schema defaults, then the composition
 * entry, then the user layer. Only the fields this card edits are spelled out.
 */
export type EnvInjectorSection = {
  rules: EnvInjectorRule[]
  overrideExisting: boolean
  terminal: boolean
  logMatches: boolean
}

/** The section fields this card edits, each one path segment of a write. */
export const CARD_FIELDS = ['rules', 'overrideExisting', 'terminal', 'logMatches'] as const

/** One of {@link CARD_FIELDS}. */
export type CardField = (typeof CARD_FIELDS)[number]

/** The three switch fields, split out so the card can iterate them. */
export const OPTION_FIELDS = ['overrideExisting', 'terminal', 'logMatches'] as const

/** One of {@link OPTION_FIELDS}. */
export type OptionField = (typeof OPTION_FIELDS)[number]

/**
 * What a section resolves to with neither a user layer nor a composition entry
 * above the schema: the floor `Config` in `src/index.ts` declares. Used only to
 * preview a staged reset, so a duplicated value here can never win over the
 * host's — the host re-resolves every write.
 */
export const SCHEMA_FLOOR: EnvInjectorSection = {
  rules: [],
  overrideExisting: true,
  terminal: true,
  logMatches: false,
}

/** Which part of a rule draft would be refused. */
export type RuleIssue = 'command' | 'envVar' | 'flags' | 'regex'

/** The flags `RegExp` accepts. */
const REGEXP_FLAGS = /^[dgimsuvy]*$/

/**
 * Whether one source/flags pair compiles.
 * @param source - regex source text.
 * @param flags - regex flags.
 * @returns whether `new RegExp(source, flags)` succeeds.
 */
export function compilesRegex(source: string, flags: string): boolean {
  try {
    new RegExp(source, flags)
    return true
  } catch {
    return false
  }
}

/**
 * The first problem that would stop this rule from being written, or
 * `undefined` when it is a rule the host could compile.
 *
 * Two checks go beyond the host's: an empty `command` (the host's schema
 * default `.*` covers "every command", but an explicit empty source is an
 * unanchored match-everything pattern written by accident) and duplicate
 * regex flags. Both refuse a rule the card would otherwise hand to the host.
 *
 * @param rule - the rule draft.
 * @returns the offending field, or `undefined`.
 */
export function ruleIssue(rule: EnvInjectorRule): RuleIssue | undefined {
  if (rule.command.trim().length === 0) return 'command'
  if (rule.envVar.trim().length === 0) return 'envVar'
  if (!REGEXP_FLAGS.test(rule.flags) || new Set(rule.flags).size !== rule.flags.length) return 'flags'
  if (!compilesRegex(rule.command, rule.flags)) return 'regex'
  if (rule.argsPattern.trim().length > 0 && !compilesRegex(rule.argsPattern, rule.flags)) return 'regex'
  return undefined
}

/** The text control that carries a rule's problem. */
export type RuleIssueTarget = 'command' | 'argsPattern' | 'envVar' | 'flags'

/**
 * Which control of one rule shows the problem {@link ruleIssue} reported.
 *
 * The regex verdict covers two patterns but can only belong to one control, so
 * it lands on the one that failed — checked in the same order `ruleIssue`
 * compiles them, which is what keeps the message under the field it is about.
 *
 * @param rule - the rule draft.
 * @param issue - the issue `ruleIssue` reported for it.
 * @returns the control that should carry the message.
 */
export function issueTarget(rule: EnvInjectorRule, issue: RuleIssue): RuleIssueTarget {
  if (issue !== 'regex') return issue
  return compilesRegex(rule.command, rule.flags) ? 'argsPattern' : 'command'
}

/**
 * A fresh rule for the card's "Add rule" control: valid by construction except
 * for the two fields only a human can supply.
 * @returns the new draft rule.
 */
export function newRule(): EnvInjectorRule {
  return { command: '', argsPattern: '', envVar: '', enabled: true, flags: '' }
}

/**
 * Copy a rule list so drafts never alias the scope's snapshot.
 * @param rules - the rules to copy.
 * @returns detached rule objects.
 */
export function cloneRules(rules: readonly EnvInjectorRule[]): EnvInjectorRule[] {
  return rules.map((rule) => ({ ...rule }))
}

/**
 * Field-by-field equality of two rule lists.
 * @param left - one list.
 * @param right - the other.
 * @returns whether both carry the same rules in the same order.
 */
export function sameRules(left: readonly EnvInjectorRule[], right: readonly EnvInjectorRule[]): boolean {
  if (left.length !== right.length) return false
  return left.every((rule, index) => {
    const other = right[index]
    return other !== undefined
      && rule.command === other.command
      && rule.argsPattern === other.argsPattern
      && rule.envVar === other.envVar
      && rule.enabled === other.enabled
      && rule.flags === other.flags
  })
}

/**
 * Equality for one section field — the comparison that decides whether a staged
 * edit still differs from what is in force.
 * @param field - the section field.
 * @param left - one value.
 * @param right - the other.
 * @returns whether the two are the same value for this field.
 */
export function sameFieldValue(field: CardField, left: EnvInjectorSection[CardField], right: EnvInjectorSection[CardField]): boolean {
  if (field === 'rules') return sameRules(left as EnvInjectorRule[], right as EnvInjectorRule[])
  return left === right
}
