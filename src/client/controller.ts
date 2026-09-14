/**
 * The card's form model: one settings scope plus the drafts a save would write.
 *
 * The card stages what the user types and writes only when they save. Each
 * settings write is a durable, revision-fenced document mutation, so a control
 * that committed as it settled would turn one edit into a write the user never
 * asked for and could not preview; staged drafts make what is on screen exactly
 * what a save would store.
 *
 * Three rules shape the state below:
 *
 * - **Only touched fields are written.** A save emits one atomic mutation whose
 *   path ops cover exactly the staged fields, so a concurrent edit to a field
 *   this card never touched survives.
 * - **A field shows its effective value and whether the user layer carries it.**
 *   Presence in the raw user layer — not a value comparison — is what marks a
 *   field overridden, and a staged edit answers for itself: the badge previews
 *   the save rather than reporting a state the pending edit already contradicts.
 * - **Reset clears, it does not write.** Staging a clear makes the field
 *   re-inherit the composition entry; the control previews the value the field
 *   falls back to while the clear is pending.
 *
 * @module dsh-env-injector/client/controller
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

import {
  CARD_FIELDS,
  SCHEMA_FLOOR,
  cloneRules,
  newRule,
  ruleIssue,
  sameFieldValue,
  type CardField,
  type EnvInjectorRule,
  type EnvInjectorSection,
  type OptionField,
  type RuleIssue,
} from './contracts.ts'

/** What the card renders. */
export interface EnvInjectorCardState {
  /** Whether the Host serves this namespace; false renders nothing at all. */
  available: boolean
  /** Whether the settings document accepts writes. */
  writable: boolean
  /** Whether a save would write something. */
  dirty: boolean
  /** Whether a staged draft is one the Host would refuse, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land; cleared by the next edit or save. */
  failed: boolean
  /** The rule list the editor renders: the staged draft, else what is in force. */
  rules: EnvInjectorRule[]
  /** Per-rule problems, aligned with {@link rules}. */
  issues: (RuleIssue | undefined)[]
  /** Whether the user layer would carry each field once a save lands. */
  overridden: Record<CardField, boolean>
  /** Effective `overrideExisting`, with a staged draft preferred. */
  overrideExisting: boolean
  /** Effective `terminal`, with a staged draft preferred. */
  terminal: boolean
  /** Effective `logMatches`, with a staged draft preferred. */
  logMatches: boolean
}

/** What the card can do; every member arrives as a plain component prop. */
export interface EnvInjectorCardActions {
  /** Stage one rule's changed fields, by position in the list. */
  editRule(index: number, patch: Partial<EnvInjectorRule>): void
  /** Append a rule with only the fields a human must fill left empty. */
  addRule(): void
  /** Remove the rule at one position. */
  removeRule(index: number): void
  /** Stage one switch field. */
  setOption(field: OptionField, value: boolean): void
  /** Stage a clear, so saving makes the field re-inherit the composition entry. */
  resetField(field: CardField): void
  /** Write every staged draft in one mutation. */
  save(): void
  /** Drop every staged draft. */
  discard(): void
}

/** The face the card's slot registration injects. */
export interface EnvInjectorCardFace extends EnvInjectorCardActions {
  hooks: {
    /** Card snapshot, bound by the renderer as the `useEnvInjectorCard` prop. */
    envInjectorCard: HostObservable<EnvInjectorCardState>
  }
}

/** One staged edit: a value a save would write, or a clear it would write. */
type Staged =
  | { readonly kind: 'set'; readonly value: EnvInjectorSection[CardField] }
  | { readonly kind: 'clear' }

/**
 * Bridge one `env-injector` scope onto the card's staged form.
 *
 * The controller owns no React: it publishes a snapshot and a subscription, and
 * the slot machinery binds that pair into the component's selector hook.
 */
export class EnvInjectorCardController {
  private readonly scope: SettingsScope<EnvInjectorSection>
  private readonly staged = new Map<CardField, Staged>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private readonly face: EnvInjectorCardFace
  private readonly source: HostObservable<EnvInjectorCardState>
  private snapshot: EnvInjectorCardState
  private saving = false
  private failed = false
  private disposed = false

  /**
   * @param scope - the bound settings scope for the `env-injector` namespace.
   */
  constructor(scope: SettingsScope<EnvInjectorSection>) {
    this.scope = scope
    this.source = {
      getSnapshot: () => this.snapshot,
      subscribe: (listener) => {
        if (this.disposed) return () => {}
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
    }
    this.unsubscribe = scope.subscribe(() => {
      this.publish()
    })
    this.snapshot = this.project()
    this.face = this.buildFace()
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot source and its form actions.
   */
  inject(): EnvInjectorCardFace {
    return this.face
  }

  /** Release the scope subscription; the registration stays inert from here on. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.listeners.clear()
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Reads
   * ──────────────────────────────────────────────────────────────────────── */

  /** The value in force for one field: what the host resolved for this client. */
  private effective(field: CardField): EnvInjectorSection[CardField] {
    const { value } = this.scope.getSnapshot()
    /* The section is schema-resolved on the host, so a field is normally
     * present; the floor covers a wire answer that omitted one (a redacted or
     * older descriptor), which must render as "nothing configured" rather than
     * as an exception inside a card. */
    return value?.[field] ?? SCHEMA_FLOOR[field]
  }

  /** What one field falls back to once the user layer stops carrying it. */
  private inherited(field: CardField): EnvInjectorSection[CardField] {
    const { base } = this.scope.getSnapshot()
    const section = base as Partial<EnvInjectorSection> | undefined
    return section?.[field] ?? SCHEMA_FLOOR[field]
  }

  /** The value the control for one field renders. */
  private shown(field: CardField): EnvInjectorSection[CardField] {
    const staged = this.staged.get(field)
    if (staged === undefined) return this.effective(field)
    return staged.kind === 'set' ? staged.value : this.inherited(field)
  }

  /** Whether the raw user layer carries one field. */
  private stored(field: CardField): boolean {
    const { user } = this.scope.getSnapshot()
    return user !== null && typeof user === 'object' && Object.hasOwn(user, field)
  }

  /** Whether a save would change one field. */
  private isDirty(field: CardField): boolean {
    const staged = this.staged.get(field)
    if (staged === undefined) return false
    if (staged.kind === 'clear') return this.stored(field)
    return !sameFieldValue(field, staged.value, this.effective(field))
  }

  /** The rule list the editor works on: the staged draft, else what is in force. */
  private draftRules(): EnvInjectorRule[] {
    return cloneRules(this.shown('rules') as EnvInjectorRule[])
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Writes
   * ──────────────────────────────────────────────────────────────────────── */

  /** Publish a projection of the scope and the drafts. */
  private publish(): void {
    if (this.disposed) return
    this.snapshot = this.project()
    for (const listener of [...this.listeners]) listener()
  }

  /** Build the current state from the scope's snapshot plus the staged drafts. */
  private project(): EnvInjectorCardState {
    const snapshot = this.scope.getSnapshot()
    const rules = this.draftRules()
    const issues = rules.map((rule) => ruleIssue(rule))
    const overridden = {} as Record<CardField, boolean>
    for (const field of CARD_FIELDS) {
      const staged = this.staged.get(field)
      overridden[field] = staged === undefined ? this.stored(field) : staged.kind === 'set'
    }
    const ready = snapshot.status === 'ready'
    return {
      available: ready,
      writable: ready && snapshot.writable,
      dirty: CARD_FIELDS.some((field) => this.isDirty(field)),
      invalid: this.isDirty('rules') && issues.some((issue) => issue !== undefined),
      saving: this.saving,
      failed: this.failed,
      rules,
      issues,
      overridden,
      overrideExisting: this.shown('overrideExisting') as boolean,
      terminal: this.shown('terminal') as boolean,
      logMatches: this.shown('logMatches') as boolean,
    }
  }

  /** The writes a save would perform, or `undefined` when it must not write. */
  private plan(): SettingsPathOpView[] | undefined {
    if (this.project().invalid) return undefined
    const ops: SettingsPathOpView[] = []
    for (const field of CARD_FIELDS) {
      if (!this.isDirty(field)) continue
      const staged = this.staged.get(field)
      if (staged === undefined) continue
      if (staged.kind === 'clear') ops.push({ op: 'unset', path: [field] })
      else ops.push({ op: 'set', path: [field], value: staged.value })
    }
    return ops.length === 0 ? undefined : ops
  }

  /** Stage another version of the rule list. */
  private stageRules(rules: EnvInjectorRule[]): void {
    if (this.disposed) return
    this.staged.set('rules', { kind: 'set', value: rules })
    this.failed = false
    this.publish()
  }

  /** Stage one field's replacement value. */
  private stageSet(field: CardField, value: EnvInjectorSection[CardField]): void {
    if (this.disposed) return
    this.staged.set(field, { kind: 'set', value })
    this.failed = false
    this.publish()
  }

  /** Build the actions and the snapshot source the component receives. */
  private buildFace(): EnvInjectorCardFace {
    return {
      hooks: { envInjectorCard: this.source },
      editRule: (index, patch) => {
        const rules = this.draftRules()
        const current = rules[index]
        if (current === undefined) return
        rules[index] = { ...current, ...patch }
        this.stageRules(rules)
      },
      addRule: () => {
        const rules = this.draftRules()
        rules.push(newRule())
        this.stageRules(rules)
      },
      removeRule: (index) => {
        const rules = this.draftRules()
        if (rules[index] === undefined) return
        rules.splice(index, 1)
        this.stageRules(rules)
      },
      setOption: (field, value) => {
        this.stageSet(field, value)
      },
      resetField: (field) => {
        if (this.disposed) return
        this.staged.set(field, { kind: 'clear' })
        this.failed = false
        this.publish()
      },
      discard: () => {
        if (this.disposed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
      save: () => {
        if (this.disposed || this.saving) return
        const ops = this.plan()
        if (ops === undefined) return
        const written = ops.map((op) => op.path[0] as CardField)
        this.saving = true
        this.failed = false
        this.publish()
        void this.scope.mutate(ops).then(
          () => {
            if (this.disposed) return
            for (const field of written) this.staged.delete(field)
            this.saving = false
            this.publish()
          },
          () => {
            /* The Host is the only authority on whether a value was accepted, so
             * a refusal keeps the drafts for correction instead of discarding
             * edits the user would have to retype. */
            if (this.disposed) return
            this.saving = false
            this.failed = true
            this.publish()
          },
        )
      },
    }
  }
}
