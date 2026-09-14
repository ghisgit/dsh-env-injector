/**
 * End-to-end verification of dsh-env-injector over the REAL seams:
 *
 * - the real `@deepseek-ai/dsh-subprocess-local` provider (so a real `bash`
 *   child process runs and prints its own environment),
 * - the real `@deepseek-ai/dsh-settings-file` provider (so a real
 *   `settings.yaml` edit exercises the hot-reload path),
 * - the plugin loaded exactly as the loader loads it (`default ?? namespace`,
 *   like cordis' `unwrapExports`).
 *
 * Everything is invoked through `ctx.subprocess.spawn` — i.e. through cordis'
 * traceable service proxy — which is also what proves the wrapper is reachable
 * from the call site DSH's shell tools use.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import * as settingsFileProvider from '@deepseek-ai/dsh-settings-file'
import * as subprocessProvider from '@deepseek-ai/dsh-subprocess-local'
import * as injectorModule from '../lib/index.js'

const TOKEN = 'gh-token-from-harness-process-0123456789'
const NODE_TOKEN = 'npm-token-from-harness-process'
const OTHER = 'must-not-leak-into-children'

/**
 * The composition entry this suite loads the plugin with. The shipped entry
 * has an EMPTY rule list, so a deployment that wants these commands to see the
 * token writes exactly this — which is what the suite is standing in for.
 */
const COMPOSITION_RULES = [
  { command: '^gh(\\.exe)?$', argsPattern: '', envVar: 'GH_TOKEN', enabled: true, flags: '' },
  {
    command: '^git(\\.exe)?$',
    argsPattern: '^(?:-[cC]\\s+\\S+\\s+|--\\S+(?:=\\S+)?\\s+)*(?:push|fetch|pull|clone|ls-remote)\\b',
    envVar: 'GH_TOKEN',
    enabled: true,
    flags: '',
  },
]

/** Unwrap exports the way cordis' loader does. */
const asPlugin = (module) => module.default ?? module

let ctx
let settingsPath
let pluginFiber

/**
 * Run one shell command through the real subprocess service and return its
 * collected stdout+stderr as one string.
 * @param command - the bash command line to execute.
 * @param env - extra explicit environment entries for the spawn.
 * @returns the child's combined output.
 */
async function run(command, env) {
  const handle = ctx.subprocess.spawn({
    argv: ['bash', '-c', command],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 5_000,
    ...(env === undefined ? {} : { env }),
  })
  await handle.done
  const stdout = handle.collected.stdout.readFrom(0).text
  const stderr = handle.collected.stderr.readFrom(0).text
  return `${stdout}${stderr}`
}

/**
 * Poll until `check` returns true, so a hot-reload assertion waits for the file
 * watcher instead of racing it.
 * @param check - the predicate to poll.
 * @param label - description used in the failure message.
 * @param timeoutMs - how long to keep polling.
 */
async function waitFor(check, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

before(async () => {
  process.env.GH_TOKEN = TOKEN
  process.env.NODE_AUTH_TOKEN = NODE_TOKEN
  process.env.UNRELATED_SECRET = OTHER
  const directory = await mkdtemp(join(tmpdir(), 'dsh-env-injector-'))
  settingsPath = join(directory, 'settings.yaml')
  await writeFile(settingsPath, '{}\n', 'utf8')

  ctx = new Context()
  await ctx.plugin(asPlugin(subprocessProvider), {})
  await ctx.plugin(asPlugin(settingsFileProvider), { path: settingsPath, watch: true, debounceMs: 50 })
})

after(async () => {
  /* Disposing the root fiber unloads every plugin, which closes the settings
   * file watcher and the subprocess provider's managed range. */
  await ctx?.fiber.dispose()
})

test('baseline: the harness scrub removes GH_TOKEN from children', async () => {
  const output = await run('printf "token=[%s]" "$GH_TOKEN"')
  assert.equal(output, 'token=[]')
})

test('the plugin loads and serves its settings namespace', async () => {
  pluginFiber = await ctx.plugin(asPlugin(injectorModule), { rules: COMPOSITION_RULES })
  const descriptor = ctx.settings
    .describe()
    .find((entry) => entry.ns === 'env-injector')
  assert.ok(descriptor !== undefined, 'env-injector settings namespace is registered')
  assert.deepEqual(descriptor.base.rules, COMPOSITION_RULES, 'the composition entry is the namespace base')
  assert.deepEqual(descriptor.value.rules, COMPOSITION_RULES, 'the resolved rules are the composed ones')
})

test('the describe wire carries what a configuration card renders', () => {
  /* The browser half's card derives every control from ONE descriptor read:
   * the serialized schema (what the namespace accepts), the resolved value and
   * composition base (what a field shows and what a reset returns to), the raw
   * user layer (a field's presence there is what marks it overridden), and the
   * revision a write is fenced with. The wire must end every one of those
   * JSON-safe, because that is the only form it reaches a browser in. */
  const [descriptor] = ctx.settings.describe({ redactSecrets: true }).filter((entry) => entry.ns === 'env-injector')
  assert.ok(descriptor !== undefined, 'the wire surface serves the namespace the card is keyed by')
  assert.equal(typeof descriptor.revision, 'number', 'a write is fenced by the revision the card read')
  assert.deepEqual(
    JSON.parse(JSON.stringify(descriptor.schema)),
    descriptor.schema,
    'the schema survives the wire',
  )
  assert.deepEqual(descriptor.value.rules, COMPOSITION_RULES)
  assert.deepEqual(descriptor.base.rules, COMPOSITION_RULES, 'a reset previews what this layer holds')
  assert.equal(descriptor.user, undefined, 'no user layer yet, so every field is unprefixed by a card')
})

test('a plugin loaded with no rules injects nothing at all', async () => {
  /* The shipped composition entry is empty, so this is the out-of-the-box
   * state: registered, wrapped, and inert. */
  const bare = new Context()
  try {
    await bare.plugin(asPlugin(subprocessProvider), {})
    await bare.plugin(asPlugin(settingsFileProvider), { path: settingsPath, watch: true, debounceMs: 50 })
    await bare.plugin(asPlugin(injectorModule), {})
    const handle = bare.subprocess.spawn({
      argv: ['bash', '-c', 'gh --version >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 5_000,
    })
    await handle.done
    assert.equal(handle.collected.stdout.readFrom(0).text, 'token=[]', 'no rule, no injection')
  } finally {
    /* Dispose the side context: its settings watcher would otherwise keep the
     * test process alive after the last assertion. */
    await bare.fiber.dispose()
  }
})

test('a matching command receives the token through a real child process', async () => {
  const output = await run('gh --version >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"')
  assert.equal(output, `token=[${TOKEN}]`)
})

test('a non-matching command is left untouched (no token)', async () => {
  const output = await run('printf "token=[%s]" "$GH_TOKEN"')
  assert.equal(output, 'token=[]')
})

test('the git rule matches remote subcommands only', async () => {
  const pushing = await run('git push origin main >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"')
  assert.equal(pushing, `token=[${TOKEN}]`)
  const status = await run('git status >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"')
  assert.equal(status, 'token=[]')
})

test('the git rule tolerates leading global flags', async () => {
  const output = await run('git -C /tmp --no-pager fetch >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"')
  assert.equal(output, `token=[${TOKEN}]`)
})

test("the caller's own env survives and the caller's spec object is not mutated", async () => {
  const spec = {
    argv: ['bash', '-c', 'gh --version >/dev/null 2>&1; printf "keep=[%s] token=[%s]" "$KEEP_ME" "$GH_TOKEN"'],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
    graceMs: 5_000,
    env: { KEEP_ME: 'yes' },
  }
  const handle = ctx.subprocess.spawn(spec)
  await handle.done
  assert.equal(handle.collected.stdout.readFrom(0).text, `keep=[yes] token=[${TOKEN}]`)
  assert.deepEqual(spec.env, { KEEP_ME: 'yes' }, 'the injected value landed in a copy, not the caller’s spec')
})

test('process.env is never written to', async () => {
  assert.equal(process.env.GH_TOKEN, TOKEN)
  assert.equal(process.env.UNRELATED_SECRET, OTHER)
  assert.equal(process.env.GH_TOKEN_INJECTED, undefined)
})

test('settings.yaml edits change the live rules without a restart', async () => {
  await writeFile(
    settingsPath,
    [
      'env-injector:',
      '  rules:',
      '    - command: ^node$',
      "      argsPattern: '-e'",
      '      envVar: NODE_AUTH_TOKEN',
      '      enabled: true',
      '      flags: ""',
      '  logMatches: false',
      '',
    ].join('\n'),
    'utf8',
  )
  await waitFor(async () => {
    const output = await run('node -e "process.stdout.write(String(process.env.NODE_AUTH_TOKEN))"')
    return output === NODE_TOKEN
  }, 'the user-layer rule to become active')
  const gh = await run('gh --version >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"')
  assert.equal(gh, 'token=[]', 'the replaced rule list no longer injects GH_TOKEN')
})

test('disabling a rule through settings stops its injection', async () => {
  await writeFile(
    settingsPath,
    ['env-injector:', '  rules:', '    - command: ^node$', "      argsPattern: '-e'", '      envVar: NODE_AUTH_TOKEN', '      enabled: false', '      flags: ""', ''].join('\n'),
    'utf8',
  )
  await waitFor(async () => {
    const output = await run('node -e "process.stdout.write(String(process.env.NODE_AUTH_TOKEN))"')
    return output === 'undefined'
  }, 'the disabled rule to stop injecting')
})

test('an invalid regex is refused at write time and keeps the last good rules', async () => {
  await assert.rejects(
    ctx.settings.update('env-injector', { rules: [{ command: '(', envVar: 'GH_TOKEN', enabled: true }] }),
    /not a valid regular expression/,
  )
  const output = await run('node -e "process.stdout.write(String(process.env.NODE_AUTH_TOKEN))"')
  assert.equal(output, 'undefined', 'the rejected write left the live rules alone')
})

test('ctx.settings.update() is the live write path a configuration surface uses', async () => {
  await ctx.settings.update('env-injector', {
    rules: [{ command: '^node$', argsPattern: '', envVar: 'NODE_AUTH_TOKEN', enabled: true, flags: '' }],
  })
  await waitFor(async () => {
    const output = await run('node -e "process.stdout.write(String(process.env.NODE_AUTH_TOKEN))"')
    return output === NODE_TOKEN
  }, 'a settings write to reach the live rules')
})

test('an invalid section edited into settings.yaml keeps the last good rules', async () => {
  await writeFile(
    settingsPath,
    ['env-injector:', '  rules:', '    - command: "("', '      envVar: GH_TOKEN', '      enabled: true', ''].join('\n'),
    'utf8',
  )
  /* The settings service refuses the unresolvable section, so the namespace
   * keeps its last good value and the plugin keeps injecting. Give the watcher
   * time to have processed the edit before asserting that. */
  await new Promise((resolve) => setTimeout(resolve, 400))
  const output = await run('node -e "process.stdout.write(String(process.env.NODE_AUTH_TOKEN))"')
  assert.equal(output, NODE_TOKEN, 'the previous good rules are still live')
})

test('unloading the plugin restores the original spawn', async () => {
  await ctx.settings.update('env-injector', {
    rules: [{ command: '^gh(\\.exe)?$', argsPattern: '', envVar: 'GH_TOKEN', enabled: true, flags: '' }],
  })
  await waitFor(async () => (await run('gh --version >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"')) === `token=[${TOKEN}]`, 'the restored gh rule to inject')
  await pluginFiber.dispose()
  const output = await run('gh --version >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"')
  assert.equal(output, 'token=[]', 'the wrapper is gone with the plugin')
  await assert.rejects(ctx.settings.update('env-injector', { rules: [] }), /not registered|not a lowercase|unknown/i)
})

test('the older-provider fallback (register + watch) works on the real service', async () => {
  /* Simulate a settings provider from before `installSection` existed: the
   * plugin must fall back to `register` + `watch` by itself. */
  const installSection = SettingsProvider.prototype.installSection
  delete SettingsProvider.prototype.installSection
  const directory = await mkdtemp(join(tmpdir(), 'dsh-env-injector-fallback-'))
  const path = join(directory, 'settings.yaml')
  await writeFile(path, '{}\n', 'utf8')
  const fallbackCtx = new Context()
  try {
    await fallbackCtx.plugin(asPlugin(subprocessProvider), {})
    await fallbackCtx.plugin(asPlugin(settingsFileProvider), { path, watch: true, debounceMs: 50 })
    const fiber = await fallbackCtx.plugin(asPlugin(injectorModule), { rules: COMPOSITION_RULES })
    const runIn = async (command) => {
      const handle = fallbackCtx.subprocess.spawn({
        argv: ['bash', '-c', command],
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
        graceMs: 5_000,
      })
      await handle.done
      return handle.collected.stdout.readFrom(0).text
    }
    assert.equal(await runIn('gh --version >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"'), `token=[${TOKEN}]`)
    await writeFile(path, ['env-injector:', '  rules:', '    - command: ^echo$', '      envVar: GH_TOKEN', '      enabled: true', ''].join('\n'), 'utf8')
    await waitFor(async () => (await runIn('echo hi >/dev/null; printf "token=[%s]" "$GH_TOKEN"')) === `token=[${TOKEN}]`, 'the fallback watcher to pick up the user layer')
    await fiber.dispose()
    assert.equal(await runIn('gh --version >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"'), 'token=[]', 'restored after unload')
  } finally {
    SettingsProvider.prototype.installSection = installSection
    await fallbackCtx.fiber.dispose()
  }
})
