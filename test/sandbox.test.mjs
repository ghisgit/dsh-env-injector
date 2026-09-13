/**
 * The production request path, reproduced end to end: the REAL sandbox provider
 * wraps a command the way `dsh-bash-sandbox` does, and the REAL subprocess
 * provider runs the wrapped argv as a real child process.
 *
 * This is the test that catches the argv shape a plain
 * `['bash','-c',cmd]` fixture hides: `dsh-sandbox-local`'s `confine()` returns
 * `[...runnerArgv, '--', ...argv]`, so in a real deployment the spawn spec this
 * plugin sees starts with `bwrap` (Linux), the Landlock launcher, or
 * `sandbox-exec` (macOS) — never with the shell. A matcher that only unwraps a
 * shell at `argv[0]` therefore matches nothing at all, which is exactly how the
 * first version of this plugin failed silently in production.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import * as sandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import * as subprocessProvider from '@deepseek-ai/dsh-subprocess-local'
import * as injectorModule from '../lib/index.js'

const TOKEN = 'sandbox-path-token-9876543210'
const asPlugin = (module) => module.default ?? module

/**
 * The composition entry these tests load the plugin with: the plugin ships an
 * empty rule list, so a deployment that wants gh/git to see the token states
 * exactly this.
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

/**
 * Boot one context with the real providers and run one command through the real
 * confinement path.
 * @param command - the shell command line to confine and run.
 * @param configure - applied after the subprocess sandbox is mounted.
 * @returns the child's combined output and the argv that was spawned.
 */
async function runConfined(command, configure) {
  process.env.GH_TOKEN = TOKEN
  const ctx = new Context()
  try {
    await ctx.plugin(asPlugin(subprocessProvider), {})
    await ctx.plugin(asPlugin(sandboxProvider), {})
    if (configure !== undefined) await configure(ctx)
    /* Exactly what `SandboxBashExecutor.confine()` does. */
    const confined = ctx.sandbox.confine(['bash', '-c', command], { mode: 'workspace-write', workspaceRoot: process.cwd() })
    const handle = ctx.subprocess.spawn({
      argv: [...confined.argv],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 5_000,
    })
    await handle.done
    return {
      argv: confined.argv,
      enforcement: confined.enforcement,
      output: `${handle.collected.stdout.readFrom(0).text}${handle.collected.stderr.readFrom(0).text}`,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

test('a sandbox-wrapped command still receives its injected variable', async () => {
  const { argv, output, enforcement } = await runConfined(
    'gh --version >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"',
    async (ctx) => {
      await ctx.plugin(asPlugin(injectorModule), { rules: COMPOSITION_RULES })
    },
  )
  assert.notEqual(argv[0], 'bash', `the command really was wrapped by the sandbox (argv[0]=${String(argv[0])}, enforcement=${enforcement})`)
  assert.ok(argv.includes('--'), 'the wrapper separates its own arguments with --')
  assert.equal(output, `token=[${TOKEN}]`, 'injection reaches the child through the confined argv')
})

test('a sandbox-wrapped non-matching command gets nothing', async () => {
  const { output } = await runConfined('printf "token=[%s]" "$GH_TOKEN"', async (ctx) => {
    await ctx.plugin(asPlugin(injectorModule), { rules: COMPOSITION_RULES })
  })
  assert.equal(output, 'token=[]')
})

test('without the plugin the wrapped command receives nothing (control)', async () => {
  const { argv, output } = await runConfined('gh --version >/dev/null 2>&1; printf "token=[%s]" "$GH_TOKEN"')
  assert.notEqual(argv[0], 'bash')
  assert.equal(output, 'token=[]')
})

test('a sandbox-wrapped git remote command is selected by argsPattern', async () => {
  /* Injection is per SPAWN, not per shell segment: a command line that contains
   * a matching command hands the whole (single) child the variable, which is
   * what "only this command gets it" means at the environment layer. A separate
   * spawn running only `git status` must stay clean. */
  const pushing = await runConfined('git push origin main >/dev/null 2>&1; printf "push=[%s]" "$GH_TOKEN"', async (ctx) => {
    await ctx.plugin(asPlugin(injectorModule), { rules: COMPOSITION_RULES })
  })
  assert.equal(pushing.output, `push=[${TOKEN}]`)
  const status = await runConfined('git status >/dev/null 2>&1; printf "status=[%s]" "$GH_TOKEN"', async (ctx) => {
    await ctx.plugin(asPlugin(injectorModule), { rules: COMPOSITION_RULES })
  })
  assert.equal(status.output, 'status=[]')
})
