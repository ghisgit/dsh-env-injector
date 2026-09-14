/**
 * Browser-half tests: the card that makes the `env-injector` settings namespace
 * configurable in the Web UI's **Plugin configuration** tab.
 *
 * Everything here runs against the SHIPPED artifact (`lib/client.js`), the way
 * the browser runs it: the file is executed against a `window.__ModuleLoader__`
 * facade, its factory is materialized with a `require` that answers from the
 * client baseline, and the resulting plugin is applied to a context whose three
 * services are fakes — because the contract under test is what this package
 * DOES with those services, not what the services do.
 *
 * The card's DOM is a real one (jsdom) with real React, so the interaction
 * tests exercise the wiring a browser would use: a click stages an edit, typing
 * stages a draft, and a save writes exactly the fields the user touched. Only
 * `@deepseek-ai/dsh-client-ui-primitives` is stubbed — its published build
 * imports CSS modules and is not loadable outside a bundler — and the stub
 * reproduces the behavioral contract of the controls this card renders.
 *
 * @module dsh-env-injector/test/client
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'

import { SOURCE_DIGEST_PREFIX, sourcesDigest } from '../scripts/build-client.mjs'
import { CLIENT_BASELINE } from '../scripts/client-baseline.mjs'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bundlePath = join(root, manifest.exports['./client'].default)
const bundleSource = readFileSync(bundlePath, 'utf8')

/* ────────────────────────────────────────────────────────────────────────────
 * The browser environment the bundle materializes into
 * ──────────────────────────────────────────────────────────────────────────── */

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.Event = dom.window.Event
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/* Node's own `navigator` global is a read-only getter; the renderer wants the
 * page's, which is what a browser would hand it. */
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })

const React = require('react')
const { createRoot } = await import('react-dom/client')

const h = React.createElement

/**
 * The client baseline as this suite provides it: React and the JSX runtime are
 * the real packages, and the shared UI library is a stub honoring the
 * behavioral contract of the controls the card renders.
 * @param name - the requested module specifier.
 * @returns the module the bundle sees.
 */
function requireFrom(name) {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      Button: ({ children, variant, size, icon, ...rest }) => h('button', { type: 'button', ...rest }, children),
      Input: (props) => h('input', props),
      Switch: ({ checked, label, onChange, disabled, title }) => h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        title,
        disabled,
        onClick: () => {
          onChange(!checked)
        },
      }, h('span', null, checked ? 'on' : 'off')),
      Tag: ({ children, tone, className }) => h('span', { className }, children),
      IconChevronDownOutline14: () => h('span', { 'aria-hidden': true }, 'v'),
    }
  }
  throw new Error(`the test suite provides no module ${name}`)
}

/** Load the bundle exactly as the client module system does. */
function loadBundle() {
  let spec
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(loaded) {
        spec = loaded
      },
    },
  }
  try {
    new Function(bundleSource)()
  } finally {
    globalThis.window = previous
  }
  assert.ok(spec, 'the bundle registers a loader factory')
  const requested = []
  const exports = spec.factory((name) => {
    requested.push(name)
    return requireFrom(name)
  })
  return { spec, exports, requested }
}

const { spec, exports: client, requested } = loadBundle()

/* ────────────────────────────────────────────────────────────────────────────
 * Fakes for the three services the browser plugin injects
 * ──────────────────────────────────────────────────────────────────────────── */

const GH = { command: '^gh(\\.exe)?$', argsPattern: '', envVar: 'GH_TOKEN', enabled: true, flags: '' }
const GIT_PUSH = {
  command: '^git(\\.exe)?$',
  argsPattern: '^(?:-[cC]\\s+\\S+\\s+)*(?:push|fetch|pull)\\b',
  envVar: 'GH_TOKEN',
  enabled: true,
  flags: '',
}

/** The section every test starts from: two rules, all options at their defaults. */
const section = (rules = []) => ({ rules, overrideExisting: true, terminal: true, logMatches: false })

/**
 * One in-memory settings scope with the write behavior the card depends on: a
 * mutation applies its path ops to the user layer, bumps the revision, re-seeds
 * the resolved value, and notifies its subscribers.
 *
 * The scope carries the suite's own handles too (`writes`, `userLayer`,
 * `refuseNext`), so a test asserts against the same object it binds.
 *
 * @param options - the starting user layer and scope status.
 * @returns the scope, with the test handles attached.
 */
function createScope(options = {}) {
  const base = options.base ?? section([GH, GIT_PUSH])
  const listeners = new Set()
  const writes = []
  let user = options.user
  let writable = options.writable ?? true
  let revision = 1
  let failure
  const resolve = () => (user === undefined ? base : { ...base, ...user })
  let snapshot = {
    status: options.status ?? 'ready',
    value: resolve(),
    base,
    user,
    revision,
    writable,
    mode: writable ? 'host' : 'memory',
  }
  const publish = () => {
    snapshot = { ...snapshot, value: resolve(), user, revision, writable }
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    mutate: async (ops) => {
      writes.push(ops)
      /* A real write crosses the wire, so the card has to observe its own
       * in-flight state before the answer lands — a mutation that resolved in
       * the same microtask would hide the saving state from every test. */
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
      if (failure !== undefined) {
        const refused = failure
        failure = undefined
        throw refused
      }
      const next = { ...(user ?? {}) }
      for (const op of ops) {
        const [field] = op.path
        if (op.op === 'set') next[field] = op.value
        else delete next[field]
      }
      user = next
      revision += 1
      publish()
    },
    set: async (field, value) => {
      user = { ...(user ?? {}), [field]: value }
      revision += 1
      publish()
    },
    unset: async (field) => {
      const next = { ...(user ?? {}) }
      delete next[field]
      user = next
      revision += 1
      publish()
    },
    /** Every mutation this scope received, in call order. */
    writes,
    /** The current raw user layer, as a save would leave it. */
    userLayer: () => user,
    /** Make the next mutation refuse, the way a Host validation does. */
    refuseNext: () => {
      failure = new Error('refused')
    },
  }
}

/**
 * Apply the browser half to a fake context, capturing what it registers.
 * @param scope - the fake settings scope the plugin binds.
 * @returns the captured registrations, dictionaries, and bound namespaces.
 */
function applyClient(scope) {
  const registrations = []
  const dictionaries = []
  const bound = []
  const ctx = {
    effect: (callback) => {
      callback()
      return () => {}
    },
    locale: {
      register: (ns, dicts) => {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind: () => (key) => key,
    },
    settingsScope: {
      bind: (spec) => {
        bound.push(spec)
        return scope
      },
    },
    slots: {
      inject: (key, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)
  return { registrations, dictionaries, bound }
}

/** The face the card's slot entry injects, from the captured registration. */
const faceOf = (registration) => registration.options.inject()

/** The copy this plugin registers, for assertions and for the `t` seat. */
const dicts = applyClient(createScope()).dictionaries[0].dicts

/**
 * Build the props the renderer composes: the inject face (with its `hooks`
 * compartment bound as the framework's `use<Name>` selector hook) plus the
 * locale `t` seat.
 * @param registration - the captured card registration.
 * @returns the component props.
 */
function propsOf(registration) {
  const face = faceOf(registration)
  const source = face.hooks.envInjectorCard
  return {
    ...face,
    useEnvInjectorCard: (selector) => selector(
      React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot),
    ),
    t: (key, params) => {
      const template = dicts.en[key] ?? key
      return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
    },
  }
}

/** The card component under test: what the slot ledger would store. */
const CARD = applyClient(createScope()).registrations[0].component

/* ────────────────────────────────────────────────────────────────────────────
 * DOM helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** Let every pending promise, timer, and effect settle inside React's act. */
const settle = () => React.act(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  await new Promise((resolve) => setImmediate(resolve))
})

/**
 * Mount the card into a fresh container.
 * @param props - the component props.
 * @returns the container and an unmount action.
 */
async function mount(props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => {
    root.render(h(CARD, props))
  })
  return {
    container,
    unmount: async () => {
      await React.act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** Click one element and settle React. */
async function click(element) {
  await React.act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

/** Type into one controlled input and settle React. */
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  await React.act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

/** Every element matching one selector. */
const all = (container, selector) => [...container.querySelectorAll(selector)]

/** The single element matching one selector, or a readable failure. */
function one(container, selector) {
  const found = container.querySelector(selector)
  assert.ok(found !== null, `expected an element matching ${selector}`)
  return found
}

/** The button whose visible copy is one string. */
const button = (container, label) => {
  const found = all(container, 'button').find((node) => node.textContent === label)
  assert.ok(found !== undefined, `expected a button labelled ${label}`)
  return found
}

/** The rule inputs of the card, in render order (four per rule). */
const ruleInputs = (container) => all(container, '.evi-ruleGrid input')

/** The switch of one option row, addressed by its accessible name. */
const optionSwitch = (container, label) => {
  const found = all(container, '.evi-field [role="switch"]').find((node) => node.getAttribute('aria-label') === label)
  assert.ok(found !== undefined, `expected a switch labelled ${label}`)
  return found
}

/* ────────────────────────────────────────────────────────────────────────────
 * The shipped bundle
 * ──────────────────────────────────────────────────────────────────────────── */

test('the shipped bundle registers this package as one client module', () => {
  assert.equal(spec.id, manifest.name, 'the loader id is the package name the host serves the bundle under')
  assert.equal(typeof spec.factory, 'function')
  assert.equal(typeof client.apply, 'function', 'the module exposes a plugin body')
  assert.ok(Array.isArray(client.inject), 'the module declares the services it needs')
})

test('the browser half injects only services the client composition provides', () => {
  assert.deepEqual(client.inject, ['slots', 'locale', 'settingsScope'])
})

test('every module the bundle requests is answered by the client baseline', () => {
  assert.deepEqual([...new Set(requested)].sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'])
  for (const name of requested) assert.ok(CLIENT_BASELINE.includes(name), `${name} is seeded by the shell`)
})

test('materializing the bundle installs the card stylesheet once', () => {
  const tag = document.querySelector('style[data-plugin-css="dsh-env-injector/client/card.css"]')
  assert.ok(tag !== null, 'the stylesheet is in the page')
  assert.match(tag.textContent, /\.evi-card\{/)
})

/* ────────────────────────────────────────────────────────────────────────────
 * Registration
 * ──────────────────────────────────────────────────────────────────────────── */

test('applying the browser half registers one card keyed by the settings namespace', () => {
  const { registrations, dictionaries, bound } = applyClient(createScope())
  assert.equal(registrations.length, 1, 'exactly one card')
  const { options } = registrations[0]
  assert.equal(options.name, 'settings.plugin.item')
  assert.equal(options.key, 'env-injector', 'the key pairs the card with the Host-served namespace')
  assert.equal(options.locale, 'env-injector', 'the copy seat is this plugin own namespace')
  assert.equal(typeof registrations[0].component, 'function')
  assert.deepEqual(bound, [{ namespace: 'env-injector' }], 'the card binds the namespace it edits')
  assert.equal(dictionaries.length, 1)
  assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'], 'both shipped languages are registered')
  const en = Object.keys(dictionaries[0].dicts.en).sort()
  assert.deepEqual(Object.keys(dictionaries[0].dicts.zh).sort(), en, 'both dictionaries carry the same keys')
})

/* ────────────────────────────────────────────────────────────────────────────
 * The form model
 * ──────────────────────────────────────────────────────────────────────────── */

test('a save writes only the fields the user touched', async () => {
  const scope = createScope()
  const face = faceOf(applyClient(scope).registrations[0])
  face.setOption('terminal', false)
  face.save()
  await settle()
  assert.deepEqual(scope.writes, [[{ op: 'set', path: ['terminal'], value: false }]])
  assert.deepEqual(scope.userLayer(), { terminal: false })
})

test('an invalid rule draft blocks the save and is reported per field', () => {
  const scope = createScope()
  const face = faceOf(applyClient(scope).registrations[0])
  face.addRule()
  face.editRule(2, { command: '^bad(', envVar: 'TOKEN' })
  const state = face.hooks.envInjectorCard.getSnapshot()
  assert.deepEqual(state.issues, [undefined, undefined, 'regex'])
  assert.equal(state.invalid, true)
  assert.equal(state.dirty, true)
  face.save()
  assert.deepEqual(scope.writes, [], 'an impossible draft never reaches the wire')
  face.editRule(2, { command: '^good$' })
  assert.equal(face.hooks.envInjectorCard.getSnapshot().invalid, false)
})

test('an empty envVar or command is refused before the Host sees it', () => {
  const face = faceOf(applyClient(createScope()).registrations[0])
  face.addRule()
  assert.equal(face.hooks.envInjectorCard.getSnapshot().issues[2], 'command')
  face.editRule(2, { command: '.*' })
  assert.equal(face.hooks.envInjectorCard.getSnapshot().issues[2], 'envVar')
  face.editRule(2, { envVar: 'TOKEN' })
  assert.deepEqual(face.hooks.envInjectorCard.getSnapshot().issues, [undefined, undefined, undefined])
})

test('reset stages a clear, so saving lets the field follow the deployment again', async () => {
  const scope = createScope({ user: { rules: [GH] } })
  const face = faceOf(applyClient(scope).registrations[0])
  assert.equal(face.hooks.envInjectorCard.getSnapshot().overridden.rules, true)
  face.resetField('rules')
  assert.equal(face.hooks.envInjectorCard.getSnapshot().overridden.rules, false, 'the badge previews the post-save state')
  face.save()
  await settle()
  assert.deepEqual(scope.writes, [[{ op: 'unset', path: ['rules'] }]])
  assert.equal(scope.userLayer().rules, undefined)
})

test('a refused write keeps the drafts and reports the failure', async () => {
  const scope = createScope()
  scope.refuseNext()
  const face = faceOf(applyClient(scope).registrations[0])
  face.setOption('logMatches', true)
  face.save()
  await settle()
  const state = face.hooks.envInjectorCard.getSnapshot()
  assert.equal(state.failed, true)
  assert.equal(state.dirty, true, 'the edit is still there to correct')
  face.discard()
  assert.equal(face.hooks.envInjectorCard.getSnapshot().dirty, false)
})

test('a staged draft that restates the effective value is not a change', () => {
  const face = faceOf(applyClient(createScope()).registrations[0])
  face.setOption('terminal', true)
  assert.equal(face.hooks.envInjectorCard.getSnapshot().dirty, false)
  face.editRule(0, { command: GH.command })
  assert.equal(face.hooks.envInjectorCard.getSnapshot().dirty, false, 'an edit back to the same value stages nothing')
  face.removeRule(1)
  assert.equal(face.hooks.envInjectorCard.getSnapshot().dirty, true)
})

/* ────────────────────────────────────────────────────────────────────────────
 * The rendered card
 * ──────────────────────────────────────────────────────────────────────────── */

test('the card renders nothing while its namespace is unavailable', async () => {
  const face = faceOf(applyClient(createScope({ status: 'unavailable' })).registrations[0])
  const { container, unmount } = await mount(propsOf({ options: { inject: () => face } }))
  assert.equal(container.innerHTML, '')
  await unmount()
})

test('the card names the plugin and discloses its controls on demand', async () => {
  const registration = applyClient(createScope()).registrations[0]
  const { container, unmount } = await mount(propsOf(registration))
  const header = one(container, '.evi-header')
  assert.match(header.textContent, /Environment injection/)
  assert.equal(all(container, '.evi-body').length, 0, 'collapsed by default')
  await click(header)
  assert.equal(all(container, '.evi-body').length, 1)
  assert.deepEqual(ruleInputs(container).map((input) => input.value), [
    GH.command, GH.argsPattern, GH.envVar, GH.flags,
    GIT_PUSH.command, GIT_PUSH.argsPattern, GIT_PUSH.envVar, GIT_PUSH.flags,
  ])
  assert.equal(all(container, '.evi-rule').length, 2)
  await unmount()
})

test('a toggle stages an edit, marks the card unsaved, and a save writes it', async () => {
  const scope = createScope()
  const registration = applyClient(scope).registrations[0]
  const { container, unmount } = await mount(propsOf(registration))
  await click(one(container, '.evi-header'))
  const save = button(container, 'Save')
  assert.equal(save.disabled, true, 'nothing to save yet')
  await click(optionSwitch(container, 'Cover terminal sessions'))
  assert.equal(one(container, '.evi-pending').textContent, 'Unsaved')
  assert.equal(save.disabled, false)
  await click(save)
  await settle()
  assert.deepEqual(scope.writes, [[{ op: 'set', path: ['terminal'], value: false }]])
  assert.equal(all(container, '.evi-body').length, 0, 'a landed save collapses the card')
  await unmount()
})

test('a new rule must be completed before the card will save it', async () => {
  const scope = createScope()
  const registration = applyClient(scope).registrations[0]
  const { container, unmount } = await mount(propsOf(registration))
  await click(one(container, '.evi-header'))
  await click(button(container, 'Add rule'))
  assert.equal(all(container, '.evi-rule').length, 3)
  const [added] = all(container, '.evi-rule').slice(2)
  assert.match(added.querySelector('.evi-error').textContent, /command pattern/)
  const save = button(container, 'Save')
  assert.equal(save.disabled, true, 'an incomplete rule blocks the save')
  await type(ruleInputs(container)[8], '^npm$')
  await type(ruleInputs(container)[10], 'NODE_AUTH_TOKEN')
  assert.equal(save.disabled, false)
  await click(save)
  await settle()
  assert.equal(scope.writes.length, 1)
  const [ops] = scope.writes
  assert.deepEqual(ops.map((op) => op.path[0]), ['rules'])
  assert.deepEqual(ops[0].value.map((rule) => rule.command), [GH.command, GIT_PUSH.command, '^npm$'])
  await unmount()
})

test('a read-only document disables the controls and says why', async () => {
  const registration = applyClient(createScope({ writable: false })).registrations[0]
  const { container, unmount } = await mount(propsOf(registration))
  await click(one(container, '.evi-header'))
  assert.match(one(container, '.evi-notice').textContent, /read-only/)
  for (const control of all(container, 'input, button[role="switch"], .evi-reset')) {
    assert.equal(control.disabled, true, `${control.className || control.tagName} is disabled`)
  }
  await unmount()
})

/* ────────────────────────────────────────────────────────────────────────────
 * The committed artifact
 * ──────────────────────────────────────────────────────────────────────────── */

test('the committed bundle was built from the current sources', () => {
  const digest = sourcesDigest()
  assert.ok(
    bundleSource.includes(`${SOURCE_DIGEST_PREFIX}${digest}`),
    'lib/client.js is stale — run pnpm build after changing src/client',
  )
})
