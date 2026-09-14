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
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ToolResultBlock, ToolDecision, ToolResultLike } from './tools.js';
/** Plugin name shown by the loader and used for this plugin's logger. */
export declare const name = "env-injector";
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
export declare const inject: string[];
/**
 * The user-settings namespace this plugin owns. A `env-injector:` section in
 * `$DSH_HOME/settings.yaml` overrides the composition entry, and the settings
 * provider hot-publishes external edits to that file.
 */
export declare const NS = "env-injector";
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
    command: string;
    /**
     * Optional regex matched against the matched command's argument text (the
     * words after the executable, joined by single spaces). Empty means "any
     * arguments". Anchored per-command text, so `^(push|fetch)\b` selects only
     * those subcommands; tolerating git's leading global flags is the rule
     * author's business (the README's recipe section carries a ready-made
     * pattern for it).
     */
    argsPattern: string;
    /**
     * The environment variable to forward: the name read from `process.env` and
     * the name injected into the child. Never `DSH_*` — those belong to the
     * harness.
     */
    envVar: string;
    /** Whether this rule participates in matching. Disabled rules are inert. */
    enabled: boolean;
    /** Regex flags for both patterns (e.g. `i`). Must be valid `RegExp` flags. */
    flags: string;
}
/** Whether a prompt-composed shell command line may receive injected values. */
export type GuardShellPolicy = 'off' | 'model';
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
    reads: boolean;
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
    shells: GuardShellPolicy;
    /**
     * Replace injected values found in tool results with {@link GuardConfig.marker}.
     * This is harm reduction, not a guarantee: an encoded, split or relayed value
     * can still reach the model (see the README's security notes).
     */
    redactOutput: boolean;
    /** Replacement text; `{name}` is substituted with the variable's name. */
    marker: string;
    /**
     * Read commands to refuse **in addition to** {@link DEFAULT_READ_COMMANDS}.
     *
     * Adding a name can only make the guard stricter: the built-in list stays in
     * force no matter what this is set to, and a name that is already covered is
     * a no-op. This field once REPLACED the built-in list, which meant
     * `denyCommands: ['tee']` silently stopped refusing `env` — a security switch
     * must not weaken protection as a side effect of being configured.
     */
    denyCommands: string[];
    /**
     * Opt out of {@link DEFAULT_READ_COMMANDS} entirely, keeping only
     * {@link GuardConfig.denyCommands}. A deliberate escape hatch for a
     * deployment that needs one of those names injected; the load notice warns
     * whenever the built-in list is not in force.
     */
    denyCommandsOnly: boolean;
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
export declare const DEFAULT_READ_COMMANDS: readonly string[];
/** Accepted input for the `guard` section: every field has a default. */
export interface GuardConfigInput {
    reads?: boolean;
    shells?: GuardShellPolicy;
    redactOutput?: boolean;
    marker?: string;
    denyCommands?: string[];
    denyCommandsOnly?: boolean;
}
/** Schemastery schema of the `guard` section. */
export declare const GuardSchema: z<GuardConfigInput, GuardConfig>;
/** The resolved `env-injector` section. */
export interface EnvInjectorConfig {
    /** Ordered rule list; every matching rule contributes its variable. */
    rules: EnvInjectorRule[];
    /**
     * Whether an injected value replaces an entry the caller already passed in
     * `spec.env`. `true` (the default) means the harness-process value wins,
     * which keeps a model-supplied `env` from spoofing the variable; `false`
     * means an explicitly supplied caller value is left alone.
     */
    overrideExisting: boolean;
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
    terminal: boolean;
    /** Log every match/miss (info/debug). Off by default to keep spawns quiet. */
    logMatches: boolean;
    /** Refuse the read paths that would hand an injected value back to the model. */
    guard: GuardConfig;
}
/**
 * Accepted input for one rule: the fields the schema draws defaults for are
 * optional here, which is what a YAML author actually writes.
 */
export interface EnvInjectorRuleInput {
    command?: string;
    argsPattern?: string;
    envVar: string;
    enabled?: boolean;
    flags?: string;
}
/** Accepted input for the whole section (the defaults-free shape). */
export interface EnvInjectorConfigInput {
    rules?: EnvInjectorRuleInput[];
    overrideExisting?: boolean;
    terminal?: boolean;
    logMatches?: boolean;
    guard?: GuardConfigInput;
}
/** Schemastery schema of one rule. */
export declare const RuleSchema: z<EnvInjectorRuleInput, EnvInjectorRule>;
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
export declare const Config: z<EnvInjectorConfigInput, EnvInjectorConfig>;
/** A {@link EnvInjectorRule} with its regexes compiled, ready for matching. */
export interface CompiledRule {
    /** Position in the configured rule list, used in diagnostics. */
    readonly index: number;
    readonly command: RegExp;
    readonly argsPattern: RegExp | undefined;
    readonly envVar: string;
}
/** The compiled form of a {@link GuardConfig}: the read-command set pre-lowercased. */
export interface CompiledGuard {
    readonly reads: boolean;
    readonly shells: GuardShellPolicy;
    readonly redactOutput: boolean;
    readonly marker: string;
    /** Lower-cased command names refused as injection targets. */
    readonly deny: ReadonlySet<string>;
    /**
     * Built-in reader names the configuration has taken OUT of force. Empty
     * unless {@link GuardConfig.denyCommandsOnly} is set; the load notice reports
     * it so a deliberate opt-out is never silent.
     */
    readonly dropped: readonly string[];
}
/** The compiled form of a whole {@link EnvInjectorConfig}. */
export interface CompiledConfig {
    readonly rules: readonly CompiledRule[];
    readonly overrideExisting: boolean;
    readonly logMatches: boolean;
    readonly guard: CompiledGuard;
}
/**
 * Compile one rule's regex sources, naming the offending field in the error.
 * @param rule - the configured rule.
 * @param index - its position in the list, for diagnostics.
 * @returns the compiled rule.
 * @throws {Error} when a pattern or the flag set is not a valid RegExp.
 */
export declare function compileRule(rule: EnvInjectorRule, index: number): CompiledRule;
/**
 * Compile a resolved guard section: lower-case the refused command names so
 * matching is case-insensitive on every platform.
 *
 * The built-in reader list stays in force unless `denyCommandsOnly` opts out,
 * so a `denyCommands` entry can only ever ADD a refusal. This is deliberate:
 * configuring a security switch must not be able to weaken it by accident.
 *
 * @param guard - the resolved `guard` section.
 * @returns its matching form.
 */
export declare function compileGuard(guard: GuardConfig): CompiledGuard;
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
export declare function compileConfig(config: EnvInjectorConfig): CompiledConfig;
/** One command found in a spawn's argv: what runs, and with which arguments. */
export interface Invocation {
    /** The executable's file name, e.g. `gh`. */
    readonly command: string;
    /** The full executable word, e.g. `/usr/bin/gh`. */
    readonly path: string;
    /** The words after the executable, joined by single spaces. */
    readonly args: string;
}
/**
 * The trailing file name of an executable word, for both POSIX and Windows
 * separators: `/usr/bin/gh` → `gh`, `C:\\tools\\gh.exe` → `gh.exe`.
 * @param word - the executable word as written.
 * @returns its file name.
 */
export declare function executableName(word: string): string;
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
export declare function extractInvocations(argv: readonly string[]): Invocation[];
/** What one spawn's argv resolves to: the commands, the wrappers, and how they got there. */
export interface SpawnAnalysis {
    /** The commands the spawn runs, in command-line order; what the rules match. */
    readonly invocations: Invocation[];
    /**
     * Wrapper commands skipped to reach them (`env`, `sudo`, `nohup`, …). Rules
     * never see these, but they run the inner command as a child — and therefore
     * share its environment — so the guard must judge them.
     */
    readonly wrappers: Invocation[];
    /** Whether a shell carried the command line (a caller-composed command line). */
    readonly viaShell: boolean;
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
export declare function analyseSpawn(argv: readonly string[]): SpawnAnalysis;
/**
 * Select every compiled rule that matches any of a spawn's commands.
 * @param invocations - the commands found in the spawn's argv.
 * @param rules - the compiled rules.
 * @returns the matching rules, in configured order.
 */
export declare function matchRules(invocations: readonly Invocation[], rules: readonly CompiledRule[]): CompiledRule[];
/** Outcome of applying the rules to one spawn or terminal spec. */
export interface InjectionResult<T extends EnvBearingSpec = EnvBearingSpec> {
    /** The spec to hand to the original method (the input object when inert). */
    readonly spec: T;
    /** Names actually injected, in rule order. */
    readonly injected: readonly string[];
    /** Rules that matched but had no usable source value. */
    readonly skipped: readonly {
        readonly envVar: string;
        readonly reason: 'unset' | 'caller' | 'guard';
    }[];
    /**
     * Rules whose value was withheld because the spawn is a read channel
     * ({@link GuardConfig.reads}) or a caller-composed shell command line
     * ({@link GuardConfig.shells}). Diagnostics only — the spec stays untouched.
     */
    readonly blocked: readonly {
        readonly envVar: string;
        readonly rule: number;
        readonly command: string;
        /** Why the guard refused, e.g. `env reads or rewrites the environment`. */
        readonly reason: string;
    }[];
}
/**
 * The part of a subprocess request this plugin rewrites. Both
 * `SubprocessSpawnSpec` (piped child) and `SubprocessTerminalSpawnSpec` (PTY
 * session) satisfy it, so one matcher and one injection rule cover both.
 */
export interface EnvBearingSpec {
    /** Executable and arguments; `argv[0]` is the program. */
    readonly argv?: readonly string[] | undefined;
    /** Explicit environment layered after the provider's ambient scrub. */
    env?: Record<string, string | undefined> | undefined;
}
/**
 * Sink for a matched rule whose source variable could not be used.
 * @param envVar - the variable that was expected.
 * @param message - the human-readable notice.
 */
export type InjectionWarning = (envVar: string, message: string) => void;
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
export declare function injectEnvForSpec<T extends EnvBearingSpec>(spec: T, compiled: CompiledConfig, warn?: InjectionWarning): InjectionResult<T>;
/** How a redaction pair's text relates to the variable's value. */
export type RedactionForm = 'raw' | 'base64' | 'hex';
/** One literal to replace, and the variable name the replacement names. */
export interface RedactionPair {
    /** The literal text that may appear in a result. */
    readonly text: string;
    /** How {@link RedactionPair.text} encodes the variable's value. */
    readonly form: RedactionForm;
    /** The variable the literal came from, used for the marker. */
    readonly envVar: string;
    /** The value's byte length, so ordering is by the underlying secret. */
    readonly bytes: number;
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
export declare function redactionPairs(envVars: Iterable<string>, env?: Record<string, string | undefined>): RedactionPair[];
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
export declare function redactValues(text: string, pairs: readonly RedactionPair[], marker: string): string;
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
export declare function redactBlocks<T extends ToolResultBlock>(blocks: readonly T[], pairs: readonly RedactionPair[], marker: string): T[] | undefined;
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
export declare function makeRedactionListener(read: () => CompiledConfig, injected: () => Iterable<string>): (exec: unknown, result: ToolResultLike, next: () => Promise<ToolDecision>) => Promise<ToolDecision>;
/** The methods this plugin can wrap, in installation order. */
export declare const WRAPPED_METHODS: readonly ["spawn", "spawnTerminal"];
/** One of {@link WRAPPED_METHODS}. */
export type WrappedMethod = (typeof WRAPPED_METHODS)[number];
/**
 * Unwrap cordis' traceable service proxy down to the service instance.
 * @param view - the value read from `ctx.subprocess`.
 * @returns the instance whose own properties every caller resolves through.
 * @throws {TypeError} when the view is not an object.
 */
export declare function subprocessRuntime(view: unknown): Record<PropertyKey, unknown>;
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
export declare function installSpawnInjection(runtime: Record<PropertyKey, unknown>, methods: readonly WrappedMethod[], read: () => CompiledConfig, log: Logger, onInjected?: (envVars: readonly string[]) => void): () => void;
/**
 * One-line summary of the read guard, so a deployment log answers "is the
 * guard on, and how strict is it?" without reading the config back.
 * @param guard - the compiled guard.
 * @returns its human-readable state.
 */
export declare function describeGuard(guard: CompiledGuard): string;
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
export declare function apply(ctx: Context, config: EnvInjectorConfig): void;
declare const _default: {
    name: string;
    inject: string[];
    Config: z<EnvInjectorConfigInput, EnvInjectorConfig>;
    apply: typeof apply;
};
export default _default;
