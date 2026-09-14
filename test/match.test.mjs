/**
 * Unit tests for the pure half of dsh-env-injector: argv analysis, rule
 * compilation, and the spec-rewriting contract. These run without cordis, so a
 * failure here points at matching logic rather than at wiring.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Config,
  compileConfig,
  compileRule,
  executableName,
  extractInvocations,
  injectEnvForSpec,
  matchRules,
} from '../lib/index.js'

/**
 * Fixtures — rules a *deployment* writes, not plugin defaults: the plugin
 * ships an empty rule list, so every test states its own rules.
 */

/** The README recipe: gh, plus the git subcommands that talk to a remote. */
const GH_GIT_RULES = [
  { command: '^gh(\\.exe)?$', argsPattern: '', envVar: 'GH_TOKEN', enabled: true, flags: '' },
  {
    command: '^git(\\.exe)?$',
    argsPattern: '^(?:-[cC]\\s+\\S+\\s+|--\\S+(?:=\\S+)?\\s+)*(?:push|fetch|pull|clone|ls-remote)\\b',
    envVar: 'GH_TOKEN',
    enabled: true,
    flags: '',
  },
]

/** Compile a rule list the way the plugin does at load. */
const compiled = (rules, overrides = {}) =>
  compileConfig({ rules, overrideExisting: true, logMatches: false, ...overrides })

/** A minimal spawn spec for the given argv. */
const spec = (argv, env) => ({ argv, cwd: '/tmp', stdio: {}, graceMs: 1000, ...(env === undefined ? {} : { env }) })

test('executableName takes the trailing file name on both separator styles', () => {
  assert.equal(executableName('gh'), 'gh')
  assert.equal(executableName('/usr/bin/gh'), 'gh')
  assert.equal(executableName('C:\\tools\\gh.exe'), 'gh.exe')
})

test('a direct argv yields one invocation', () => {
  assert.deepEqual(extractInvocations(['/usr/bin/gh', 'pr', 'list']), [
    { command: 'gh', path: '/usr/bin/gh', args: 'pr list' },
  ])
})

test('a shell-wrapped command line yields each command in it', () => {
  const [first, second] = extractInvocations(['bash', '-c', 'gh pr list && git push origin main'])
  assert.deepEqual(first, { command: 'gh', path: 'gh', args: 'pr list' })
  assert.deepEqual(second, { command: 'git', path: 'git', args: 'push origin main' })
})

test('separators inside quotes do not split a command', () => {
  const invocations = extractInvocations(['bash', '-c', 'gh pr create --title "a && b" --body "x | y"'])
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].command, 'gh')
  assert.equal(invocations[0].args, 'pr create --title a && b --body x | y')
})

test('assignments, wrappers and quoted executables are handled', () => {
  assert.equal(extractInvocations(['bash', '-c', 'GH_HOST=x sudo -E "/usr/bin/gh" pr view'])[0].command, 'gh')
  assert.equal(extractInvocations(['bash', '-c', 'nohup nice -n 5 git push'])[0].command, 'git')
  assert.equal(extractInvocations(['bash', '-c', 'timeout 30 gh api /user'])[0].command, 'gh')
})

test('the pwsh command flag and its encoding preamble are handled', () => {
  const preamble = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  const invocations = extractInvocations(['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${preamble}gh pr list`])
  assert.deepEqual(invocations, [{ command: 'gh', path: 'gh', args: 'pr list' }])
})

test('a pipeline yields every stage', () => {
  const commands = extractInvocations(['bash', '-c', 'gh pr list | grep foo; echo done']).map((entry) => entry.command)
  assert.deepEqual(commands, ['gh', 'grep', 'echo'])
})

/* Regression: the real harness never hands `['bash','-c',cmd]` to spawn. The
 * sandbox provider wraps the caller's argv behind its own profile arguments
 * (`dsh-sandbox-local`'s `confine()` returns `[...runnerArgv, '--', ...argv]`),
 * so a matcher that only unwraps a shell at argv[0] sees `bwrap` and matches
 * nothing at all in a real deployment. These are the exact shapes each
 * platform's sandbox produces. */
const BWRAP_ARGV = (command) => [
  'bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent',
  '--tmpfs', '/tmp', '--bind', '/workspace', '/workspace',
  '--', 'bash', '-c', command,
]
const LANDLOCK_ARGV = (command) => [
  '/usr/local/lib/node_modules/@deepseek-ai/node-addon-landlock-run/bin/launcher', '--ro', '/', '--rw', '/tmp', '--rw', '/workspace',
  '--', 'bash', '-c', command,
]
const SEATBELT_ARGV = (command) => [
  'sandbox-exec', '-p', '(version 1)(allow default)(deny file-write*)', 'bash', '-c', command,
]

test('a sandbox-wrapped command line is unwrapped (bwrap)', () => {
  assert.deepEqual(extractInvocations(BWRAP_ARGV('gh pr list')), [{ command: 'gh', path: 'gh', args: 'pr list' }])
})

test('a sandbox-wrapped command line is unwrapped (landlock launcher)', () => {
  assert.deepEqual(extractInvocations(LANDLOCK_ARGV('git push origin main')), [{ command: 'git', path: 'git', args: 'push origin main' }])
})

test('a sandbox-wrapped command line is unwrapped (seatbelt, no `--`)', () => {
  assert.deepEqual(extractInvocations(SEATBELT_ARGV('gh pr view 1')), [{ command: 'gh', path: 'gh', args: 'pr view 1' }])
})

test('rules match through a sandbox wrapper', () => {
  const rules = compiled(GH_GIT_RULES).rules
  assert.equal(matchRules(extractInvocations(BWRAP_ARGV('gh pr list && git push')), rules).length, 2)
  assert.equal(matchRules(extractInvocations(BWRAP_ARGV('git status')), rules).length, 0)
  assert.equal(matchRules(extractInvocations(LANDLOCK_ARGV('gh pr list')), rules).length, 1)
})

test('injection happens through a sandbox wrapper', () => {
  process.env.UNIT_TOKEN = 'wrapped-value'
  const rule = { command: '^gh$', argsPattern: '', envVar: 'UNIT_TOKEN', enabled: true, flags: '' }
  const result = injectEnvForSpec(spec(BWRAP_ARGV('gh pr list'), { NO_COLOR: '1' }), compiled([rule]))
  assert.deepEqual(result.spec.env, { NO_COLOR: '1', UNIT_TOKEN: 'wrapped-value' })
  assert.deepEqual(result.injected, ['UNIT_TOKEN'])
})

test('a launcher that separates with `--` yields its command', () => {
  assert.deepEqual(extractInvocations(['bwrap', '--ro-bind', '/', '/', '--', 'gh', 'pr', 'list']), [
    { command: 'gh', path: 'gh', args: 'pr list' },
  ])
})

test('a nested shell resolves to the innermost command', () => {
  assert.deepEqual(extractInvocations(['bash', '-c', 'bash -c "gh pr list"']), [{ command: 'gh', path: 'gh', args: 'pr list' }])
  assert.deepEqual(extractInvocations(BWRAP_ARGV("sudo -E bash -c 'git push'")), [{ command: 'git', path: 'git', args: 'push' }])
})

/* `bash -lc '…'` and friends are the documented POSIX spellings, so the command
 * flag has to be recognised inside a short-option cluster. Otherwise the shell
 * is never unwrapped, the spawn reads as an opaque `bash -lc …` argv, and a
 * `^gh$`/`^git$` rule silently matches nothing. */
test('a shell launched with a combined option cluster is unwrapped', () => {
  assert.deepEqual(extractInvocations(['bash', '-lc', 'gh pr list']), [{ command: 'gh', path: 'gh', args: 'pr list' }])
  assert.deepEqual(extractInvocations(['sh', '-ec', 'git push origin main']), [{ command: 'git', path: 'git', args: 'push origin main' }])
  assert.deepEqual(extractInvocations(BWRAP_ARGV("bash -ic 'gh pr view 1'")), [{ command: 'gh', path: 'gh', args: 'pr view 1' }])
})

test('rules match through a combined option cluster', () => {
  const rules = compiled(GH_GIT_RULES).rules
  assert.equal(matchRules(extractInvocations(BWRAP_ARGV("bash -lc 'git push'")), rules).length, 1)
  assert.equal(matchRules(extractInvocations(['bash', '-lc', 'git status']), rules).length, 0)
})

test('a wrapper-launched command resolves to the wrapped command', () => {
  assert.deepEqual(extractInvocations(['env', '-i', 'FOO=1', 'gh', 'pr', 'list']), [{ command: 'gh', path: 'gh', args: 'pr list' }])
})

test('command patterns match the basename, with the full path as fallback', () => {
  const gh = compiled([{ command: '^gh$', argsPattern: '', envVar: 'GH_TOKEN', enabled: true, flags: '' }])
  const absolute = compiled([{ command: '^/usr/bin/gh$', argsPattern: '', envVar: 'GH_TOKEN', enabled: true, flags: '' }])
  assert.equal(matchRules(extractInvocations(['gh', 'pr', 'list']), gh.rules).length, 1)
  assert.equal(matchRules(extractInvocations(['/usr/bin/gh', 'pr', 'list']), absolute.rules).length, 1)
  assert.equal(matchRules(extractInvocations(['gh-tool']), gh.rules).length, 0)
})

test('argsPattern constrains the command without blocking its global flags', () => {
  const rules = compiled([GH_GIT_RULES[1]]).rules
  assert.equal(matchRules(extractInvocations(['bash', '-c', 'git push origin main']), rules).length, 1)
  assert.equal(matchRules(extractInvocations(['bash', '-c', 'git -C /repo --no-pager fetch']), rules).length, 1)
  assert.equal(matchRules(extractInvocations(['bash', '-c', 'git status']), rules).length, 0)
})

test('disabled rules never match', () => {
  const rules = compiled([{ command: '^gh$', argsPattern: '', envVar: 'GH_TOKEN', enabled: false, flags: '' }])
  assert.equal(rules.rules.length, 0)
})

test('an invalid regex is refused with the offending field named', () => {
  assert.throws(() => compileRule({ command: '(', argsPattern: '', envVar: 'GH_TOKEN', enabled: true, flags: '' }, 3), /rules\[3\]\.command/)
  assert.throws(() => compileRule({ command: 'gh', argsPattern: '[', envVar: 'GH_TOKEN', enabled: true, flags: '' }, 0), /argsPattern/)
  assert.throws(() => compileRule({ command: 'gh', argsPattern: '', envVar: 'GH_TOKEN', enabled: true, flags: 'zz' }, 0), /flags|not a valid regular expression/)
  assert.throws(() => compileRule({ command: 'gh', argsPattern: '', envVar: '  ', enabled: true, flags: '' }, 0), /envVar/)
})

test('a matching spawn gets a copied spec with the injected entry', () => {
  process.env.UNIT_TOKEN = 'unit-value'
  const original = spec(['bash', '-c', 'gh pr list'], { NO_COLOR: '1' })
  const result = injectEnvForSpec(original, compiled([{ command: '^gh$', argsPattern: '', envVar: 'UNIT_TOKEN', enabled: true, flags: '' }]))
  assert.deepEqual(result.spec.env, { NO_COLOR: '1', UNIT_TOKEN: 'unit-value' })
  assert.deepEqual(original.env, { NO_COLOR: '1' }, 'the caller’s spec object is not mutated')
  assert.notEqual(result.spec, original, 'a new spec object is spawned')
  assert.equal(process.env.UNIT_TOKEN, 'unit-value', 'process.env is only read')
})

test('an unmatched spawn is passed through as the identical object', () => {
  const original = spec(['bash', '-c', 'echo hi'], { NO_COLOR: '1' })
  const result = injectEnvForSpec(original, compiled(GH_GIT_RULES))
  assert.equal(result.spec, original)
  assert.deepEqual(result.injected, [])
})

test('an unset or empty source variable injects nothing and reports why', () => {
  delete process.env.UNIT_MISSING
  const rules = compiled([{ command: '^gh$', argsPattern: '', envVar: 'UNIT_MISSING', enabled: true, flags: '' }])
  const warnings = []
  const missing = injectEnvForSpec(spec(['gh', 'pr', 'list']), rules, (envVar, message) => warnings.push([envVar, message]))
  assert.equal(missing.injected.length, 0)
  assert.deepEqual(missing.skipped, [{ envVar: 'UNIT_MISSING', reason: 'unset' }])
  assert.match(warnings[0][1], /UNIT_MISSING is not set/)

  process.env.UNIT_EMPTY = ''
  const empty = injectEnvForSpec(spec(['gh', 'pr', 'list']), compiled([{ command: '^gh$', argsPattern: '', envVar: 'UNIT_EMPTY', enabled: true, flags: '' }]))
  assert.equal(empty.injected.length, 0)
  delete process.env.UNIT_EMPTY
})

test('overrideExisting: false keeps an explicit caller entry', () => {
  process.env.UNIT_TOKEN = 'harness-value'
  const original = spec(['gh', 'pr', 'list'], { UNIT_TOKEN: 'caller-value' })
  const kept = injectEnvForSpec(original, compiled([{ command: '^gh$', argsPattern: '', envVar: 'UNIT_TOKEN', enabled: true, flags: '' }], { overrideExisting: false }))
  assert.equal(kept.spec, original)
  assert.deepEqual(kept.skipped, [{ envVar: 'UNIT_TOKEN', reason: 'caller' }])

  const overridden = injectEnvForSpec(original, compiled([{ command: '^gh$', argsPattern: '', envVar: 'UNIT_TOKEN', enabled: true, flags: '' }], { overrideExisting: true }))
  assert.equal(overridden.spec.env.UNIT_TOKEN, 'harness-value')
})

test('a spec with a malformed argv is passed through untouched', () => {
  const rules = compiled(GH_GIT_RULES)
  const broken = { cwd: '/tmp', stdio: {}, graceMs: 1000 }
  assert.equal(injectEnvForSpec(broken, rules).spec, broken)
  assert.equal(injectEnvForSpec(spec([]), rules).spec.argv.length, 0)
})

test('the schema resolves defaults and stays JSON-shaped', () => {
  const resolved = Config({})
  assert.deepEqual(resolved, { rules: [], overrideExisting: true, terminal: true, logMatches: false })
  assert.deepEqual(structuredClone(resolved), resolved, 'the resolved section survives a JSON round trip')
  assert.deepEqual(Config({ overrideExisting: false }).rules, [], 'omitting `rules` resolves to an empty list')
  const withRules = Config({ rules: GH_GIT_RULES })
  assert.deepEqual(withRules.rules, GH_GIT_RULES, 'deployment rules pass through verbatim')
  assert.equal(Object.isFrozen(GH_GIT_RULES), false, 'resolving does not freeze or mutate the input')
  assert.equal(Config({ rules: [{ envVar: 'X' }] }).rules[0].command, '.*')
  assert.equal(Config({ rules: [{ envVar: 'X' }] }).rules[0].enabled, true)
})
