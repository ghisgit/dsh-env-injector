/**
 * Installer tests: the wrapper that is put on `ctx.subprocess`, its coverage of
 * `spawnTerminal` (the PTY path a persistent-shell composition uses), and the
 * teardown contract — all against a stub runtime, so what is asserted is the
 * spec that reaches the seam rather than any provider's behaviour.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compileConfig, installSpawnInjection } from '../lib/index.js'

/** A logger that goes nowhere; the installer also writes notices to stderr. */
const silentLogger = { info() {}, warn() {}, debug() {}, error() {} }

/** Written records of what the stub provider received. */
const compiled = (rules) => compileConfig({ rules, overrideExisting: true, terminal: true, logMatches: false })

/** A runtime shaped like a real provider: prototype methods, own-property patch. */
class StubRuntime {
  calls = []

  spawn(spec) {
    this.calls.push({ method: 'spawn', spec })
    return { handle: 'spawn', spec }
  }

  async spawnTerminal(spec) {
    this.calls.push({ method: 'spawnTerminal', spec })
    return { handle: 'terminal', spec }
  }
}

process.env.WRAP_TOKEN = 'wrapper-value'

const GH_ON_SHELL = [
  { command: '^bash$', argsPattern: '', envVar: 'WRAP_TOKEN', enabled: true, flags: '' },
  { command: '^gh(\\.exe)?$', argsPattern: '', envVar: 'WRAP_TOKEN', enabled: true, flags: '' },
]

test('both methods are wrapped and the terminal spec is rewritten', async () => {
  const runtime = new StubRuntime()
  const dispose = installSpawnInjection(runtime, ['spawn', 'spawnTerminal'], () => compiled(GH_ON_SHELL), silentLogger)

  /* The PTY argv a minimal-preset persistent shell is created with. */
  const terminalSpec = { argv: ['/bin/bash', '--noprofile', '--norc'], cwd: '/workspace', env: { TERM: 'dumb' }, rows: 24, cols: 80, graceMs: 3000 }
  const terminal = await runtime.spawnTerminal(terminalSpec)
  assert.deepEqual(terminal.spec.env, { TERM: 'dumb', WRAP_TOKEN: 'wrapper-value' }, 'the shell spawn carries the variable into the session')
  assert.deepEqual(terminalSpec.env, { TERM: 'dumb' }, 'the caller’s spec object is not mutated')

  const spawn = runtime.spawn({ argv: ['gh', 'pr', 'list'], cwd: '/workspace', env: {} })
  assert.equal(spawn.spec.env.WRAP_TOKEN, 'wrapper-value')

  const other = runtime.spawn({ argv: ['echo', 'hi'], cwd: '/workspace', env: {} })
  assert.equal(other.spec.env.WRAP_TOKEN, undefined, 'a non-matching command is untouched')

  dispose()
})

test('a non-matching terminal (or one with terminal coverage off) is passed through identically', async () => {
  const runtime = new StubRuntime()
  const rules = [{ command: '^gh$', argsPattern: '', envVar: 'WRAP_TOKEN', enabled: true, flags: '' }]
  const dispose = installSpawnInjection(runtime, ['spawn', 'spawnTerminal'], () => compiled(rules), silentLogger)
  const spec = { argv: ['/bin/bash', '--noprofile'], cwd: '/workspace', env: {}, rows: 24, cols: 80, graceMs: 3000 }
  await runtime.spawnTerminal(spec)
  assert.equal(runtime.calls[0].spec, spec, 'an unmatched terminal request is the very same object')
  dispose()

  /* With terminal coverage off the method is not wrapped at all. */
  const spawnOnly = new StubRuntime()
  const disposeSpawnOnly = installSpawnInjection(spawnOnly, ['spawn'], () => compiled(GH_ON_SHELL), silentLogger)
  const untouched = { argv: ['/bin/bash'], cwd: '/workspace', rows: 24, cols: 80, graceMs: 3000 }
  await spawnOnly.spawnTerminal(untouched)
  assert.equal(spawnOnly.calls[0].spec, untouched)
  assert.equal(Object.getOwnPropertyDescriptor(spawnOnly, 'spawnTerminal'), undefined, 'spawnTerminal stays a prototype method')
  disposeSpawnOnly()
})

test('teardown restores both methods and stops rewriting', async () => {
  const runtime = new StubRuntime()
  const dispose = installSpawnInjection(runtime, ['spawn', 'spawnTerminal'], () => compiled(GH_ON_SHELL), silentLogger)
  assert.notEqual(Object.getOwnPropertyDescriptor(runtime, 'spawn'), undefined)
  dispose()
  assert.equal(Object.getOwnPropertyDescriptor(runtime, 'spawn'), undefined, 'the own property is removed, restoring the prototype method')
  assert.equal(Object.getOwnPropertyDescriptor(runtime, 'spawnTerminal'), undefined)
  const spec = { argv: ['/bin/bash'], cwd: '/workspace', env: {}, rows: 24, cols: 80, graceMs: 3000 }
  await runtime.spawnTerminal(spec)
  assert.equal(runtime.calls.at(-1).spec, spec, 'after teardown the request is handed over unchanged')
})

test('a second installation on the same runtime is refused', () => {
  const runtime = new StubRuntime()
  const dispose = installSpawnInjection(runtime, ['spawn'], () => compiled(GH_ON_SHELL), silentLogger)
  assert.throws(() => installSpawnInjection(runtime, ['spawn'], () => compiled(GH_ON_SHELL), silentLogger), /already wrapped/)
  dispose()
  /* And the marker is gone, so a later installation is possible again. */
  const disposeAgain = installSpawnInjection(runtime, ['spawn'], () => compiled(GH_ON_SHELL), silentLogger)
  disposeAgain()
})

test('a reference captured before teardown passes arguments through', () => {
  const runtime = new StubRuntime()
  const captured = runtime.spawn
  const dispose = installSpawnInjection(runtime, ['spawn'], () => compiled(GH_ON_SHELL), silentLogger)
  dispose()
  const spec = { argv: ['gh', 'pr', 'list'], cwd: '/workspace', env: {} }
  runtime.spawn(spec)
  assert.equal(runtime.calls.at(-1).spec, spec)
  assert.equal(typeof captured, 'function')
})
