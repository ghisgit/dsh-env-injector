/**
 * dsh-env-injector — rule-driven, per-spawn environment injection for the
 * DeepSeek Harness.
 *
 * DSH builds every child environment from {@link scrubbedParentEnv}, which
 * removes credential-shaped names (`/KEY|PASSWORD|SECRET|TOKEN/i`) and every
 * `DSH_*` name before the spawn spec's explicit `env` layer is merged on top.
 * That is the right default, but it also means `gh`, `git`, `npm` and friends
 * never see `GH_TOKEN`/`NODE_AUTH_TOKEN` even when the harness process itself
 * has them.
 *
 * This plugin restores exactly the entries a user asks for, exactly where the
 * user asks for them:
 *
 * 1. It wraps `ctx.subprocess.spawn` (the one seam every harness shell tool
 *    spawns through) and nothing else.
 * 2. Before calling the original `spawn`, it matches the spawn's `argv`
 *    against the configured rules. A rule matches on the executable name
 *    (regex, tested against the basename of the executable) and optionally on
 *    a regex over that command's argument text.
 * 3. On a match it reads the value from `process.env` and hands the original
 *    `spawn` a NEW spec object whose `env` is `{ ...spec.env, [envVar]: value }`.
 *
 * Consequences that follow from that design:
 *
 * - **Per-command only.** `process.env` is never written, and no other spawn
 *   is affected; the injected entry lives in one spec object.
 * - **The caller's environment always survives.** Injection appends to the
 *   caller's own `env` map (bash's `NO_COLOR`/`TERM`/`PAGER` overrides, a
 *   trusted caller's explicit entries) instead of replacing it.
 * - **Nothing to inject means nothing changes.** An unmatched command, a
 *   disabled rule, or an unset/empty source variable returns the caller's
 *   original spec object unchanged — not a copy — so the pass-through path is
 *   byte-for-byte the unwrapped behavior.
 * - **Rules are live.** They resolve from schema defaults, then the profile's
 *   composition entry (`cordis.patch.yml`), then the user's `settings.yaml`
 *   section, and a committed change swaps the compiled rule set for the next
 *   spawn without a restart.
 * - **The read guard is a separate, weaker promise.** Injecting a value creates
 *   a process that can print it, so two guards exist: `guard.reads` refuses
 *   injection into the commands whose purpose is reading the environment
 *   (`env`, `printenv`, …), and `guard.redactOutput` rewrites injected values
 *   out of tool results. Neither is a sandbox — see the README's security notes
 *   for what they do not stop.
 *
 * The plugin deliberately does not wrap `spawnTerminal` (interactive PTY
 * sessions are not the credentialed batch commands this exists for), does not
 * touch `resolveExecutable`, and never injects a `DSH_*` name.
 *
 * @module dsh-env-injector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Logger } from '@deepseek-ai/cordis'
/* Type-only: pulls in `@deepseek-ai/dsh-settings`'s `Context.settings`
 * augmentation so the optional settings service is typed here. Nothing from
 * this package is required at runtime. */
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
/* Type-only: the tool-registry slice the optional redaction hook consumes. */
import type { ToolResultBlock, ToolDecision, ToolResultLike } from './tools.js'
import { asToolEventSource } from './tools.js'

/* ────────────────────────────────────────────────────────────────────────────
 * Plugin identity
 * ──────────────────────────────────────────────────────────────────────────── */

/** Plugin name shown by the loader and used for this plugin's logger. */
export const name = 'env-injector'

/**
 * The subprocess seam is the single service this plugin needs; declaring it as
 * an injected dependency is also what makes the patch survive a provider
 * reload: cordis keys a fiber's epoch on the providing fibers' uids, so when
 * `ctx.subprocess` is re-provided the plugin is disposed (restoring the
 * original `spawn`) and re-applied against the new instance.
 *
 * The settings service is resolved optionally at runtime
 * (`ctx.inject(['settings'], …)`) because the plugin is fully functional
 * without it: the composition entry is then the only rule source.
 */
export const inject = ['subprocess']

/**
 * The user-settings namespace this plugin owns. A `env-injector:` section in
 * `$DSH_HOME/settings.yaml` overrides the composition entry, and the settings
 * provider hot-publishes external edits to that file.
 */
export const NS = 'env-injector'

/* ────────────────────────────────────────────────────────────────────────────
 * Configuration surface
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One injection rule, exactly as the user writes it.
 *
 * Both regex fields are stored as **strings**, never as `RegExp` values: a
 * settings section has to be losslessly JSON-serializable (that is what makes
 * it persistable, deep-equal comparable, and describable to a browser
 * configuration surface), so the plugin compiles the patterns itself. Write
 * them as plain regex source text in YAML — no slashes, no flags — and use
 * {@link EnvInjectorRule.flags} when flags are needed.
 */
export interface EnvInjectorRule {
  /**
   * Regex matched against the executable's file name — the basename, so
   * `/usr/bin/gh` is tested as `gh` (the full word is tried as a fallback, so
   * an absolute-path regex like `^/usr/bin/gh$` also works).
   *
   * Unanchored regex semantics apply: `gh` matches `gh`, `gh.exe`, and also
   * `gh-tool`. Anchor with `^…$` for an exact name.
   */
  command: string
  /**
   * Optional regex matched against the matched command's argument text (the
   * words after the executable, joined by single spaces). Empty means "any
   * arguments". Anchored per-command text, so `^(push|fetch)\b` selects only
   * those subcommands; tolerating git's leading global flags is the rule
   * author's business (the README's recipe section carries a ready-made
   * pattern for it).
   */
  argsPattern: string
  /**
   * The environment variable to forward: the name read from `process.env` and
   * the name injected into the child. Never `DSH_*` — those belong to the
   * harness.
   */
  envVar: string
  /** Whether this rule participates in matching. Disabled rules are inert. */
  enabled: boolean
  /** Regex flags for both patterns (e.g. `i`). Must be valid `RegExp` flags. */
  flags: string
}

/** Whether a prompt-composed shell command line may receive injected values. */
export type GuardShellPolicy = 'off' | 'model'

/**
 * The resolved `guard` section: what this plugin refuses to do with a value it
 * holds, and whether that value is scrubbed from tool results.
 */
export interface GuardConfig {
  /**
   * Refuse injection into guard-specific read commands. `true` (the default)
   * keeps THIS plugin from being the thing that hands a credential to `env`,
   * `printenv` and friends.
   */
  reads: boolean
  /**
   * Whether a shell command line the model composed (`bash -c '…'`, the shape
   * `dsh-bash-tool` always produces, sandbox wrapping included) may still
   * receive values.
   *
   * `'off'` (the default) keeps today's behaviour: `bash -c 'git push'` gets
   * the token, and so does `bash -c 'echo $GH_TOKEN'` — which is only mitigated
   * by {@link GuardConfig.redactOutput}, never prevented. `'model'` refuses
   * injection whenever the spawn's argv is a shell carrying a command line, so
   * a value can never reach a process whose command line the caller composed.
   */
  shells: GuardShellPolicy
  /**
   * Replace injected values found in tool results with {@link GuardConfig.marker}.
   * This is harm reduction, not a guarantee: an encoded, split or relayed value
   * can still reach the model (see the README's security notes).
   */
  redactOutput: boolean
  /** Replacement text; `{name}` is substituted with the variable's name. */
  marker: string
  /**
   * Read commands to refuse, replacing {@link DEFAULT_READ_COMMANDS} when
   * non-empty. Matched case-insensitively against an invocation's command name
   * (and its full path), so `env` covers `/usr/bin/env`.
   */
  denyCommands: string[]
}

/**
 * Commands that exist to read or rewrite the environment, refused by default
 * as injection targets ({@link GuardConfig.reads}).
 *
 * The list is deliberately limited to commands whose *purpose* is the
 * environment — a heuristic, not a boundary — so that narrowing a rule set
 * stays the real control. It is matched case-insensitively, which is what makes
 * the Windows spellings (`SET`, `Get-ChildItem Env:`) covered too.
 */
export const DEFAULT_READ_COMMANDS: readonly string[] = [
  'env', 'printenv', 'set', 'export', 'declare', 'typeset', 'readonly', 'local', 'unset', 'compgen',
  'gci', 'get-childitem', 'get-item', 'gi',
]

/** Accepted input for the `guard` section: every field has a default. */
export interface GuardConfigInput {
  reads?: boolean
  shells?: GuardShellPolicy
  redactOutput?: boolean
  marker?: string
  denyCommands?: string[]
}

/** Schemastery schema of the `guard` section. */
export const GuardSchema: z<GuardConfigInput, GuardConfig> = z
  .object({
    reads: z.boolean().default(true),
    shells: z.union([z.const('off'), z.const('model')]).default('off'),
    redactOutput: z.boolean().default(true),
    marker: z.string().default('[redacted:{name}]'),
    denyCommands: z.array(z.string()).default([]),
  })
  .description('Refuse the read paths that would hand an injected value back to the model.')

/** The resolved `env-injector` section. */
export interface EnvInjectorConfig {
  /** Ordered rule list; every matching rule contributes its variable. */
  rules: EnvInjectorRule[]
  /**
   * Whether an injected value replaces an entry the caller already passed in
   * `spec.env`. `true` (the default) means the harness-process value wins,
   * which keeps a model-supplied `env` from spoofing the variable; `false`
   * means an explicitly supplied caller value is left alone.
   */
  overrideExisting: boolean
  /**
   * Whether rules also apply to `ctx.subprocess.spawnTerminal` (PTY sessions).
   *
   * Those sessions are long-lived and run many commands inside ONE process, so
   * a rule matches the terminal's own executable — a persistent-shell
   * composition (`minimal` preset) is reached with a rule on the shell itself
   * (`^bash$`, `^pwsh$`), not on the commands typed into it. Leave it on when
   * such sessions must see the variables; the default costs nothing for
   * command-shaped rules, which a shell's own argv never matches.
   */
  terminal: boolean
  /** Log every match/miss (info/debug). Off by default to keep spawns quiet. */
  logMatches: boolean
  /** Refuse the read paths that would hand an injected value back to the model. */
  guard: GuardConfig
}

/**
 * Accepted input for one rule: the fields the schema draws defaults for are
 * optional here, which is what a YAML author actually writes.
 */
export interface EnvInjectorRuleInput {
  command?: string
  argsPattern?: string
  envVar: string
  enabled?: boolean
  flags?: string
}

/** Accepted input for the whole section (the defaults-free shape). */
export interface EnvInjectorConfigInput {
  rules?: EnvInjectorRuleInput[]
  overrideExisting?: boolean
  terminal?: boolean
  logMatches?: boolean
  guard?: GuardConfigInput
}

/** Schemastery schema of one rule. */
export const RuleSchema: z<EnvInjectorRuleInput, EnvInjectorRule> = z
  .object({
    command: z.string().default('.*'),
    argsPattern: z.string().default(''),
    envVar: z.string(),
    enabled: z.boolean().default(true),
    flags: z.string().default(''),
  })
  .description('One command→environment injection rule.')

/**
 * Schemastery schema of the `env-injector` section. It is the single source of
 * truth for this plugin's defaults: the loader uses it to normalize the
 * composition entry, the settings service uses it to resolve (and validate)
 * the user layer above it, and configuration surfaces serialize it via
 * `schema.toJSON()`.
 *
 * `rules` defaults to an **empty list**: the plugin ships no injection of its
 * own, so an unconfigured install is inert and only the rules a deployment
 * writes are ever applied. There is deliberately no built-in `GH_TOKEN` (or
 * any other credential) rule.
 */
export const Config: z<EnvInjectorConfigInput, EnvInjectorConfig> = z
  .object({
    rules: z.array(RuleSchema).default([]),
    overrideExisting: z.boolean().default(true),
    terminal: z.boolean().default(true),
    logMatches: z.boolean().default(false),
    guard: GuardSchema,
  })
  .description('Rule-driven environment injection for matching child commands.')

/* ────────────────────────────────────────────────────────────────────────────
 * Rule compilation
 * ──────────────────────────────────────────────────────────────────────────── */

/** A {@link EnvInjectorRule} with its regexes compiled, ready for matching. */
export interface CompiledRule {
  /** Position in the configured rule list, used in diagnostics. */
  readonly index: number
  readonly command: RegExp
  readonly argsPattern: RegExp | undefined
  readonly envVar: string
}

/** The compiled form of a {@link GuardConfig}: the read-command set pre-lowercased. */
export interface CompiledGuard {
  readonly reads: boolean
  readonly shells: GuardShellPolicy
  readonly redactOutput: boolean
  readonly marker: string
  /** Lower-cased command names refused as injection targets. */
  readonly deny: ReadonlySet<string>
}

/** The compiled form of a whole {@link EnvInjectorConfig}. */
export interface CompiledConfig {
  readonly rules: readonly CompiledRule[]
  readonly overrideExisting: boolean
  readonly logMatches: boolean
  readonly guard: CompiledGuard
}

/**
 * Compile one rule's regex sources, naming the offending field in the error.
 * @param rule - the configured rule.
 * @param index - its position in the list, for diagnostics.
 * @returns the compiled rule.
 * @throws {Error} when a pattern or the flag set is not a valid RegExp.
 */
export function compileRule(rule: EnvInjectorRule, index: number): CompiledRule {
  const compile = (field: 'command' | 'argsPattern', source: string): RegExp | undefined => {
    if (field === 'argsPattern' && source.trim().length === 0) return undefined
    try {
      return new RegExp(source, rule.flags)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`${NS}: rules[${String(index)}].${field} is not a valid regular expression (${JSON.stringify(source)}): ${reason}`)
    }
  }
  if (rule.envVar.trim().length === 0) throw new Error(`${NS}: rules[${String(index)}].envVar must be a non-empty environment variable name`)
  const command = compile('command', rule.command)
  /* v8 ignore next -- a `command` pattern with an empty source is caught below. */
  if (command === undefined) throw new Error(`${NS}: rules[${String(index)}].command must not be empty`)
  return {
    index,
    command,
    argsPattern: compile('argsPattern', rule.argsPattern),
    envVar: rule.envVar,
  }
}

/**
 * Compile a resolved guard section: lower-case the refused command names so
 * matching is case-insensitive on every platform.
 * @param guard - the resolved `guard` section.
 * @returns its matching form.
 */
export function compileGuard(guard: GuardConfig): CompiledGuard {
  const configured = guard.denyCommands.filter((entry) => entry.trim().length > 0)
  const names = configured.length > 0 ? configured : DEFAULT_READ_COMMANDS
  return {
    reads: guard.reads,
    shells: guard.shells,
    redactOutput: guard.redactOutput,
    marker: guard.marker,
    deny: new Set(names.map((entry) => executableName(entry.trim()).toLowerCase())),
  }
}

/**
 * Compile a resolved config into its matching form, dropping disabled rules.
 *
 * A caller that builds an {@link EnvInjectorConfig} by hand may omit `guard`
 * (tests do, and so would any embedder); an absent guard compiles to the schema
 * defaults rather than throwing, so injection keeps working while the guard
 * falls back to its safe default.
 *
 * @param config - the resolved `env-injector` section.
 * @returns the compiled rules plus the matching-time options.
 * @throws {Error} when any enabled rule holds an invalid regex.
 */
export function compileConfig(config: EnvInjectorConfig): CompiledConfig {
  const rules: CompiledRule[] = []
  config.rules.forEach((rule, index) => {
    if (!rule.enabled) return
    rules.push(compileRule(rule, index))
  })
  return {
    rules,
    overrideExisting: config.overrideExisting,
    logMatches: config.logMatches,
    guard: compileGuard(config.guard ?? Config({}).guard),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Invocation extraction
 * ──────────────────────────────────────────────────────────────────────────── */

/** One command found in a spawn's argv: what runs, and with which arguments. */
export interface Invocation {
  /** The executable's file name, e.g. `gh`. */
  readonly command: string
  /** The full executable word, e.g. `/usr/bin/gh`. */
  readonly path: string
  /** The words after the executable, joined by single spaces. */
  readonly args: string
}

/** Shells whose `-c`-style operand holds the real command line. */
const SHELL_NAMES = new Set([
  'bash', 'sh', 'dash', 'ash', 'zsh', 'ksh', 'ksh93', 'mksh', 'fish', 'csh', 'tcsh',
  'pwsh', 'pwsh-preview', 'powershell', 'cmd', 'cmd.exe',
])

/** The flag that introduces a shell's command string. */
const SHELL_COMMAND_FLAGS = new Set(['-c', '/c', '/k', '-command', '-cmd'])

/**
 * Whether one argv word is the flag that introduces a shell's command string.
 *
 * Long options and Windows switches are matched exactly (`-Command`, `/c`); a
 * POSIX short-option cluster counts when it carries `c`, because `c` is the
 * documented spelling of "read the command from the next operand" and shells
 * are routinely invoked as `bash -lc '…'`, `sh -ec '…'` or `bash -ic '…'`.
 * Without this, `bash -lc 'gh pr list'` reads as an opaque direct argv: no rule
 * matches it and no guard can see what it will run.
 *
 * @param word - one argv word.
 * @returns whether it selects the command operand.
 */
function isShellCommandFlag(word: string): boolean {
  const lower = word.toLowerCase()
  if (SHELL_COMMAND_FLAGS.has(lower)) return true
  return /^-[A-Za-z]+$/.test(word) && lower.includes('c')
}

/**
 * Words that wrap another command. They contribute nothing to matching, so
 * `env GH_HOST=x gh pr list`, `sudo -E git push` and `nohup gh …` still match
 * their inner command.
 */
const COMMAND_WRAPPERS = new Set([
  'env', 'sudo', 'doas', 'nohup', 'time', 'command', 'exec', 'nice', 'ionice', 'setsid', 'stdbuf', 'timeout', 'arch', 'builtin',
])

/** Shell operators that separate one command from the next. */
const SEGMENT_SEPARATORS = new Set([';', '|', '&', '\n'])

/** `NAME=value` environment assignment prefix inside a shell command line. */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A bare integer operand, e.g. the duration of `timeout 30 …`. */
const NUMERIC_OPERAND = /^-?\d+$/

/**
 * How many nested shell wrappers to unwrap before giving up. One level covers
 * every harness shape; the extra levels make an explicitly nested shell
 * (`bash -c 'bash -c "gh pr list"'`) match too.
 */
const MAX_SHELL_DEPTH = 3

/**
 * The trailing file name of an executable word, for both POSIX and Windows
 * separators: `/usr/bin/gh` → `gh`, `C:\\tools\\gh.exe` → `gh.exe`.
 * @param word - the executable word as written.
 * @returns its file name.
 */
export function executableName(word: string): string {
  const separators = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'))
  return separators === -1 ? word : word.slice(separators + 1)
}

/**
 * Strip leading pure-assignment statements from a shell command line. The pwsh
 * executor prepends an encoding preamble (`[Console]::OutputEncoding = …; `)
 * to the user's command, and a POSIX line may open with `FOO=bar; …`; neither
 * is part of the command the rules are written against.
 * @param line - the raw command string.
 * @returns the line without leading assignment statements.
 */
function stripLeadingAssignments(line: string): string {
  let rest = line.trimStart()
  for (let guard = 0; guard < 8; guard += 1) {
    const separator = findStatementEnd(rest)
    if (separator === -1) return rest
    const statement = rest.slice(0, separator).trim()
    const isAssignment = ASSIGNMENT_PREFIX.test(statement) || /^(?:\[[^\]]*\]::|\$[A-Za-z_][A-Za-z0-9_]*\s*=)/.test(statement)
    if (!isAssignment) return rest
    rest = rest.slice(separator + 1).trimStart()
  }
  return rest
}

/**
 * Index of the `;` that ends the statement starting at index 0, ignoring
 * separators inside quotes.
 * @param line - the command line to scan.
 * @returns the separator index, or `-1` when the line is a single statement.
 */
function findStatementEnd(line: string): number {
  let quote: string | undefined
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else if (character === '\\' && quote === '"') index += 1
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === ';') return index
  }
  return -1
}

/**
 * Split a shell command line into words, honoring single and double quotes and
 * backslash escapes. Quotes only group; they are not kept in the result, so
 * `"/usr/bin/gh"` yields `/usr/bin/gh`.
 * @param segment - one command's text.
 * @returns its words, empty quoted words included.
 */
function splitWords(segment: string): string[] {
  const words: string[] = []
  let current = ''
  let started = false
  let quote: string | undefined
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]
    if (character === undefined) break
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else if (character === '\\' && quote === '"' && index + 1 < segment.length) {
        index += 1
        current += segment[index]
      } else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
      continue
    }
    if (character === '\\' && index + 1 < segment.length) {
      index += 1
      current += segment[index]
      started = true
      continue
    }
    if (character === ' ' || character === '\t' || character === '\r') {
      if (started) {
        words.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }
  if (started) words.push(current)
  return words
}

/**
 * Split a shell command line into its individual commands, ignoring separators
 * inside quotes. This is what makes `gh pr list && git push` match both rules.
 * @param line - the command string.
 * @returns one entry per command, trimmed and non-empty.
 */
function splitSegments(line: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | undefined
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === undefined) break
    if (quote !== undefined) {
      current += character
      if (character === quote) quote = undefined
      else if (character === '\\' && quote === '"' && index + 1 < line.length) {
        index += 1
        current += line[index]
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }
    if (character === '\\' && index + 1 < line.length) {
      index += 1
      current += character
      current += line[index]
      continue
    }
    if (SEGMENT_SEPARATORS.has(character)) {
      // Collapse `&&` and `||` into one separator.
      if ((character === '&' || character === '|') && line[index + 1] === character) index += 1
      segments.push(current)
      current = ''
      continue
    }
    current += character
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
}

/**
 * Reduce one command's words to the invocation the rules match against, by
 * skipping environment assignments and command wrappers (`sudo`, `env`,
 * `nohup`, …) together with their flags and any bare numeric operand.
 *
 * The skipped wrappers are COLLECTED rather than dropped: `env`, `sudo` and
 * friends run the inner command as a child, so they share the environment this
 * plugin injects and are therefore part of what the guard has to judge. Rules
 * deliberately do not see them (a `^gh$` rule must match `sudo gh …`), but
 * {@link GuardConfig.reads} must.
 *
 * @param words - the words of one shell segment.
 * @returns the invocation (absent when the segment is only wrappers, e.g. a
 *   trailing `… | env`) and the wrapper commands skipped to reach it.
 */
function invocationOfWords(words: readonly string[]): { invocation?: Invocation; wrappers: Invocation[] } | undefined {
  let index = 0
  const wrappers: Invocation[] = []
  while (index < words.length) {
    const word = words[index]
    if (word === undefined) break
    if (ASSIGNMENT_PREFIX.test(word)) {
      index += 1
      continue
    }
    const base = executableName(word)
    if (COMMAND_WRAPPERS.has(base)) {
      const start = index
      index += 1
      while (index < words.length) {
        const next = words[index]
        if (next === undefined) break
        if (next.startsWith('-') || NUMERIC_OPERAND.test(next)) index += 1
        else break
      }
      wrappers.push({ command: base, path: word, args: words.slice(start + 1, index).join(' ') })
      continue
    }
    if (word.length === 0) {
      index += 1
      continue
    }
    return { invocation: { command: base, path: word, args: words.slice(index + 1).join(' ') }, wrappers }
  }
  return wrappers.length === 0 ? undefined : { wrappers }
}

/**
 * The command string one shell invocation carries, if it is a shell launched
 * with a command flag (`bash -c …`, `pwsh -Command …`, `bash -lc …`).
 *
 * The operand is everything after the flag, re-joined as written: splitting the
 * invocation's `args` on spaces would collapse a quoted program path
 * (`bash -c '"/opt/my tool" run'`) into words the inner parser then misreads.
 *
 * @param invocation - the command to inspect.
 * @returns the operand text after the flag, or `undefined` when there is none.
 */
function nestedCommandLine(invocation: Invocation): string | undefined {
  if (!SHELL_NAMES.has(invocation.command.toLowerCase())) return undefined
  const words = invocation.args.split(' ').filter((word) => word.length > 0)
  const flagIndex = words.findIndex((word) => isShellCommandFlag(word))
  if (flagIndex === -1) return undefined
  return words.slice(flagIndex + 1).join(' ')
}

/**
 * Parse one shell command line into the commands it runs, unwrapping nested
 * shells (`bash -c 'bash -c "gh pr list"'`).
 * @param line - the command line text.
 * @param depth - how many shell wrappers were already unwrapped.
 * @returns the invocations found (in command-line order) plus every wrapper
 *   command skipped on the way.
 */
function expandCommandLine(line: string, depth: number): { invocations: Invocation[]; wrappers: Invocation[] } {
  const invocations: Invocation[] = []
  const wrappers: Invocation[] = []
  for (const segment of splitSegments(stripLeadingAssignments(line))) {
    const parsed = invocationOfWords(splitWords(segment))
    if (parsed === undefined) continue
    wrappers.push(...parsed.wrappers)
    if (parsed.invocation === undefined) continue
    const nested = depth < MAX_SHELL_DEPTH ? nestedCommandLine(parsed.invocation) : undefined
    if (nested !== undefined && nested.trim().length > 0) {
      const inner = expandCommandLine(nested, depth + 1)
      invocations.push(...inner.invocations)
      wrappers.push(...inner.wrappers)
    } else invocations.push(parsed.invocation)
  }
  return { invocations, wrappers }
}

/**
 * The command string a shell invocation in this argv carries, or `undefined`.
 *
 * The command string is not always `argv[0]`'s operand: a sandbox wraps the
 * caller's argv behind its own profile arguments, and a shell may put its own
 * flags before the command flag. Every shape below has to resolve to the same
 * inner command:
 *
 * ```text
 * ['bash', '-c', '<cmd>']                                          (unsandboxed)
 * ['pwsh', '-NoLogo', …, '-Command', '<cmd>']                      (pwsh)
 * ['bwrap', '--ro-bind', '/', '/', …, '--', 'bash', '-c', '<cmd>'] (Linux sandbox)
 * ['<landlock-launcher>', …grants…, '--', 'bash', '-c', '<cmd>']   (Linux sandbox)
 * ['sandbox-exec', '-p', '<profile>', 'bash', '-c', '<cmd>']       (macOS sandbox)
 * ```
 *
 * So the scan starts from the LAST command flag — the innermost one, whose
 * operand immediately follows it — and walks back to the shell that governs
 * it, allowing only further flags in between. A `-c` that belongs to a
 * non-shell (`git -c k=v push`) finds no shell and is ignored.
 *
 * @param argv - the spawn spec's argv.
 * @returns the inner command string, or `undefined`.
 */
function findShellCommandLine(argv: readonly string[]): string | undefined {
  for (let flagIndex = argv.length - 2; flagIndex >= 1; flagIndex -= 1) {
    const flag = argv[flagIndex]
    if (flag === undefined || !isShellCommandFlag(flag)) continue
    for (let index = flagIndex - 1; index >= 0; index -= 1) {
      const word = argv[index]
      if (word === undefined) break
      if (SHELL_NAMES.has(executableName(word).toLowerCase())) return argv[flagIndex + 1]
      if (!word.startsWith('-')) break
    }
  }
  return undefined
}

/**
 * Extract every command a spawn's argv can execute.
 *
 * Three shapes reach `ctx.subprocess.spawn` in a DSH deployment:
 *
 * - a shell invocation carrying the real work (`bash -c '<command line>'`,
 *   `pwsh … -Command '<command line>'` — the shapes `dsh-bash-local` and
 *   `dsh-pwsh-local` build), possibly wrapped by a sandbox launcher that puts
 *   its own profile arguments first, which is split into its individual
 *   commands so a rule can match any of them;
 * - a launcher that separates its arguments from the command with `--`
 *   (`bwrap … -- gh pr list`);
 * - a direct argv (`argv: ['gh', 'pr', 'list']`), which yields exactly one
 *   invocation.
 *
 * @param argv - the spawn spec's argv.
 * @returns the invocations found, in command-line order; possibly empty.
 * @see analyseSpawn for the same extraction plus the shell-carried fact.
 */
export function extractInvocations(argv: readonly string[]): Invocation[] {
  return analyseSpawn(argv).invocations
}

/** What one spawn's argv resolves to: the commands, the wrappers, and how they got there. */
export interface SpawnAnalysis {
  /** The commands the spawn runs, in command-line order; what the rules match. */
  readonly invocations: Invocation[]
  /**
   * Wrapper commands skipped to reach them (`env`, `sudo`, `nohup`, …). Rules
   * never see these, but they run the inner command as a child — and therefore
   * share its environment — so the guard must judge them.
   */
  readonly wrappers: Invocation[]
  /** Whether a shell carried the command line (a caller-composed command line). */
  readonly viaShell: boolean
}

/**
 * Extract a spawn's commands AND report how they are reached.
 *
 * {@link extractInvocations} is the matching view; this is the guard's view. The
 * difference matters because the harness shell tools never spawn the model's
 * command directly — `dsh-bash-local` builds `['bash','-c',<command line>]` and
 * the sandbox wraps that behind its own profile arguments — so "did a shell
 * carry this command line" is exactly "did the caller compose the command line
 * this process will run", which is what {@link GuardConfig.shells} governs.
 *
 * @param argv - the spawn spec's argv.
 * @returns the invocations, wrappers, and whether a shell carried the command line.
 */
export function analyseSpawn(argv: readonly string[]): SpawnAnalysis {
  const first = argv[0]
  if (first === undefined || first.length === 0) return { invocations: [], wrappers: [], viaShell: false }
  const commandLine = findShellCommandLine(argv)
  /* A shell carrying a non-blank command line is the caller composing commands,
   * whatever those commands turn out to be: `bash -c env` is still a composed
   * command line even though the only word left after unwrapping is a wrapper. */
  const composed = commandLine !== undefined && commandLine.trim().length > 0
  if (composed) {
    const expanded = expandCommandLine(commandLine, 0)
    if (expanded.invocations.length > 0) return { ...expanded, viaShell: true }
  }
  const separator = argv.lastIndexOf('--')
  if (separator > 0 && separator < argv.length - 1) {
    const inner = invocationOfWords(argv.slice(separator + 1))
    if (inner?.invocation !== undefined) {
      return { invocations: [inner.invocation], wrappers: inner.wrappers, viaShell: false }
    }
  }
  const direct = invocationOfWords(argv)
  if (direct?.invocation !== undefined) {
    return { invocations: [direct.invocation], wrappers: direct.wrappers, viaShell: composed }
  }
  if (direct !== undefined && direct.wrappers.length > 0) {
    /* A direct argv that is only wrappers (`env`, `nohup`) runs nothing itself,
     * but it is still the thing the caller asked for. */
    return { invocations: direct.wrappers, wrappers: [], viaShell: composed }
  }
  const fallback = { command: executableName(first), path: first, args: argv.slice(1).join(' ') }
  return { invocations: [fallback], wrappers: [], viaShell: composed || SHELL_NAMES.has(fallback.command.toLowerCase()) }
}

/**
 * Test a pattern without letting a user-supplied `g`/`y` flag make matching
 * order-dependent (`test` advances `lastIndex` on those flags).
 * @param pattern - the compiled pattern.
 * @param value - the text to test.
 * @returns whether the pattern matches anywhere in the text.
 */
function patternMatches(pattern: RegExp, value: string): boolean {
  if (pattern.global || pattern.sticky) pattern.lastIndex = 0
  return pattern.test(value)
}

/**
 * Test one invocation against one compiled rule. The command pattern is tried
 * against the executable's file name first and against the full word second,
 * so both `^gh$` and `^/usr/bin/gh$` select the same spawn.
 * @param invocation - the command to test.
 * @param rule - the compiled rule.
 * @returns whether the rule selects this command.
 */
function invocationMatches(invocation: Invocation, rule: CompiledRule): boolean {
  const commandMatches = patternMatches(rule.command, invocation.command)
    || (invocation.path !== invocation.command && patternMatches(rule.command, invocation.path))
  if (!commandMatches) return false
  if (rule.argsPattern === undefined) return true
  return patternMatches(rule.argsPattern, invocation.args)
}

/**
 * Select every compiled rule that matches any of a spawn's commands.
 * @param invocations - the commands found in the spawn's argv.
 * @param rules - the compiled rules.
 * @returns the matching rules, in configured order.
 */
export function matchRules(invocations: readonly Invocation[], rules: readonly CompiledRule[]): CompiledRule[] {
  return rules.filter((rule) => invocations.some((invocation) => invocationMatches(invocation, rule)))
}

/* ────────────────────────────────────────────────────────────────────────────
 * Spec rewriting
 * ──────────────────────────────────────────────────────────────────────────── */

/** Outcome of applying the rules to one spawn or terminal spec. */
export interface InjectionResult<T extends EnvBearingSpec = EnvBearingSpec> {
  /** The spec to hand to the original method (the input object when inert). */
  readonly spec: T
  /** Names actually injected, in rule order. */
  readonly injected: readonly string[]
  /** Rules that matched but had no usable source value. */
  readonly skipped: readonly { readonly envVar: string; readonly reason: 'unset' | 'caller' | 'guard' }[]
  /**
   * Rules whose value was withheld because the spawn is a read channel
   * ({@link GuardConfig.reads}) or a caller-composed shell command line
   * ({@link GuardConfig.shells}). Diagnostics only — the spec stays untouched.
   */
  readonly blocked: readonly {
    readonly envVar: string
    readonly rule: number
    readonly command: string
    /** Why the guard refused, e.g. `env reads or rewrites the environment`. */
    readonly reason: string
  }[]
}

/**
 * The part of a subprocess request this plugin rewrites. Both
 * `SubprocessSpawnSpec` (piped child) and `SubprocessTerminalSpawnSpec` (PTY
 * session) satisfy it, so one matcher and one injection rule cover both.
 */
export interface EnvBearingSpec {
  /** Executable and arguments; `argv[0]` is the program. */
  readonly argv?: readonly string[] | undefined
  /** Explicit environment layered after the provider's ambient scrub. */
  env?: Record<string, string | undefined> | undefined
}

/**
 * Sink for a matched rule whose source variable could not be used.
 * @param envVar - the variable that was expected.
 * @param message - the human-readable notice.
 */
export type InjectionWarning = (envVar: string, message: string) => void

/**
 * Which {@link CompiledGuard} rule refuses this spawn, if any.
 *
 * A refusal withholds EVERY matched value from the whole spawn, not just the
 * rule that hit the guard: `env GH_TOKEN=x gh pr list` runs `env` as part of the
 * same process tree, so handing the token to `gh` while "skipping" `env` would
 * protect nothing.
 *
 * @param invocations - the commands found in the spawn's argv.
 * @param viaShell - whether a shell carried the command line.
 * @param guard - the compiled guard.
 * @returns a human-readable reason, or `undefined` when injection may proceed.
 */
function guardRefusal(
  invocations: readonly Invocation[],
  viaShell: boolean,
  guard: CompiledGuard,
): string | undefined {
  if (guard.reads) {
    const denied = invocations.find((invocation) =>
      guard.deny.has(invocation.command.toLowerCase()) || guard.deny.has(invocation.path.toLowerCase()))
    if (denied !== undefined) return `${denied.command} reads or rewrites the environment`
  }
  if (guard.shells === 'model' && viaShell) return 'a shell carries a caller-composed command line'
  return undefined
}

/**
 * Apply the compiled rules to one spawn or terminal spec.
 *
 * The input spec is never mutated: on a successful match the result is a new
 * object whose `env` is `{ ...spec.env, [envVar]: value }`. When nothing
 * matches, the source variable is unset/empty, or the guard refuses the spawn,
 * the ORIGINAL spec object is returned, so an unaffected request behaves exactly
 * as it would without this plugin installed.
 *
 * @param spec - the caller's spec.
 * @param compiled - the current compiled rules and matching options.
 * @param warn - sink for the "matched but unset" notice.
 * @returns the spec to spawn with, plus what happened.
 */
export function injectEnvForSpec<T extends EnvBearingSpec>(
  spec: T,
  compiled: CompiledConfig,
  warn?: InjectionWarning,
): InjectionResult<T> {
  const inert: InjectionResult<T> = { spec, injected: [], skipped: [], blocked: [] }
  if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.argv) || compiled.rules.length === 0) return inert
  const { invocations, wrappers, viaShell } = analyseSpawn(spec.argv)
  if (invocations.length === 0) return inert
  /*
   * The guard is evaluated BEFORE and INDEPENDENTLY of the rules: whether a
   * spawn is a read channel is a property of the command, not of what a
   * deployment happened to configure. `env GH_TOKEN=x gh pr list` must be
   * refused even when no rule mentions `env` — and `env` is exactly the word
   * the rule matcher unwraps away, which is why wrappers are checked too.
   */
  const refusal = guardRefusal([...invocations, ...wrappers], viaShell, compiled.guard)
  const matches = matchRules(invocations, compiled.rules)
  if (refusal !== undefined && matches.length > 0) {
    return {
      spec,
      injected: [],
      skipped: matches.map((rule) => ({ envVar: rule.envVar, reason: 'guard' as const })),
      blocked: matches.map((rule) => ({
        envVar: rule.envVar,
        rule: rule.index,
        command: invocations.map((invocation) => invocation.command).join(', '),
        reason: refusal,
      })),
    }
  }
  if (matches.length === 0) return inert
  const env: Record<string, string | undefined> = { ...spec.env }
  const injected: string[] = []
  const skipped: { envVar: string; reason: 'unset' | 'caller' }[] = []
  for (const rule of matches) {
    const value = process.env[rule.envVar]
    if (value === undefined || value.length === 0) {
      skipped.push({ envVar: rule.envVar, reason: 'unset' })
      warn?.(rule.envVar, `rule ${String(rule.index)} matched ${invocations.map((invocation) => invocation.command).join(', ')} but ${rule.envVar} is not set (or empty) in the harness process environment; nothing injected`)
      continue
    }
    if (!compiled.overrideExisting && env[rule.envVar] !== undefined) {
      skipped.push({ envVar: rule.envVar, reason: 'caller' })
      continue
    }
    env[rule.envVar] = value
    injected.push(rule.envVar)
  }
  if (injected.length === 0) return { spec, injected, skipped, blocked: [] }
  return { spec: { ...spec, env }, injected, skipped, blocked: [] }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Output redaction
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Values shorter than this are never redacted: a two-character "secret" would
 * match half the alphabet and turn every result into noise. Every credential
 * worth injecting is longer than this.
 */
const MIN_REDACTABLE_BYTES = 8

/** How a redaction pair's text relates to the variable's value. */
export type RedactionForm = 'raw' | 'base64' | 'hex'

/** One literal to replace, and the variable name the replacement names. */
export interface RedactionPair {
  /** The literal text that may appear in a result. */
  readonly text: string
  /** How {@link RedactionPair.text} encodes the variable's value. */
  readonly form: RedactionForm
  /** The variable the literal came from, used for the marker. */
  readonly envVar: string
  /** The value's byte length, so ordering is by the underlying secret. */
  readonly bytes: number
}

/**
 * Build the literals to redact for the given variables: the value as-is, plus
 * the base64 and hex encodings that one shell pipeline would produce
 * (`base64 <<< "$TOKEN"`, `xxd -p`).
 *
 * The value is read from `process.env` HERE and never retained: pairs are
 * rebuilt per redaction, so a rotated variable is redacted at its current
 * value and this plugin holds no copy of a credential between calls.
 *
 * @param envVars - the variable names that were injected, in injection order.
 * @param env - the environment to read from (defaults to `process.env`).
 * @returns the pairs, longest secret first so a shared prefix cannot shadow a
 *   longer match; empty when every value is unset, empty, or too short.
 */
export function redactionPairs(
  envVars: Iterable<string>,
  env: Record<string, string | undefined> = process.env,
): RedactionPair[] {
  const pairs: RedactionPair[] = []
  const seen = new Set<string>()
  for (const envVar of [...envVars].sort()) {
    const value = env[envVar]
    if (value === undefined || value.length === 0) continue
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes < MIN_REDACTABLE_BYTES) continue
    const forms: [RedactionForm, string][] = [
      ['raw', value],
      ['base64', Buffer.from(value, 'utf8').toString('base64')],
      ['hex', Buffer.from(value, 'utf8').toString('hex')],
    ]
    for (const [form, text] of forms) {
      if (text.length === 0 || seen.has(text)) continue
      seen.add(text)
      pairs.push({ text, form, envVar, bytes })
    }
  }
  /* Encoded forms first: a byte sequence never survives base64/hex, but a
   * short secret can be a substring of its own longer encoding. */
  return pairs.sort((left, right) => (right.form === left.form ? right.bytes - left.bytes : left.form === 'raw' ? 1 : -1))
}

/** Whether a literal is a pure even-length hex string. */
function isHexText(text: string): boolean {
  return text.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(text)
}

/**
 * Replace every injected value in one text block.
 *
 * The marker's own literal is replaced first (with itself, as it must already
 * be redacted) so a secret containing the marker text cannot turn the marker
 * into a different string. A hit is only accepted when the literal actually
 * decodes back to a known value, which keeps a coincidental hex-looking word
 * from being masked.
 *
 * @param text - the model-facing text.
 * @param pairs - the literals to replace, from {@link redactionPairs}.
 * @param marker - the replacement, with `{name}` substituted.
 * @returns the redacted text, or the ORIGINAL string when nothing matched.
 */
export function redactValues(text: string, pairs: readonly RedactionPair[], marker: string): string {
  if (text.length === 0) return text
  let redacted = text
  for (const { text: literal, form, envVar } of pairs) {
    if (!redacted.includes(literal)) continue
    if (form !== 'raw') {
      const decoded = Buffer.from(literal, form).toString('utf8')
      if (!pairs.some((pair) => pair.form === 'raw' && pair.envVar === envVar && pair.text === decoded)) continue
    }
    redacted = redacted.split(literal).join(marker.replaceAll('{name}', envVar))
  }
  return redacted === text ? text : redacted
}

/**
 * Apply {@link redactValues} to every text block of a result projection.
 *
 * Only `text` blocks are rewritten: a JSON result's `value`, a `thinking` block
 * and any non-text block are returned by reference, so redaction cannot change
 * what a downstream tool parses or how a stored transcript replays.
 *
 * @param blocks - the content blocks of a tool result.
 * @param pairs - the literals to replace.
 * @param marker - the replacement, with `{name}` substituted.
 * @returns replacement blocks, or `undefined` when nothing matched.
 */
export function redactBlocks<T extends ToolResultBlock>(
  blocks: readonly T[],
  pairs: readonly RedactionPair[],
  marker: string,
): T[] | undefined {
  let changed = false
  const next = blocks.map((block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    const text = redactValues(block.text, pairs, marker)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? next : undefined
}

/**
 * Build the `tools/post-execute` listener that redacts injected values.
 *
 * Extracted from the plugin body so the redaction contract is testable without
 * a tool registry: the listener delegates with `next()` first (so a tool-owned
 * projection runs before redaction), returns the decision untouched unless it
 * accepted a content projection, and never touches `value` or `block`
 * decisions.
 *
 * @param read - thunk returning the current compiled config, read per call so a
 *   live settings change takes effect immediately.
 * @param injected - thunk returning the names this installation has injected.
 * @returns the listener to register on `tools/post-execute`.
 */
export function makeRedactionListener(
  read: () => CompiledConfig,
  injected: () => Iterable<string>,
): (exec: unknown, result: ToolResultLike, next: () => Promise<ToolDecision>) => Promise<ToolDecision> {
  return async (_exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    const guard = read().guard
    if (!guard.redactOutput) return decision
    const pairs = redactionPairs(injected())
    if (pairs.length === 0) return decision
    const content = redactBlocks((decision.content ?? result.content ?? []) as readonly ToolResultBlock[], pairs, guard.marker)
    if (content === undefined) return decision
    return {
      kind: 'accept',
      content,
      ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Installing the spawn wrapper
 * ──────────────────────────────────────────────────────────────────────────── */

/** The methods this plugin can wrap, in installation order. */
export const WRAPPED_METHODS = ['spawn', 'spawnTerminal'] as const

/** One of {@link WRAPPED_METHODS}. */
export type WrappedMethod = (typeof WRAPPED_METHODS)[number]

/**
 * The symbol cordis' traceable service proxy exposes its target under:
 * `ctx.subprocess` may be a proxy, and only the target instance is what every
 * caller reaches. Same key as cordis' own `symbols.original`.
 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/** Marks a runtime instance this plugin has already patched. */
const PATCH_MARKER = Symbol.for('dsh-env-injector.patched')

/** Runtimes currently carrying this plugin's wrapper. */
const PATCHED_RUNTIMES = new WeakSet<object>()

/** Compare two property descriptors by the fields that decide ownership. */
function sameDescriptor(left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.configurable === right.configurable
    && left.enumerable === right.enumerable
    && left.writable === right.writable
    && left.value === right.value
    && left.get === right.get
    && left.set === right.set
}

/**
 * Unwrap cordis' traceable service proxy down to the service instance.
 * @param view - the value read from `ctx.subprocess`.
 * @returns the instance whose own properties every caller resolves through.
 * @throws {TypeError} when the view is not an object.
 */
export function subprocessRuntime(view: unknown): Record<PropertyKey, unknown> {
  if (view === null || (typeof view !== 'object' && typeof view !== 'function')) {
    throw new TypeError(`${NS}: ctx.subprocess is not an object`)
  }
  const unwrapped = (view as Record<PropertyKey, unknown>)[CORDIS_ORIGINAL]
  if (unwrapped !== null && (typeof unwrapped === 'object' || typeof unwrapped === 'function')) return unwrapped as Record<PropertyKey, unknown>
  return view as Record<PropertyKey, unknown>
}

/**
 * Install the rule-matching wrapper around the given `ctx.subprocess` methods.
 *
 * The wrappers are installed as OWN data properties of the service instance
 * (`Object.defineProperty`), not by assigning through `ctx.subprocess`:
 * cordis' traceable proxy turns a method read into a fresh per-access proxy
 * and routes a method write onto a throwaway shadow object, so an assignment
 * would silently do nothing. Writing the descriptor onto the instance is what
 * makes every caller — and every later proxy read — see the wrapper.
 *
 * Teardown is equally careful: the wrappers first deactivate (any reference
 * still held passes its arguments straight through), then restore the previous
 * descriptor only if the currently installed one is still ours, so a wrapper
 * installed after this one is never clobbered.
 *
 * @param runtime - the unwrapped `ctx.subprocess` instance.
 * @param methods - the method names to wrap (`spawn`, and `spawnTerminal` when terminal sessions are covered).
 * @param read - thunk returning the current compiled rules.
 * @param log - this plugin's logger.
 * @param onInjected - called with the names a spawn actually received, so the
 *   caller can track which variables exist to redact from tool results.
 * @returns the disposer restoring the original methods.
 * @throws {TypeError} when a method cannot be patched.
 * @throws {Error} when this runtime already carries the patch.
 */
export function installSpawnInjection(
  runtime: Record<PropertyKey, unknown>,
  methods: readonly WrappedMethod[],
  read: () => CompiledConfig,
  log: Logger,
  onInjected?: (envVars: readonly string[]) => void,
): () => void {
  if (runtime[PATCH_MARKER] !== undefined || PATCHED_RUNTIMES.has(runtime)) {
    throw new Error(`${NS}: ctx.subprocess is already wrapped by this plugin (duplicate profile layer?)`)
  }
  if (!Object.isExtensible(runtime)) {
    throw new TypeError(`${NS}: ctx.subprocess is not extensible and cannot be wrapped`)
  }
  const originals = methods.map((method) => {
    const previous = Object.getOwnPropertyDescriptor(runtime, method)
    if (previous !== undefined && !previous.configurable) {
      throw new TypeError(`${NS}: ctx.subprocess.${method} is not configurable and cannot be wrapped`)
    }
    const original: unknown = runtime[method]
    if (typeof original !== 'function') {
      throw new TypeError(`${NS}: ctx.subprocess.${method} is not a function`)
    }
    return { method, previous, original: original as (...rest: unknown[]) => unknown }
  })
  let active = true
  /** Variables already reported as matched-but-unset, per installation. */
  const warned = new Set<string>()
  /** Refusals already reported, so a retry loop cannot flood the log. */
  const blocked = new Set<string>()
  const notify: InjectionWarning = (envVar, message) => {
    if (warned.has(envVar)) return
    warned.add(envVar)
    note(log, 'warn', message)
  }
  const installed = originals.map(({ method, previous, original }) => {
    const descriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: previous?.enumerable ?? false,
      writable: true,
      value: function envInjectorWrapper(this: unknown, ...args: unknown[]): unknown {
        if (!active) return Reflect.apply(original, this, args)
        const spec = args[0]
        if (spec === null || typeof spec !== 'object') return Reflect.apply(original, this, args)
        const compiled = read()
        const result = injectEnvForSpec(spec as EnvBearingSpec, compiled, notify)
        if (result.injected.length > 0) onInjected?.(result.injected)
        if (compiled.logMatches) {
          const command = (spec as EnvBearingSpec).argv?.join(' ') ?? ''
          if (result.injected.length > 0) note(log, 'info', `${method}: injected ${result.injected.join(', ')} for: ${command}`)
          else note(log, 'info', `${method}: no injection for: ${command}`)
        }
        /* A refusal is a security decision, so it is reported regardless of
         * `logMatches` — but it is reported once per (variable, command) pair,
         * because a tool runner retries and a chatty log helps nobody. */
        for (const block of result.blocked) {
          const seen = `${block.envVar}\u0000${block.command}`
          if (blocked.has(seen)) continue
          blocked.add(seen)
          note(log, 'info', `guard: refused ${block.envVar} (rule ${String(block.rule)}) for: ${block.command}`)
        }
        if (result.spec === spec) return Reflect.apply(original, this, args)
        return Reflect.apply(original, this, [result.spec, ...args.slice(1)])
      },
    }
    Object.defineProperty(runtime, method, descriptor)
    return { method, previous, descriptor }
  })
  Object.defineProperty(runtime, PATCH_MARKER, { configurable: true, enumerable: false, writable: false, value: true })
  PATCHED_RUNTIMES.add(runtime)
  return () => {
    active = false
    PATCHED_RUNTIMES.delete(runtime)
    for (const { method, previous, descriptor } of installed) {
      if (!sameDescriptor(Object.getOwnPropertyDescriptor(runtime, method), descriptor)) continue
      if (previous === undefined) Reflect.deleteProperty(runtime, method)
      else Object.defineProperty(runtime, method, previous)
    }
    Reflect.deleteProperty(runtime, PATCH_MARKER)
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Plugin entry
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Report one operator-facing notice.
 *
 * Cordis' logger is the idiomatic channel, and it is used here — but the
 * shipped DSH composition mounts no logger EXPORTER (`ctx.logger.exporter()`'s
 * default sink is an in-memory buffer), so logger output never reaches the
 * harness's own stdout/stderr. A deployment debugging "why did nothing happen"
 * can only read the process's log, which is why these notices are also written
 * to stderr — the same channel DSH's own operator messages use.
 *
 * Values are never included: a notice names variables, never their contents.
 *
 * @param log - this plugin's logger.
 * @param level - severity for the logger copy.
 * @param message - the notice text.
 */
function note(log: Logger, level: 'info' | 'warn', message: string): void {
  process.stderr.write(`[${name}] ${message}\n`)
  if (level === 'warn') log.warn(message)
  else log.info(message)
}

/** One-line summary of the rules in effect, for the load notice. */
function describeRules(rules: readonly CompiledRule[]): string {
  if (rules.length === 0) return 'no rules enabled'
  const shown = rules.slice(0, 5).map((rule) => `${rule.command.source}${rule.argsPattern === undefined ? '' : ` ${rule.argsPattern.source}`} → ${rule.envVar}`)
  return `${String(rules.length)} rule(s): ${shown.join('; ')}${rules.length > shown.length ? '; …' : ''}`
}

/**
 * One-line summary of the read guard, so a deployment log answers "is the
 * guard on, and how strict is it?" without reading the config back.
 * @param guard - the compiled guard.
 * @returns its human-readable state.
 */
export function describeGuard(guard: CompiledGuard): string {
  return `reads=${guard.reads ? 'deny' : 'off'} shells=${guard.shells} redact=${guard.redactOutput ? 'on' : 'off'}`
}

/**
 * Load the plugin: resolve the rule source, keep it current through
 * `ctx.settings`, and wrap `ctx.subprocess.spawn` for the plugin's lifetime.
 *
 * The resolved rule source is layered by the settings service: schema defaults,
 * then this profile's composition entry (the `env-injector` row in
 * `cordis.patch.yml`), then the user's `env-injector:` section in
 * `$DSH_HOME/settings.yaml`. `installSection` keeps the plugin working with the
 * entry alone when no settings provider is mounted, and re-derives the compiled
 * rules on every attach, detach, and committed change.
 *
 * @param ctx - the plugin context.
 * @param config - the normalized composition entry (all schema defaults applied).
 */
export function apply(ctx: Context, config: EnvInjectorConfig): void {
  const entry: EnvInjectorConfig = config ?? Config({})
  const log = ctx.logger(name)
  let source: () => EnvInjectorConfig = () => entry
  let compiled = compileConfig(entry)
  let settingsAttached = false

  /**
   * Re-derive the compiled rules from the currently authoritative source. A
   * regex the schema cannot judge is refused here as well, keeping the last
   * good rule set rather than disabling injection silently.
   */
  const rebuild = (): void => {
    try {
      compiled = compileConfig(source())
    } catch (error) {
      note(log, 'warn', `keeping the previous rules — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    /*
     * Preferred path (DSH >= 0.1.5): `installSection` registers this plugin's
     * composition entry as the namespace's base layer, hands back the
     * authoritative source thunk, re-derives on attach/detach and on every
     * committed change, refuses an unusable section at write time, and falls
     * back to the entry when the service detaches.
     *
     * Older settings providers expose only `register` + `watch`, so that pair
     * is wired by hand below. Both paths converge on the same state: `source`
     * plus a rebuilt `compiled`.
     */
    if (typeof settings.installSection === 'function') {
      settings.installSection(ctx, NS, Config, entry, {
        setSource: (current) => {
          source = current
        },
        onChange: rebuild,
        validate: (value) => {
          compileConfig(value)
        },
      })
    } else {
      const scope = settings.register(NS, Config, { base: entry })
      source = () => scope.get()
      rebuild()
      const unwatch = scope.watch(rebuild)
      ctx.effect(() => () => {
        if (typeof unwatch === 'function') unwatch()
        source = () => entry
        rebuild()
      }, 'env-injector: detach settings source')
    }
    settingsAttached = true
    /* The rules are now live-overridable, so say what they resolved to: this is
     * what makes "did my settings section win?" answerable from a deployment
     * log without any further tooling. */
    note(log, 'info', `settings namespace '${NS}' attached — ${describeRules(compiled.rules)}`)
  })

  const runtime = subprocessRuntime(ctx.get('subprocess'))
  const methods: WrappedMethod[] = entry.terminal ? [...WRAPPED_METHODS] : ['spawn']
  /**
   * Names this installation has actually injected. Only NAMES are kept — never
   * values: the redaction below re-reads `process.env` each time, so a rotated
   * variable needs no bookkeeping and this plugin holds no credential copy.
   */
  const injectedNames = new Set<string>()
  const uninstall = installSpawnInjection(runtime, methods, () => compiled, log, (names) => {
    for (const envVar of names) injectedNames.add(envVar)
  })
  ctx.effect(() => uninstall, 'env-injector: restore ctx.subprocess methods')

  /**
   * Redact injected values from tool results.
   *
   * This is the SECOND layer of the read guard, and the weaker one: it depends
   * on a value reaching a tool result verbatim (or one base64/hex step away).
   * A value that is split, re-encoded differently or relayed by the command
   * itself still reaches the model — the README says so plainly.
   *
   * The tools service is optional, exactly like settings: injection works
   * without it, and the wiring is feature-detected at runtime.
   */
  let redactionAttached = false
  ctx.inject(['tools'], (toolsCtx) => {
    /* `ctx.get` rather than `toolsCtx.tools`: this package declares no service
     * augmentation for the optional registry (see `src/tools.ts`), so the
     * lookup is the seam. */
    const tools = asToolEventSource(toolsCtx.get('tools'))
    if (tools === undefined) return
    tools.on('tools/post-execute', makeRedactionListener(() => compiled, () => injectedNames))
    redactionAttached = true
  })

  /*
   * The settings service attaches asynchronously, so the authoritative source
   * is only known one tick later — and that is exactly what an operator needs
   * from the harness log: that the wrapper is installed, which rules it will
   * use, which layer supplied them, and whether the read guard is doing
   * anything.
   */
  setTimeout(() => {
    note(log, 'info', `wrapping ctx.subprocess.${methods.join('/')} — ${describeRules(compiled.rules)} (source: ${settingsAttached ? 'settings.yaml over the composition entry' : 'composition entry only'})`)
    note(log, 'info', `guard: ${describeGuard(compiled.guard)}${redactionAttached ? '' : ' — output redaction unavailable (no tools service mounted)'}`)
    if (!compiled.guard.redactOutput || redactionAttached) return
    note(log, 'warn', 'guard.redactOutput is on but no tools service is mounted; injected values can still be echoed into a result')
  }, 0).unref()
}

export default { name, inject, Config, apply }
