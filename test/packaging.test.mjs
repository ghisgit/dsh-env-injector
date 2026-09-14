/**
 * Packaging tests: the claims this plugin makes about how DSH installs and
 * loads it.
 *
 * - the shipped `cordis.patch.yml` is a valid patch list whose row names this
 *   package and whose config resolves to the schema defaults — i.e. an empty
 *   rule list, so an unconfigured install injects nothing — and whose
 *   documented example rule survives YAML → schema with its regex intact,
 * - `package.json` declares the bundle patch the `dsh plugin` reconciler looks
 *   for and the `dsh.client` declaration the Web UI's module system serves,
 *   and every path it publishes exists,
 * - the package resolves and unwraps from a profile-shaped `node_modules` the
 *   way `ctx.loader` resolves it (`default ?? namespace` → object plugin with
 *   `name`/`inject`/`Config`/`apply`).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import yaml from 'js-yaml'

import { Config, NS, compileConfig, extractInvocations, matchRules } from '../lib/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('the package declares the bundle patch the profile reconciler detects', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(existsSync(join(root, 'cordis.patch.yml')), true)
})

test('every published entry point exists', () => {
  assert.equal(existsSync(join(root, manifest.main)), true, 'main exists')
  assert.equal(existsSync(join(root, manifest.types)), true, 'types exist')
  assert.equal(existsSync(join(root, manifest.exports['.'].default)), true)
  assert.equal(existsSync(join(root, manifest.exports['.'].types)), true)
  assert.equal(existsSync(join(root, manifest.exports['./cordis.patch.yml'])), true)
  assert.equal(existsSync(join(root, manifest.exports['./client'].default)), true, 'the browser half is built')
})

test('the package declares the browser half the client module system serves', () => {
  /* `dsh.client` is what makes the host scan this package as a browser plugin
   * and serve `exports['./client']`; that half is what registers the card
   * making the settings namespace configurable in the Web UI. Both faces live
   * in this one package: the node half is the Loader row, the browser half is
   * the `./client` export. */
  assert.deepEqual(manifest.dsh.client, { platform: 'web' })
  const bundle = readFileSync(join(root, manifest.exports['./client'].default), 'utf8')
  assert.ok(
    bundle.includes(`window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(manifest.name)},`),
    'the client export is a lazy-CJS factory registered under the package name',
  )
  assert.match(bundle, /factory: \(require\) => \{/, 'the bundle hands the shell its own `require`')
  assert.ok(
    manifest.files.some((entry) => entry === 'lib' || entry.startsWith('lib/')),
    'the built browser half ships with the package',
  )
})

test('cordis.patch.yml inserts one row naming this package', () => {
  const patch = yaml.load(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))
  assert.ok(Array.isArray(patch), 'a patch list is a YAML array')
  const rows = patch.flatMap((entry) => entry.insert ?? [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, NS, 'the row id is the settings namespace the plugin owns')
  assert.equal(rows[0].name, manifest.name, 'the row resolves the package by name')
})

test('the shipped composition entry injects nothing on its own', () => {
  const patch = yaml.load(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))
  const [row] = patch[0].insert
  const resolved = Config(row.config)
  assert.deepEqual(resolved, Config({}), 'the YAML example and the schema defaults agree')
  assert.deepEqual(resolved.rules, [], 'no built-in rule ships with the plugin')
  /* An unconfigured install is inert, and that is a schema-level guarantee. */
  assert.deepEqual(Config({}).rules, [])
  assert.deepEqual(Config({ rules: [] }).rules, [])
})

test('a rule written in the patch dialect compiles the way an operator means it', () => {
  /* The pattern below is the one the README recipe and the commented example in
   * cordis.patch.yml both recommend, so it is the shortest path from "what an
   * operator pastes" to "what the wrapper matches". */
  const argsPattern = '^(?:-[cC]\\s+\\S+\\s+|--\\S+(?:=\\S+)?\\s+)*(?:push|fetch|pull|clone|ls-remote)\\b'
  const rule = { command: '^git(\\.exe)?$', argsPattern, envVar: 'GH_TOKEN', enabled: true, flags: '' }
  const resolved = Config(yaml.load(yaml.dump({ rules: [rule] })))
  assert.deepEqual(resolved.rules, [rule], 'every field survives YAML → schema intact')
  /* It really is a working regex, not just a string that round-trips: every
   * remote subcommand matches, with or without git's leading global flags. */
  const compiled = compileConfig(resolved).rules
  for (const accepted of ['push origin main', 'fetch', 'pull --rebase', '-C /repo push', '-c k=v fetch', '--no-pager pull']) {
    assert.equal(matchRules(extractInvocations(['git', ...accepted.split(' ')]), compiled).length, 1, `git ${accepted} matches`)
  }
  for (const rejected of ['status', 'commit -m x', 'log --oneline']) {
    assert.equal(matchRules(extractInvocations(['git', ...rejected.split(' ')]), compiled).length, 0, `git ${rejected} does not match`)
  }
})

test('no deployment-supplied rule may forward a DSH_* name', () => {
  const rules = Config({
    rules: [{ command: '^gh$', envVar: 'GH_TOKEN', enabled: true }],
  }).rules
  for (const rule of rules) assert.equal(rule.envVar.startsWith('DSH_'), false)
  assert.match(NS, /^[a-z][a-z0-9-]*$/, 'the namespace satisfies the settings namespace grammar')
  assert.equal(NS.startsWith('dsh-'), false, 'the namespace stays clear of DSH-managed names')
})

test('the package resolves and unwraps from a profile-shaped node_modules', async () => {
  const profile = join(root, '.tmp', 'pkg-profile')
  const modules = join(profile, 'node_modules')
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(modules, { recursive: true })
  symlinkSync(root, join(modules, manifest.name), 'dir')
  const resolved = createRequire(join(profile, 'package.json')).resolve(manifest.name)
  const module = await import(pathToFileURL(resolved).href)
  const plugin = module.default ?? module
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, 'env-injector')
  assert.deepEqual(plugin.inject, ['subprocess'], 'the settings service stays optional')
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(plugin.Config({}).rules.length, 0, 'the plugin ships no rule of its own')
  rmSync(profile, { recursive: true, force: true })
})
