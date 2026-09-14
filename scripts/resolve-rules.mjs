/**
 * Offline rule-resolution probe.
 *
 * `dsh --dump-config` composes the ENTRY LIST only: base `cordis.yml` + bundle
 * patch layers + the profile/home patch layers. It never reads
 * `$DSH_HOME/settings.yaml`, because that document is not a patch layer at all
 * — it is a *settings namespace* the file-backed settings provider resolves at
 * plugin mount time, above the composition entry.
 *
 * This probe applies the same layering by hand so "which rules actually win?"
 * is answerable without booting the harness:
 *
 *   schema defaults -> composition entry (bundle patch) -> settings.yaml section
 *
 * Caveat: it reads the SHIPPED bundle patch, so a profile patch that replaces
 * the `env-injector` row changes what the composition layer holds. Use
 * `dsh --profile <name> --dump-config` to see that layer as composed.
 *
 * Run: `node scripts/resolve-rules.mjs` (override the locations with DSH_HOME /
 * BUNDLE_PATCH / SETTINGS env vars).
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { Config, compileConfig, describeGuard } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const bundlePatch = process.env.BUNDLE_PATCH ?? resolve(here, '../cordis.patch.yml')
const settingsPath = process.env.SETTINGS ?? join(dshHome, 'settings.yaml')
const NS = 'env-injector'

/** Read a YAML document, or `undefined` when the file is absent/empty. */
const readYaml = (path) => {
  try {
    return load(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Pull the `env-injector` row's config out of a loader patch list. */
const entryFromPatch = (patch) => {
  for (const item of Array.isArray(patch) ? patch : []) {
    const rows = Array.isArray(item?.insert) ? item.insert : [item]
    for (const row of rows) if (row?.id === NS) return row.config
  }
  return undefined
}

const patch = readYaml(bundlePatch)
const entryConfig = entryFromPatch(patch)
if (entryConfig === undefined) throw new Error(`${bundlePatch}: no '- id: ${NS}' row found`)

const settings = readYaml(settingsPath)
const userSection = settings?.[NS]

/* The composition entry is the namespace's `base`; the user section resolves
 * above it. A `rules:` list replaces wholesale — it never merges per-rule. */
const layers = [
  ['defaults', Config({})],
  ['composition', Config(entryConfig)],
  ...(userSection === undefined ? [] : [['settings.yaml', Config({ ...entryConfig, ...userSection })]])
]
const winner = layers.at(-1)

const describe = (resolved) => {
  const compiled = compileConfig(resolved)
  if (compiled.rules.length === 0) return 'none — the plugin injects nothing'
  return compiled.rules
    .map((rule) => {
      const args = rule.argsPattern === undefined ? '' : ` /${rule.argsPattern.source}/`
      return `${rule.command.source}${args} -> ${rule.envVar}`
    })
    .join('\n      ')
}

console.log(`bundle patch  : ${bundlePatch}`)
console.log(`settings file : ${settingsPath}${userSection === undefined ? '  (no env-injector: section)' : ''}`)
for (const [label, resolved] of layers) {
  console.log(`\n[${label}] ${resolved.rules.length} declared rule(s)`)
  console.log(`      ${describe(resolved)}`)
}
console.log(
  `\nEFFECTIVE (${winner[0]}): ${winner[1].rules.filter((rule) => rule.enabled).length} enabled rule(s), ` +
    `overrideExisting=${winner[1].overrideExisting}, logMatches=${winner[1].logMatches}`
)
/* The guard decides whether a matched value is actually delivered and whether
 * it is scrubbed from results, so reporting the rules without it would answer
 * "what is configured" and miss "what will happen". */
console.log(`READ GUARD (${winner[0]}): ${describeGuard(compileConfig(winner[1]).guard)}`)
console.log(
  'note: reads=deny refuses injection into env/printenv-style commands; ' +
    'shells=off still delivers to a shell command line, redact=on is the fallback for that'
)
console.log(
  `note: terminal=${entryConfig.terminal} comes from the COMPOSITION entry ` +
    '(apply() reads entry.terminal, never the settings layer)'
)
