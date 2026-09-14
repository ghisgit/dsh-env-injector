/**
 * Build the browser half: `src/client/**` → `lib/client.js`.
 *
 * The output is not a module the shell imports — it is a bundle the client
 * module system LOADS, so it has to arrive in that system's own form: one
 * `window.__ModuleLoader__.load({ id, factory })` call whose id is this
 * package's name and whose factory returns the module's exports. Executing the
 * file registers a factory; nothing in it runs until the browser materializes
 * the module, which is what keeps a plugin bundle's CSS injection and
 * component code off the critical path.
 *
 * esbuild does the bundling (TypeScript, TSX, and the relative imports between
 * this package's own client modules) and nothing else: `packages: 'external'`
 * leaves every bare specifier as a `require(...)` for the shell's module table,
 * and the banner/footer below are what turn a CommonJS bundle into that single
 * factory call. The build then refuses a request the baseline table cannot
 * answer, so a bad import fails here rather than in a user's console.
 *
 * The artifact is committed (`lib/client.js`, like `lib/index.js`), because a
 * git or tarball install must load without a build step. The header it carries
 * holds a digest of the sources it was built from, and the test suite checks
 * that digest — a stale committed bundle is the one failure mode a committed
 * build introduces.
 *
 * @module dsh-env-injector/scripts/build-client
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { CLIENT_BASELINE } from './client-baseline.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const clientDir = join(root, 'src', 'client')
const entry = join(clientDir, 'index.tsx')
const outputPath = join(root, 'lib', 'client.js')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** The marker and digest the staleness check reads out of the artifact. */
export const SOURCE_DIGEST_PREFIX = 'sources-sha256:'

/**
 * Every TypeScript source of the browser half, in a stable order.
 * @param dir - the directory to walk.
 * @returns absolute file paths, sorted.
 */
function clientSources(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...clientSources(path))
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(path)
  }
  return files.sort()
}

/**
 * Digest the browser half's sources: their repository-relative paths and bytes,
 * in a stable order.
 * @returns the hex digest the artifact embeds.
 */
export function sourcesDigest() {
  const hash = createHash('sha256')
  for (const file of clientSources(clientDir)) {
    hash.update(relative(root, file))
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

/** The loader call the factory body is wrapped in. */
const BANNER = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(manifest.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;`

/** Close the factory and the loader call, returning the module's exports. */
const FOOTER = `\t\treturn module.exports;
\t}
});
`

/**
 * Build the bundle and write `lib/client.js`.
 * @returns the artifact's path and the digest it was built from.
 */
export async function buildClient() {
  const digest = sourcesDigest()
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    packages: 'external',
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: BANNER },
    footer: { js: FOOTER },
  })
  const [output] = result.outputFiles ?? []
  if (output === undefined) throw new Error('build-client: esbuild produced no output')

  const requested = [...new Set([...output.text.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]))]
  const unknown = requested.filter((name) => !CLIENT_BASELINE.includes(name))
  if (unknown.length > 0) {
    throw new Error(
      `build-client: the bundle requests modules the client baseline does not seed: ${unknown.join(', ')}. `
      + 'A browser half resolves only against the platform table plus its own dsh.client.external suppliers — '
      + 'declare the dependency and compose its supplier, or drop the import.',
    )
  }

  const header = [
    '/*',
    ` * dsh-env-injector — browser half. Built from src/client/** by scripts/build-client.mjs; do not edit.`,
    ` * ${SOURCE_DIGEST_PREFIX}${digest}`,
    ` * Modules requested: ${requested.length === 0 ? '(none)' : requested.join(', ')}`,
    ' */',
    '',
  ].join('\n')

  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(outputPath, header + output.text)
  return { path: outputPath, digest, requested }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { path, requested } = await buildClient()
  console.log(`build-client: ${relative(root, path)} (${requested.length} external module request(s))`)
}
