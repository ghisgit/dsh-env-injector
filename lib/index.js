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
import z from '@deepseek-ai/schemastery';
/* ────────────────────────────────────────────────────────────────────────────
 * Plugin identity
 * ──────────────────────────────────────────────────────────────────────────── */
/** Plugin name shown by the loader and used for this plugin's logger. */
export const name = 'env-injector';
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
export const inject = ['subprocess'];
/**
 * The user-settings namespace this plugin owns. A `env-injector:` section in
 * `$DSH_HOME/settings.yaml` overrides the composition entry, and the settings
 * provider hot-publishes external edits to that file.
 */
export const NS = 'env-injector';
/** Schemastery schema of one rule. */
export const RuleSchema = z
    .object({
    command: z.string().default('.*'),
    argsPattern: z.string().default(''),
    envVar: z.string(),
    enabled: z.boolean().default(true),
    flags: z.string().default(''),
})
    .description('One command→environment injection rule.');
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
export const Config = z
    .object({
    rules: z.array(RuleSchema).default([]),
    overrideExisting: z.boolean().default(true),
    terminal: z.boolean().default(true),
    logMatches: z.boolean().default(false),
})
    .description('Rule-driven environment injection for matching child commands.');
/**
 * Compile one rule's regex sources, naming the offending field in the error.
 * @param rule - the configured rule.
 * @param index - its position in the list, for diagnostics.
 * @returns the compiled rule.
 * @throws {Error} when a pattern or the flag set is not a valid RegExp.
 */
export function compileRule(rule, index) {
    const compile = (field, source) => {
        if (field === 'argsPattern' && source.trim().length === 0)
            return undefined;
        try {
            return new RegExp(source, rule.flags);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`${NS}: rules[${String(index)}].${field} is not a valid regular expression (${JSON.stringify(source)}): ${reason}`);
        }
    };
    if (rule.envVar.trim().length === 0)
        throw new Error(`${NS}: rules[${String(index)}].envVar must be a non-empty environment variable name`);
    const command = compile('command', rule.command);
    /* v8 ignore next -- a `command` pattern with an empty source is caught below. */
    if (command === undefined)
        throw new Error(`${NS}: rules[${String(index)}].command must not be empty`);
    return {
        index,
        command,
        argsPattern: compile('argsPattern', rule.argsPattern),
        envVar: rule.envVar,
    };
}
/**
 * Compile a resolved config into its matching form, dropping disabled rules.
 * @param config - the resolved `env-injector` section.
 * @returns the compiled rules plus the matching-time options.
 * @throws {Error} when any enabled rule holds an invalid regex.
 */
export function compileConfig(config) {
    const rules = [];
    config.rules.forEach((rule, index) => {
        if (!rule.enabled)
            return;
        rules.push(compileRule(rule, index));
    });
    return { rules, overrideExisting: config.overrideExisting, logMatches: config.logMatches };
}
/** Shells whose `-c`-style operand holds the real command line. */
const SHELL_NAMES = new Set([
    'bash', 'sh', 'dash', 'ash', 'zsh', 'ksh', 'ksh93', 'mksh', 'fish', 'csh', 'tcsh',
    'pwsh', 'pwsh-preview', 'powershell', 'cmd', 'cmd.exe',
]);
/** The flag that introduces a shell's command string. */
const SHELL_COMMAND_FLAGS = new Set(['-c', '/c', '/k', '-command', '-cmd']);
/**
 * Words that wrap another command. They contribute nothing to matching, so
 * `env GH_HOST=x gh pr list`, `sudo -E git push` and `nohup gh …` still match
 * their inner command.
 */
const COMMAND_WRAPPERS = new Set([
    'env', 'sudo', 'doas', 'nohup', 'time', 'command', 'exec', 'nice', 'ionice', 'setsid', 'stdbuf', 'timeout', 'arch', 'builtin',
]);
/** Shell operators that separate one command from the next. */
const SEGMENT_SEPARATORS = new Set([';', '|', '&', '\n']);
/** `NAME=value` environment assignment prefix inside a shell command line. */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A bare integer operand, e.g. the duration of `timeout 30 …`. */
const NUMERIC_OPERAND = /^-?\d+$/;
/**
 * How many nested shell wrappers to unwrap before giving up. One level covers
 * every harness shape; the extra levels make an explicitly nested shell
 * (`bash -c 'bash -c "gh pr list"'`) match too.
 */
const MAX_SHELL_DEPTH = 3;
/**
 * The trailing file name of an executable word, for both POSIX and Windows
 * separators: `/usr/bin/gh` → `gh`, `C:\\tools\\gh.exe` → `gh.exe`.
 * @param word - the executable word as written.
 * @returns its file name.
 */
export function executableName(word) {
    const separators = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'));
    return separators === -1 ? word : word.slice(separators + 1);
}
/**
 * Strip leading pure-assignment statements from a shell command line. The pwsh
 * executor prepends an encoding preamble (`[Console]::OutputEncoding = …; `)
 * to the user's command, and a POSIX line may open with `FOO=bar; …`; neither
 * is part of the command the rules are written against.
 * @param line - the raw command string.
 * @returns the line without leading assignment statements.
 */
function stripLeadingAssignments(line) {
    let rest = line.trimStart();
    for (let guard = 0; guard < 8; guard += 1) {
        const separator = findStatementEnd(rest);
        if (separator === -1)
            return rest;
        const statement = rest.slice(0, separator).trim();
        const isAssignment = ASSIGNMENT_PREFIX.test(statement) || /^(?:\[[^\]]*\]::|\$[A-Za-z_][A-Za-z0-9_]*\s*=)/.test(statement);
        if (!isAssignment)
            return rest;
        rest = rest.slice(separator + 1).trimStart();
    }
    return rest;
}
/**
 * Index of the `;` that ends the statement starting at index 0, ignoring
 * separators inside quotes.
 * @param line - the command line to scan.
 * @returns the separator index, or `-1` when the line is a single statement.
 */
function findStatementEnd(line) {
    let quote;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quote !== undefined) {
            if (character === quote)
                quote = undefined;
            else if (character === '\\' && quote === '"')
                index += 1;
            continue;
        }
        if (character === '"' || character === "'")
            quote = character;
        else if (character === ';')
            return index;
    }
    return -1;
}
/**
 * Split a shell command line into words, honoring single and double quotes and
 * backslash escapes. Quotes only group; they are not kept in the result, so
 * `"/usr/bin/gh"` yields `/usr/bin/gh`.
 * @param segment - one command's text.
 * @returns its words, empty quoted words included.
 */
function splitWords(segment) {
    const words = [];
    let current = '';
    let started = false;
    let quote;
    for (let index = 0; index < segment.length; index += 1) {
        const character = segment[index];
        if (character === undefined)
            break;
        if (quote !== undefined) {
            if (character === quote)
                quote = undefined;
            else if (character === '\\' && quote === '"' && index + 1 < segment.length) {
                index += 1;
                current += segment[index];
            }
            else
                current += character;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            started = true;
            continue;
        }
        if (character === '\\' && index + 1 < segment.length) {
            index += 1;
            current += segment[index];
            started = true;
            continue;
        }
        if (character === ' ' || character === '\t' || character === '\r') {
            if (started) {
                words.push(current);
                current = '';
                started = false;
            }
            continue;
        }
        current += character;
        started = true;
    }
    if (started)
        words.push(current);
    return words;
}
/**
 * Split a shell command line into its individual commands, ignoring separators
 * inside quotes. This is what makes `gh pr list && git push` match both rules.
 * @param line - the command string.
 * @returns one entry per command, trimmed and non-empty.
 */
function splitSegments(line) {
    const segments = [];
    let current = '';
    let quote;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === undefined)
            break;
        if (quote !== undefined) {
            current += character;
            if (character === quote)
                quote = undefined;
            else if (character === '\\' && quote === '"' && index + 1 < line.length) {
                index += 1;
                current += line[index];
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            current += character;
            continue;
        }
        if (character === '\\' && index + 1 < line.length) {
            index += 1;
            current += character;
            current += line[index];
            continue;
        }
        if (SEGMENT_SEPARATORS.has(character)) {
            // Collapse `&&` and `||` into one separator.
            if ((character === '&' || character === '|') && line[index + 1] === character)
                index += 1;
            segments.push(current);
            current = '';
            continue;
        }
        current += character;
    }
    segments.push(current);
    return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}
/**
 * Reduce one command's words to the invocation the rules match against, by
 * skipping environment assignments and command wrappers (`sudo`, `env`,
 * `nohup`, …) together with their flags and any bare numeric operand.
 * @param words - the words of one shell segment.
 * @returns the invocation, or `undefined` when nothing executable remains.
 */
function invocationOfWords(words) {
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        if (word === undefined)
            break;
        if (ASSIGNMENT_PREFIX.test(word)) {
            index += 1;
            continue;
        }
        const base = executableName(word);
        if (COMMAND_WRAPPERS.has(base)) {
            index += 1;
            while (index < words.length) {
                const next = words[index];
                if (next === undefined)
                    break;
                if (next.startsWith('-') || NUMERIC_OPERAND.test(next))
                    index += 1;
                else
                    break;
            }
            continue;
        }
        if (word.length === 0) {
            index += 1;
            continue;
        }
        return { command: base, path: word, args: words.slice(index + 1).join(' ') };
    }
    return undefined;
}
/**
 * The command string one shell invocation carries, if it is a shell launched
 * with a command flag (`bash -c …`, `pwsh -Command …`).
 * @param invocation - the command to inspect.
 * @returns the operand text after the flag, or `undefined` when there is none.
 */
function nestedCommandLine(invocation) {
    if (!SHELL_NAMES.has(invocation.command.toLowerCase()))
        return undefined;
    const words = invocation.args.split(' ').filter((word) => word.length > 0);
    const flagIndex = words.findIndex((word) => SHELL_COMMAND_FLAGS.has(word.toLowerCase()));
    if (flagIndex === -1)
        return undefined;
    return words.slice(flagIndex + 1).join(' ');
}
/**
 * Parse one shell command line into the commands it runs, unwrapping nested
 * shells (`bash -c 'bash -c "gh pr list"'`).
 * @param line - the command line text.
 * @param depth - how many shell wrappers were already unwrapped.
 * @returns the invocations found, in command-line order.
 */
function expandCommandLine(line, depth) {
    const invocations = [];
    for (const segment of splitSegments(stripLeadingAssignments(line))) {
        const invocation = invocationOfWords(splitWords(segment));
        if (invocation === undefined)
            continue;
        const nested = depth < MAX_SHELL_DEPTH ? nestedCommandLine(invocation) : undefined;
        if (nested !== undefined && nested.trim().length > 0)
            invocations.push(...expandCommandLine(nested, depth + 1));
        else
            invocations.push(invocation);
    }
    return invocations;
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
function findShellCommandLine(argv) {
    for (let flagIndex = argv.length - 2; flagIndex >= 1; flagIndex -= 1) {
        const flag = argv[flagIndex];
        if (flag === undefined || !SHELL_COMMAND_FLAGS.has(flag.toLowerCase()))
            continue;
        for (let index = flagIndex - 1; index >= 0; index -= 1) {
            const word = argv[index];
            if (word === undefined)
                break;
            if (SHELL_NAMES.has(executableName(word).toLowerCase()))
                return argv[flagIndex + 1];
            if (!word.startsWith('-'))
                break;
        }
    }
    return undefined;
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
 */
export function extractInvocations(argv) {
    const first = argv[0];
    if (first === undefined || first.length === 0)
        return [];
    const commandLine = findShellCommandLine(argv);
    if (commandLine !== undefined && commandLine.trim().length > 0) {
        const invocations = expandCommandLine(commandLine, 0);
        if (invocations.length > 0)
            return invocations;
    }
    const separator = argv.lastIndexOf('--');
    if (separator > 0 && separator < argv.length - 1) {
        const inner = invocationOfWords(argv.slice(separator + 1));
        if (inner !== undefined)
            return [inner];
    }
    const direct = invocationOfWords(argv);
    if (direct !== undefined)
        return [direct];
    return [{ command: executableName(first), path: first, args: argv.slice(1).join(' ') }];
}
/**
 * Test a pattern without letting a user-supplied `g`/`y` flag make matching
 * order-dependent (`test` advances `lastIndex` on those flags).
 * @param pattern - the compiled pattern.
 * @param value - the text to test.
 * @returns whether the pattern matches anywhere in the text.
 */
function patternMatches(pattern, value) {
    if (pattern.global || pattern.sticky)
        pattern.lastIndex = 0;
    return pattern.test(value);
}
/**
 * Test one invocation against one compiled rule. The command pattern is tried
 * against the executable's file name first and against the full word second,
 * so both `^gh$` and `^/usr/bin/gh$` select the same spawn.
 * @param invocation - the command to test.
 * @param rule - the compiled rule.
 * @returns whether the rule selects this command.
 */
function invocationMatches(invocation, rule) {
    const commandMatches = patternMatches(rule.command, invocation.command)
        || (invocation.path !== invocation.command && patternMatches(rule.command, invocation.path));
    if (!commandMatches)
        return false;
    if (rule.argsPattern === undefined)
        return true;
    return patternMatches(rule.argsPattern, invocation.args);
}
/**
 * Select every compiled rule that matches any of a spawn's commands.
 * @param invocations - the commands found in the spawn's argv.
 * @param rules - the compiled rules.
 * @returns the matching rules, in configured order.
 */
export function matchRules(invocations, rules) {
    return rules.filter((rule) => invocations.some((invocation) => invocationMatches(invocation, rule)));
}
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
export function injectEnvForSpec(spec, compiled, warn) {
    const inert = { spec, injected: [], skipped: [] };
    if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.argv) || compiled.rules.length === 0)
        return inert;
    const invocations = extractInvocations(spec.argv);
    if (invocations.length === 0)
        return inert;
    const matches = matchRules(invocations, compiled.rules);
    if (matches.length === 0)
        return inert;
    const env = { ...spec.env };
    const injected = [];
    const skipped = [];
    for (const rule of matches) {
        const value = process.env[rule.envVar];
        if (value === undefined || value.length === 0) {
            skipped.push({ envVar: rule.envVar, reason: 'unset' });
            warn?.(rule.envVar, `rule ${String(rule.index)} matched ${invocations.map((invocation) => invocation.command).join(', ')} but ${rule.envVar} is not set (or empty) in the harness process environment; nothing injected`);
            continue;
        }
        if (!compiled.overrideExisting && env[rule.envVar] !== undefined) {
            skipped.push({ envVar: rule.envVar, reason: 'caller' });
            continue;
        }
        env[rule.envVar] = value;
        injected.push(rule.envVar);
    }
    if (injected.length === 0)
        return { spec, injected, skipped };
    return { spec: { ...spec, env }, injected, skipped };
}
/* ────────────────────────────────────────────────────────────────────────────
 * Installing the spawn wrapper
 * ──────────────────────────────────────────────────────────────────────────── */
/** The methods this plugin can wrap, in installation order. */
export const WRAPPED_METHODS = ['spawn', 'spawnTerminal'];
/**
 * The symbol cordis' traceable service proxy exposes its target under:
 * `ctx.subprocess` may be a proxy, and only the target instance is what every
 * caller reaches. Same key as cordis' own `symbols.original`.
 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original');
/** Marks a runtime instance this plugin has already patched. */
const PATCH_MARKER = Symbol.for('dsh-env-injector.patched');
/** Runtimes currently carrying this plugin's wrapper. */
const PATCHED_RUNTIMES = new WeakSet();
/** Compare two property descriptors by the fields that decide ownership. */
function sameDescriptor(left, right) {
    if (left === undefined || right === undefined)
        return left === right;
    return left.configurable === right.configurable
        && left.enumerable === right.enumerable
        && left.writable === right.writable
        && left.value === right.value
        && left.get === right.get
        && left.set === right.set;
}
/**
 * Unwrap cordis' traceable service proxy down to the service instance.
 * @param view - the value read from `ctx.subprocess`.
 * @returns the instance whose own properties every caller resolves through.
 * @throws {TypeError} when the view is not an object.
 */
export function subprocessRuntime(view) {
    if (view === null || (typeof view !== 'object' && typeof view !== 'function')) {
        throw new TypeError(`${NS}: ctx.subprocess is not an object`);
    }
    const unwrapped = view[CORDIS_ORIGINAL];
    if (unwrapped !== null && (typeof unwrapped === 'object' || typeof unwrapped === 'function'))
        return unwrapped;
    return view;
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
 * @returns the disposer restoring the original methods.
 * @throws {TypeError} when a method cannot be patched.
 * @throws {Error} when this runtime already carries the patch.
 */
export function installSpawnInjection(runtime, methods, read, log) {
    if (runtime[PATCH_MARKER] !== undefined || PATCHED_RUNTIMES.has(runtime)) {
        throw new Error(`${NS}: ctx.subprocess is already wrapped by this plugin (duplicate profile layer?)`);
    }
    if (!Object.isExtensible(runtime)) {
        throw new TypeError(`${NS}: ctx.subprocess is not extensible and cannot be wrapped`);
    }
    const originals = methods.map((method) => {
        const previous = Object.getOwnPropertyDescriptor(runtime, method);
        if (previous !== undefined && !previous.configurable) {
            throw new TypeError(`${NS}: ctx.subprocess.${method} is not configurable and cannot be wrapped`);
        }
        const original = runtime[method];
        if (typeof original !== 'function') {
            throw new TypeError(`${NS}: ctx.subprocess.${method} is not a function`);
        }
        return { method, previous, original: original };
    });
    let active = true;
    /** Variables already reported as matched-but-unset, per installation. */
    const warned = new Set();
    const notify = (envVar, message) => {
        if (warned.has(envVar))
            return;
        warned.add(envVar);
        note(log, 'warn', message);
    };
    const installed = originals.map(({ method, previous, original }) => {
        const descriptor = {
            configurable: true,
            enumerable: previous?.enumerable ?? false,
            writable: true,
            value: function envInjectorWrapper(...args) {
                if (!active)
                    return Reflect.apply(original, this, args);
                const spec = args[0];
                if (spec === null || typeof spec !== 'object')
                    return Reflect.apply(original, this, args);
                const compiled = read();
                const result = injectEnvForSpec(spec, compiled, notify);
                if (compiled.logMatches) {
                    const command = spec.argv?.join(' ') ?? '';
                    if (result.injected.length > 0)
                        note(log, 'info', `${method}: injected ${result.injected.join(', ')} for: ${command}`);
                    else
                        note(log, 'info', `${method}: no injection for: ${command}`);
                }
                if (result.spec === spec)
                    return Reflect.apply(original, this, args);
                return Reflect.apply(original, this, [result.spec, ...args.slice(1)]);
            },
        };
        Object.defineProperty(runtime, method, descriptor);
        return { method, previous, descriptor };
    });
    Object.defineProperty(runtime, PATCH_MARKER, { configurable: true, enumerable: false, writable: false, value: true });
    PATCHED_RUNTIMES.add(runtime);
    return () => {
        active = false;
        PATCHED_RUNTIMES.delete(runtime);
        for (const { method, previous, descriptor } of installed) {
            if (!sameDescriptor(Object.getOwnPropertyDescriptor(runtime, method), descriptor))
                continue;
            if (previous === undefined)
                Reflect.deleteProperty(runtime, method);
            else
                Object.defineProperty(runtime, method, previous);
        }
        Reflect.deleteProperty(runtime, PATCH_MARKER);
    };
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
function note(log, level, message) {
    process.stderr.write(`[${name}] ${message}\n`);
    if (level === 'warn')
        log.warn(message);
    else
        log.info(message);
}
/** One-line summary of the rules in effect, for the load notice. */
function describeRules(rules) {
    if (rules.length === 0)
        return 'no rules enabled';
    const shown = rules.slice(0, 5).map((rule) => `${rule.command.source}${rule.argsPattern === undefined ? '' : ` ${rule.argsPattern.source}`} → ${rule.envVar}`);
    return `${String(rules.length)} rule(s): ${shown.join('; ')}${rules.length > shown.length ? '; …' : ''}`;
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
export function apply(ctx, config) {
    const entry = config ?? Config({});
    const log = ctx.logger(name);
    let source = () => entry;
    let compiled = compileConfig(entry);
    let settingsAttached = false;
    /**
     * Re-derive the compiled rules from the currently authoritative source. A
     * regex the schema cannot judge is refused here as well, keeping the last
     * good rule set rather than disabling injection silently.
     */
    const rebuild = () => {
        try {
            compiled = compileConfig(source());
        }
        catch (error) {
            note(log, 'warn', `keeping the previous rules — ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.settings;
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
                    source = current;
                },
                onChange: rebuild,
                validate: (value) => {
                    compileConfig(value);
                },
            });
        }
        else {
            const scope = settings.register(NS, Config, { base: entry });
            source = () => scope.get();
            rebuild();
            const unwatch = scope.watch(rebuild);
            ctx.effect(() => () => {
                if (typeof unwatch === 'function')
                    unwatch();
                source = () => entry;
                rebuild();
            }, 'env-injector: detach settings source');
        }
        settingsAttached = true;
        /* The rules are now live-overridable, so say what they resolved to: this is
         * what makes "did my settings section win?" answerable from a deployment
         * log without any further tooling. */
        note(log, 'info', `settings namespace '${NS}' attached — ${describeRules(compiled.rules)}`);
    });
    const runtime = subprocessRuntime(ctx.get('subprocess'));
    const methods = entry.terminal ? [...WRAPPED_METHODS] : ['spawn'];
    const uninstall = installSpawnInjection(runtime, methods, () => compiled, log);
    ctx.effect(() => uninstall, 'env-injector: restore ctx.subprocess methods');
    /*
     * The settings service attaches asynchronously, so the authoritative source
     * is only known one tick later — and that is exactly what an operator needs
     * from the harness log: that the wrapper is installed, which rules it will
     * use, and which layer supplied them.
     */
    setTimeout(() => {
        note(log, 'info', `wrapping ctx.subprocess.${methods.join('/')} — ${describeRules(compiled.rules)} (source: ${settingsAttached ? 'settings.yaml over the composition entry' : 'composition entry only'})`);
    }, 0).unref();
}
export default { name, inject, Config, apply };
