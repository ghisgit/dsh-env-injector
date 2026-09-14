/**
 * The `env-injector` card.
 *
 * The Plugin configuration tab dispatches `settings.plugin.item` by settings
 * namespace and renders whatever card the namespace's own package registered —
 * the tab owns the section, the card owns its internals. So this component is
 * the whole card: its disclosure chrome, its controls, its copy, and the save
 * that writes them.
 *
 * Two behaviors are worth stating because they are the card's contract with a
 * reader rather than its implementation:
 *
 * - **A card renders nothing while its namespace is unavailable.** A deployment
 *   that does not compose this plugin should show no trace of it, and one where
 *   the client keeps settings process-local gets the read-only notice instead of
 *   controls that cannot work.
 * - **A field shows its effective value and whether it is overridden.** Saving
 *   writes the user layer; resetting a field makes it follow the deployment's
 *   composition entry again. Both are visible before a save, never after.
 *
 * @module dsh-env-injector/client/card
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutline14, Input, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { OPTION_FIELDS, issueTarget, type EnvInjectorRule, type OptionField, type RuleIssue } from './contracts.ts'
import type { EnvInjectorCardFace, EnvInjectorCardState } from './controller.ts'
import type { CardTranslate } from './locales.ts'
import { NS } from './locales.ts'
import { c, ensureStyles } from './styles.ts'

/* The card's stylesheet is installed when the bundle materializes, once per
 * page — the same point every DSH client bundle does its style work. */
ensureStyles()

/** Props the renderer composes: the inject face plus the locale `t` seat. */
export type EnvInjectorCardProps = InjectFace<EnvInjectorCardFace> & PropsLocale<typeof NS>

/** The copy key for one rule problem. */
function issueCopy(issue: RuleIssue): 'errorCommand' | 'errorEnvVar' | 'errorFlags' | 'errorRegex' {
  if (issue === 'command') return 'errorCommand'
  if (issue === 'envVar') return 'errorEnvVar'
  if (issue === 'flags') return 'errorFlags'
  return 'errorRegex'
}

/** The copy key of one option field's label. */
function optionLabel(field: OptionField): 'optionOverrideExisting' | 'optionTerminal' | 'optionLogMatches' {
  if (field === 'overrideExisting') return 'optionOverrideExisting'
  if (field === 'terminal') return 'optionTerminal'
  return 'optionLogMatches'
}

/** The copy key of one option field's hint. */
function optionHint(field: OptionField): 'optionOverrideExistingHint' | 'optionTerminalHint' | 'optionLogMatchesHint' {
  if (field === 'overrideExisting') return 'optionOverrideExistingHint'
  if (field === 'terminal') return 'optionTerminalHint'
  return 'optionLogMatchesHint'
}

/**
 * One switch field: the control, its visible label and hint, its overridden
 * badge, and the reset that makes it follow the deployment again.
 * @param props - the field, the card state, and the actions it stages.
 * @returns the field row.
 */
function OptionRow(props: {
  field: OptionField
  state: EnvInjectorCardState
  t: CardTranslate
  disabled: boolean
  onToggle: (next: boolean) => void
  onReset: () => void
}): ReactNode {
  const { field, state, t, disabled } = props
  const checked = field === 'overrideExisting' ? state.overrideExisting : field === 'terminal' ? state.terminal : state.logMatches
  return (
    <div className={c.field}>
      <Switch checked={checked} label={t(optionLabel(field))} disabled={disabled} onChange={props.onToggle} />
      <span className={c.optionText}>
        <span className={c.label}>{t(optionLabel(field))}</span>
        <span className={c.hint}>{t(optionHint(field))}</span>
      </span>
      <span className={c.badges}>
        {state.overridden[field] ? <Tag tone="quiet">{t('overridden')}</Tag> : null}
        <button type="button" className={c.reset} disabled={disabled} onClick={props.onReset}>
          {t('reset')}
        </button>
      </span>
    </div>
  )
}

/**
 * One text control of a rule, with its label and the message of the problem it
 * carries (if any).
 * @param props - the control's identity, value, and edit action.
 * @returns the rule's text field.
 */
function RuleField(props: {
  name: 'command' | 'argsPattern' | 'envVar' | 'flags'
  label: string
  ariaLabel: string
  value: string
  disabled: boolean
  error: string | undefined
  onChange: (value: string) => void
}): ReactNode {
  const id = `${useId()}-${props.name}`
  return (
    <div className={c.ruleCell}>
      <label className={c.ruleLabel} htmlFor={id}>{props.label}</label>
      <Input
        id={id}
        value={props.value}
        disabled={props.disabled}
        spellCheck={false}
        autoComplete="off"
        aria-label={props.ariaLabel}
        aria-invalid={props.error !== undefined}
        onChange={(event) => {
          props.onChange(event.target.value)
        }}
      />
      {props.error === undefined ? null : <p className={c.error} role="alert">{props.error}</p>}
    </div>
  )
}

/**
 * One rule: its four pattern/value controls, its enabled switch, and the
 * remove action.
 * @param props - the rule, its position, its problem, and the edit actions.
 * @returns the rule row.
 */
function RuleRow(props: {
  index: number
  rule: EnvInjectorRule
  issue: RuleIssue | undefined
  t: CardTranslate
  disabled: boolean
  onEdit: (patch: Partial<EnvInjectorRule>) => void
  onRemove: () => void
}): ReactNode {
  const { index, rule, issue, t, disabled } = props
  const name = (field: string): string => t('ruleFieldLabel', { index: index + 1, field })
  const target = issue === undefined ? undefined : issueTarget(rule, issue)
  const error = (field: 'command' | 'argsPattern' | 'envVar' | 'flags'): string | undefined =>
    issue === undefined || target !== field ? undefined : t(issueCopy(issue))
  const edit = (patch: Partial<EnvInjectorRule>): void => {
    props.onEdit(patch)
  }
  return (
    <div className={c.rule}>
      <div className={c.ruleGrid}>
        <RuleField
          name="command" label={t('ruleCommand')} ariaLabel={name(t('ruleCommand'))}
          value={rule.command} disabled={disabled} error={error('command')}
          onChange={(value) => { edit({ command: value }) }}
        />
        <RuleField
          name="argsPattern" label={t('ruleArgsPattern')} ariaLabel={name(t('ruleArgsPattern'))}
          value={rule.argsPattern} disabled={disabled} error={error('argsPattern')}
          onChange={(value) => { edit({ argsPattern: value }) }}
        />
        <RuleField
          name="envVar" label={t('ruleEnvVar')} ariaLabel={name(t('ruleEnvVar'))}
          value={rule.envVar} disabled={disabled} error={error('envVar')}
          onChange={(value) => { edit({ envVar: value }) }}
        />
        <RuleField
          name="flags" label={t('ruleFlags')} ariaLabel={name(t('ruleFlags'))}
          value={rule.flags} disabled={disabled} error={error('flags')}
          onChange={(value) => { edit({ flags: value }) }}
        />
      </div>
      <div className={c.ruleFoot}>
        <Switch
          checked={rule.enabled}
          label={name(t('ruleEnabled'))}
          disabled={disabled}
          onChange={(next) => { edit({ enabled: next }) }}
        />
        <span className={c.optionText}>
          <span className={c.label}>{t('ruleEnabled')}</span>
        </span>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={props.onRemove}>
          {t('removeRule')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Render the card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing while the namespace is unavailable.
 */
export function EnvInjectorCard(props: EnvInjectorCardProps): ReactNode {
  const { t } = props
  const state = props.useEnvInjectorCard((snapshot) => snapshot)
  const [open, setOpen] = useState(false)
  const saveStarted = useRef(false)
  const rulesId = `${useId()}-rules`

  /* A successful save collapses the card, once the read-back confirms the
   * writes landed; a failed save keeps it open with the drafts in place. */
  useEffect(() => {
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && !state.failed) setOpen(false)
  }, [state.dirty, state.failed, state.saving])

  if (!state.available) return null

  const title = t('cardTitle')
  const disabled = !state.writable
  const blocked = !state.dirty || state.invalid || state.saving

  return (
    <li className={open ? `${c.card} ${c.cardOpen}` : c.card}>
      <button
        type="button"
        className={c.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span className={c.headText}>
          <span className={c.name}>{title}</span>
          <span className={c.description}>{t('cardDescription')}</span>
        </span>
        {state.dirty ? <Tag tone="neutral" className={c.pending}>{t('unsaved')}</Tag> : null}
        <IconChevronDownOutline14 className={open ? `${c.chevron} ${c.chevronOpen}` : c.chevron} />
      </button>
      {open ? (
        <div className={c.body}>
          {disabled ? <p className={c.notice} role="status">{t('readOnly')}</p> : null}
          {OPTION_FIELDS.map((field) => (
            <OptionRow
              key={field}
              field={field}
              state={state}
              t={t}
              disabled={disabled}
              onToggle={(next) => {
                props.setOption(field, next)
              }}
              onReset={() => {
                props.resetField(field)
              }}
            />
          ))}
          <div className={c.rules} role="group" aria-labelledby={rulesId}>
            <div className={c.rulesHead}>
              <span className={c.rulesLabel} id={rulesId}>{t('rulesLabel')}</span>
              <span className={c.badges}>
                {state.overridden.rules ? <Tag tone="quiet">{t('overridden')}</Tag> : null}
                <button
                  type="button"
                  className={c.reset}
                  disabled={disabled}
                  onClick={() => {
                    props.resetField('rules')
                  }}
                >
                  {t('reset')}
                </button>
              </span>
            </div>
            <p className={c.hint}>{t('rulesHint')}</p>
            {state.rules.length === 0 ? <p className={c.empty}>{t('rulesEmpty')}</p> : null}
            {state.rules.map((rule, index) => (
              /* Position is the only identity a rule has: the section stores an
               * ordered list with no per-rule id, so the index is the key. */
              <RuleRow
                key={index}
                index={index}
                rule={rule}
                issue={state.issues[index]}
                t={t}
                disabled={disabled}
                onEdit={(patch) => {
                  props.editRule(index, patch)
                }}
                onRemove={() => {
                  props.removeRule(index)
                }}
              />
            ))}
            <div className={c.actions}>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  props.addRule()
                }}
              >
                {t('addRule')}
              </Button>
            </div>
          </div>
          <p className={c.hint}>{t('layerHint')}</p>
          <div className={c.footer}>
            {state.failed ? <p className={c.failed} role="status">{t('saveFailed')}</p> : null}
            <Button
              variant="outline"
              size="sm"
              disabled={!state.dirty || state.saving}
              onClick={() => {
                props.discard()
              }}
            >
              {t('discard')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={blocked}
              onClick={() => {
                props.save()
              }}
            >
              {t(state.saving ? 'saving' : 'save')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
