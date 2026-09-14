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
/** The compiled form of a whole {@link EnvInjectorConfig}. */
export interface CompiledConfig {
    readonly rules: readonly CompiledRule[];
    readonly overrideExisting: boolean;
    readonly logMatches: boolean;
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
 * Compile a resolved config into its matching form, dropping disabled rules.
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
 */
export declare function extractInvocations(argv: readonly string[]): Invocation[];
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
        readonly reason: 'unset' | 'caller';
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
 * matches, or the source variable is unset/empty, the ORIGINAL spec object is
 * returned, so an unaffected request behaves exactly as it would without this
 * plugin installed.
 *
 * @param spec - the caller's spec.
 * @param compiled - the current compiled rules and matching options.
 * @param warn - sink for the "matched but unset" notice.
 * @returns the spec to spawn with, plus what happened.
 */
export declare function injectEnvForSpec<T extends EnvBearingSpec>(spec: T, compiled: CompiledConfig, warn?: InjectionWarning): InjectionResult<T>;
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
 * @returns the disposer restoring the original methods.
 * @throws {TypeError} when a method cannot be patched.
 * @throws {Error} when this runtime already carries the patch.
 */
export declare function installSpawnInjection(runtime: Record<PropertyKey, unknown>, methods: readonly WrappedMethod[], read: () => CompiledConfig, log: Logger): () => void;
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
