/**
 * The read guard: what this plugin refuses to inject, and how it scrubs a value
 * that did get injected out of a tool result.
 *
 * Two layers are covered here, both without cordis:
 *
 * - the DENIAL layer (`guard.reads` / `guard.shells`), asserted through
 *   `injectEnvForSpec`, where the contract is "the caller's spec object comes
 *   back untouched and nothing was delivered";
 * - the REDACTION layer (`redactValues` / `redactBlocks` /
 *   `makeRedactionListener`), asserted as pure functions plus the listener's
 *   decision handling.
 *
 * The tests also pin the DEFAULT policy: `reads: true`, `shells: 'off'`,
 * `redactOutput: true`. `shells: 'off'` in particular is a deliberate choice —
 * `bash -c 'git push'` must keep working — so it is asserted, not assumed.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Config,
  compileConfig,
  describeGuard,
  injectEnvForSpec,
  makeRedactionListener,
  redactBlocks,
  redactValues,
  redactionPairs,
} from '../lib/index.js'

const TOKEN = 'ghp_guardtest0123456789abcdef'
process.env.GUARD_TOKEN = TOKEN

/** Compile one rule list plus an optional `guard` override. */
const compiled = (rules, guard) =>
  compileConfig({ rules, overrideExisting: true, terminal: true, logMatches: false, ...(guard === undefined ? {} : { guard }) })

/** A rule that would hand GUARD_TOKEN to the given command pattern. */
const ruleFor = (command, argsPattern = '') => ({ command, argsPattern, envVar: 'GUARD_TOKEN', enabled: true, flags: '' })

/** A minimal spawn spec for the given argv. */
const spec = (argv, env) => ({ argv, cwd: '/tmp', stdio: {}, graceMs: 1000, ...(env === undefined ? {} : { env }) })

/** A spawn as the harness shell tool actually builds it. */
const shell = (commandLine) => spec(['bash', '-c', commandLine])

/* ── Layer A: the read commands ─────────────────────────────────────────────── */

test('an explicit environment reader is refused', () => {
  for (const argv of [['env'], ['/usr/bin/env'], ['printenv']]) {
    const result = injectEnvForSpec(spec(argv), compiled([ruleFor('^(env|printenv|/usr/bin/env)$')]))
    assert.deepEqual(result.injected, [], `${argv.join(' ')} is not injected`)
    assert.equal(result.skipped[0].reason, 'guard', `${argv.join(' ')} is reported as a guard skip`)
    assert.equal(result.blocked.length, 1, `${argv.join(' ')} names the withheld rule`)
  }
})

test('a reader with arguments is refused as a wrapper', () => {
  /* `env -i gh pr list` resolves to `gh` for matching — `env` is a wrapper the
   * rules look through — so only the guard can refuse it, and it does: the
   * token would sit in `env`'s own environment too. */
  const rules = [ruleFor('^gh(\\.exe)?$')]
  const result = injectEnvForSpec(shell('env -i gh pr list'), compiled(rules))
  assert.deepEqual(result.injected, [])
  assert.equal(result.blocked.length, 1, 'the gh rule is the one withheld')
  assert.match(result.blocked[0].reason, /env reads/)
})

test('a reader anywhere in the command line refuses the whole spawn', () => {
  /* Injection lands in the child's environment, which `env` shares — so
   * "skip the env rule" would protect nothing: the point is that the token must
   * not reach the process tree at all. */
  const rules = [ruleFor('^gh(\\.exe)?$'), ruleFor('^env$')]
  const piped = injectEnvForSpec(shell('gh pr list | env'), compiled(rules))
  assert.deepEqual(piped.injected, [], 'the pipeline is refused as a whole')
  assert.equal(piped.spec.env, undefined, 'and the spec it returns is the original')

  const chained = injectEnvForSpec(shell('env; gh pr list'), compiled(rules))
  assert.deepEqual(chained.injected, [])

  const bare = injectEnvForSpec(shell('gh pr list; env'), compiled(rules))
  assert.deepEqual(bare.injected, [], 'a trailing bare reader is refused too, and names the rule it withheld')

  /* The same pipeline WITHOUT a reader on the line does inject, which is what
   * proves the refusals above came from the guard and not from the matcher. */
  const withoutReader = injectEnvForSpec(shell('gh pr list | env'), compiled([ruleFor('^gh(\\.exe)?$')]))
  assert.deepEqual(withoutReader.injected, [])
  const clean = injectEnvForSpec(shell('gh pr list | cat'), compiled([ruleFor('^gh(\\.exe)?$')]))
  assert.deepEqual(clean.injected, ['GUARD_TOKEN'])
})

test('a reader used as a wrapper is refused even though rules never see it', () => {
  /* `env FOO=1 gh …` runs gh as env's child, so the token would sit in env's
   * environment as well. The rule matcher deliberately unwraps `env` away (a
   * `^gh$` rule must match it); the guard must not. */
  const rules = [ruleFor('^gh(\\.exe)?$')]
  assert.deepEqual(injectEnvForSpec(shell('env GH_TOKEN=x gh pr list'), compiled(rules)).injected, [])
  assert.deepEqual(injectEnvForSpec(spec(['env', 'GUARD_TOKEN=1', 'gh', 'pr', 'list']), compiled(rules)).injected, [])
  /* A harmless wrapper still delivers: the guard is about readers, not about
   * wrapper words as such. */
  assert.deepEqual(injectEnvForSpec(shell('nohup gh pr list'), compiled(rules)).injected, ['GUARD_TOKEN'])
})

test('a plain command still receives its value', () => {
  const rules = [ruleFor('^gh(\\.exe)?$'), ruleFor('^git(\\.exe)?$', '^push\\b')]
  assert.deepEqual(injectEnvForSpec(spec(['gh', 'pr', 'list']), compiled(rules)).injected, ['GUARD_TOKEN'])
  assert.deepEqual(injectEnvForSpec(shell('git push origin main'), compiled(rules)).injected, ['GUARD_TOKEN'])
})

test('the default policy delivers to a shell command line', () => {
  /* The documented default: `shells: off`. A deployment that wants the hard
   * guarantee flips it to `model`; the plugin must not silently change that for
   * everyone, because the bash tool description tells the model to run
   * `bash -c 'git push'`. */
  const rules = [ruleFor('^gh(\\.exe)?$')]
  assert.deepEqual(injectEnvForSpec(shell('gh pr list'), compiled(rules)).injected, ['GUARD_TOKEN'])
  /* A direct shell argv (the PTY shape) is not a caller-composed command line,
   * so it is delivered to regardless. */
  const pty = spec(['/bin/bash', '--noprofile', '--norc'])
  assert.deepEqual(injectEnvForSpec(pty, compiled([ruleFor('^bash$')])).injected, ['GUARD_TOKEN'])
})

test("guard.shells: 'model' refuses every caller-composed command line", () => {
  const strict = compiled([ruleFor('^gh(\\.exe)?$')], Config({ guard: { shells: 'model' } }).guard)
  const refused = injectEnvForSpec(shell('gh pr list'), strict)
  assert.deepEqual(refused.injected, [])
  assert.equal(refused.skipped[0].reason, 'guard')
  /* A direct argv — what a plugin spawns itself — is not a caller-composed
   * command line and still receives the value. */
  assert.deepEqual(injectEnvForSpec(spec(['gh', 'pr', 'list']), strict).injected, ['GUARD_TOKEN'])
})

test('turning the read guard off is the documented opt-out', () => {
  const open = compiled([ruleFor('^env$')], Config({ guard: { reads: false } }).guard)
  const result = injectEnvForSpec(spec(['env']), open)
  assert.deepEqual(result.injected, ['GUARD_TOKEN'])
  assert.deepEqual(result.blocked, [])
})

test('denyCommands replaces the built-in reader list', () => {
  const custom = compiled([ruleFor('^gh$')], Config({ guard: { denyCommands: ['tee'] } }).guard)
  assert.deepEqual(injectEnvForSpec(shell('gh pr list | tee out.txt'), custom).injected, [], 'tee is refused')
  /* With the list replaced, the built-in names are no longer refused by the
   * guard — a deliberate, documented consequence of "replaces". */
  const stillInjects = injectEnvForSpec(shell('env GH_TOKEN=x gh pr list'), custom)
  assert.deepEqual(stillInjects.injected, ['GUARD_TOKEN'])
})

test('a deployment can name its own readers', () => {
  const custom = compiled([ruleFor('^gh$')], Config({ guard: { denyCommands: ['tee'] } }).guard)
  assert.deepEqual(injectEnvForSpec(shell('gh pr list | tee /tmp/x'), custom).injected, [])
})

test('a refused spawn reports the reader by name', () => {
  const result = injectEnvForSpec(spec(['printenv']), compiled([ruleFor('^printenv$')]))
  assert.deepEqual(result.blocked, [{ envVar: 'GUARD_TOKEN', rule: 0, command: 'printenv', reason: 'printenv reads or rewrites the environment' }])
})

test('describeGuard states the whole policy in one line', () => {
  assert.equal(describeGuard(compileConfig(Config({})).guard), 'reads=deny shells=off redact=on')
  const strict = compileConfig(Config({ guard: { reads: false, shells: 'model', redactOutput: false } }))
  assert.equal(describeGuard(strict.guard), 'reads=off shells=model redact=off')
})

/* ── Layer B: redaction ─────────────────────────────────────────────────────── */

test('redactionPairs carries the value plus its base64 and hex forms', () => {
  const pairs = redactionPairs(['GUARD_TOKEN'])
  assert.deepEqual([...new Set(pairs.map((pair) => pair.form))].sort(), ['base64', 'hex', 'raw'])
  assert.equal(pairs.find((pair) => pair.form === 'raw').text, TOKEN)
  assert.equal(pairs.find((pair) => pair.form === 'base64').text, Buffer.from(TOKEN, 'utf8').toString('base64'))
})

test('redactValues removes every form of the value', () => {
  const pairs = redactionPairs(['GUARD_TOKEN'])
  const marker = '[redacted:{name}]'
  const base64 = Buffer.from(TOKEN, 'utf8').toString('base64')
  const hex = Buffer.from(TOKEN, 'utf8').toString('hex')
  assert.equal(redactValues(`token=${TOKEN}`, pairs, marker), 'token=[redacted:GUARD_TOKEN]')
  assert.equal(redactValues(`echo ${base64} | base64 -d`, pairs, marker), 'echo [redacted:GUARD_TOKEN] | base64 -d')
  assert.equal(redactValues(`xxd -r -p <<< ${hex}`, pairs, marker), 'xxd -r -p <<< [redacted:GUARD_TOKEN]')
  assert.equal(redactValues(`${TOKEN}${TOKEN}`, pairs, marker), '[redacted:GUARD_TOKEN][redacted:GUARD_TOKEN]')
})

test('redactValues leaves unrelated text and short values alone', () => {
  const pairs = redactionPairs(['GUARD_TOKEN'])
  const clean = 'nothing to see here'
  assert.equal(redactValues(clean, pairs, '[redacted:{name}]'), clean, 'the original string comes back by reference')
  process.env.GUARD_SHORT = 'abc'
  assert.deepEqual(redactionPairs(['GUARD_SHORT']), [], 'a value too short to redact without false positives is skipped')
  delete process.env.GUARD_SHORT
  assert.equal(redactValues('abc', redactionPairs(['GUARD_SHORT']), '[redacted:{name}]'), 'abc')
})

test('redactValues ignores a hex-looking word that is not the value', () => {
  const pairs = redactionPairs(['GUARD_TOKEN'])
  const plausible = 'deadbeefdeadbeef'
  assert.equal(redactValues(plausible, pairs, '[redacted:{name}]'), plausible)
})

test('redactBlocks rewrites text blocks only, and reports "nothing changed" as undefined', () => {
  const pairs = redactionPairs(['GUARD_TOKEN'])
  const marker = '[redacted:{name}]'
  const blocks = [
    { type: 'text', text: `out: ${TOKEN}` },
    { type: 'thinking', thinking: 'internal' },
    { type: 'text', text: 'unrelated' },
  ]
  const redacted = redactBlocks(blocks, pairs, marker)
  assert.equal(redacted[0].text, 'out: [redacted:GUARD_TOKEN]')
  assert.equal(redacted[1], blocks[1], 'a non-text block is passed through by reference')
  assert.equal(redacted[2], blocks[2], 'an unmodified text block is passed through by reference')
  assert.equal(blocks[0].text, `out: ${TOKEN}`, 'the input blocks are not mutated')
  assert.equal(redactBlocks([{ type: 'text', text: 'clean' }], pairs, marker), undefined)
})

test('the redaction listener scrubs content and preserves the rest of the decision', async () => {
  const compiledConfig = compiled([ruleFor('^gh$')])
  const listener = makeRedactionListener(() => compiledConfig, () => ['GUARD_TOKEN'])
  const result = { content: [{ type: 'text', text: `${TOKEN}` }] }
  const context = { additionalContexts: [{ role: 'user' }] }
  const decision = await listener({}, result, async () => ({ kind: 'accept', ...context }))
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content[0].text, '[redacted:GUARD_TOKEN]')
  assert.deepEqual(decision.additionalContexts, context.additionalContexts, 'attached context survives redaction')
})

test('the redaction listener stays out of the way', async () => {
  const compiledConfig = compiled([ruleFor('^gh$')])
  const listener = makeRedactionListener(() => compiledConfig, () => ['GUARD_TOKEN'])
  const accepted = { kind: 'accept', content: [{ type: 'text', text: 'clean' }] }
  assert.equal(await listener({}, {}, async () => accepted), accepted, 'a clean result is the very same decision object')

  const valueDecision = { kind: 'accept', value: { token: TOKEN } }
  assert.equal(await listener({}, {}, async () => valueDecision), valueDecision, 'a value projection is never touched')

  const blocked = { kind: 'block', feedback: [{ type: 'text', text: TOKEN }] }
  assert.equal(await listener({}, {}, async () => blocked), blocked, 'a block decision is never reshaped')

  const off = compileConfig({ ...Config({ rules: [ruleFor('^gh$')] }), guard: Config({ guard: { redactOutput: false } }).guard })
  const offListener = makeRedactionListener(() => off, () => ['GUARD_TOKEN'])
  const leaked = { kind: 'accept', content: [{ type: 'text', text: TOKEN }] }
  assert.equal(await offListener({}, {}, async () => leaked), leaked, 'redactOutput=false is the opt-out')
})

test('a rotated value is redacted at its current value, not a remembered one', async () => {
  const compiledConfig = compiled([ruleFor('^gh$')])
  const listener = makeRedactionListener(() => compiledConfig, () => ['GUARD_TOKEN'])
  const next = 'ghp_rotated9876543210zyxwvutsrq'
  process.env.GUARD_TOKEN = next
  try {
    const decision = await listener({}, {}, async () => ({ kind: 'accept', content: [{ type: 'text', text: next }] }))
    assert.equal(decision.content[0].text, '[redacted:GUARD_TOKEN]')
    /* The previous value is no longer treated as a secret: it is not a value
     * any child was given. */
    assert.equal(redactValues(TOKEN, redactionPairs(['GUARD_TOKEN']), '[redacted:{name}]'), TOKEN)
  } finally {
    process.env.GUARD_TOKEN = TOKEN
  }
})
