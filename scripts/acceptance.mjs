/**
 * Acceptance run against the REAL DSH seams — the check the unit suite cannot
 * make, because it needs the packages a deployment actually mounts:
 *
 *   real @deepseek-ai/dsh-subprocess-local  (a real child process)
 *   real @deepseek-ai/dsh-tools             (the real tool registry)
 *   real @deepseek-ai/dsh-settings-file     (a real settings.yaml, watched)
 *   real @deepseek-ai/dsh-system-prompt     (a registry prerequisite)
 *
 * It injects a token into a real child, checks that the read guard refuses the
 * readers, drives the real `postExecute` waterfall to prove redaction, and
 * edits the settings file to prove the rules are live.
 *
 * The DSH packages resolve from a DSH installation, so point DSH_MODULES at one
 * when they are not reachable from this checkout:
 *
 *   node scripts/acceptance.mjs
 *   DSH_MODULES=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai node scripts/acceptance.mjs
 *
 * The settings file it writes lives in `.tmp/` (git-ignored) and is rewritten
 * during the run — never point it at a real $DSH_HOME.
 */
import { Context } from '@deepseek-ai/cordis'
import * as subprocessProvider from '@deepseek-ai/dsh-subprocess-local'
import * as settingsFileProvider from '@deepseek-ai/dsh-settings-file'
import * as injectorModule from '../lib/index.js'

const settingsPath = new URL('../.tmp/settings.yaml', import.meta.url).pathname
const { mkdirSync, writeFileSync } = await import('node:fs')
const { createRequire } = await import('node:module')

/**
 * Load one DSH provider package: from this checkout's node_modules when it is
 * installed there, else from DSH_MODULES (or the standard global install).
 */
const loadDsh = async (name) => {
  const specifier = `@deepseek-ai/${name}`
  try {
    return await import(specifier)
  } catch {
    const root = process.env.DSH_MODULES
      ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
    return import(`${root}/${name}/lib/index.js`)
  }
}

const systemPromptProvider = await loadDsh('dsh-system-prompt')
const toolsProvider = await loadDsh('dsh-tools')

/* The user's own rule set, written where the provider can watch it. */
mkdirSync(new URL('../.tmp/', import.meta.url).pathname, { recursive: true })
writeFileSync(settingsPath, [
  'env-injector:',
  '  rules:',
  '    - command: ^gh(\\.exe)?$',
  '      envVar: GH_TOKEN',
  '      enabled: true',
  '    - command: ^git(\\.exe)?$',
  '      argsPattern: >-',
  '        ^(?:-[cC]\\s+\\S+\\s+|--\\S+(?:=\\S+)?\\s+)*(?:push|fetch|pull|clone|ls-remote)\\b',
  '      envVar: GH_TOKEN',
  '      enabled: true',
  '',
].join('\n'))

const TOKEN = 'ghp_acceptance0123456789abcdef'
process.env.GH_TOKEN = TOKEN
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

const ctx = new Context()
await ctx.plugin(subprocessProvider.default ?? subprocessProvider, {})
await ctx.plugin(systemPromptProvider.default ?? systemPromptProvider, {})
await ctx.plugin(toolsProvider.default ?? toolsProvider, {})
await ctx.plugin(settingsFileProvider.default ?? settingsFileProvider, { path: settingsPath, watch: true, debounceMs: 50 })
await ctx.plugin(injectorModule.default ?? injectorModule, {})
await new Promise((r) => setTimeout(r, 150))

const run = async (command) => {
  const handle = ctx.subprocess.spawn({
    argv: ['bash', '-c', command], cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: 5000,
  })
  await handle.done
  return `${handle.collected.stdout.readFrom(0).text}${handle.collected.stderr.readFrom(0).text}`
}
const shown = async (command) => {
  const raw = await run(command)
  return raw.trim()
}

/* ── 1. injection: the user's two rules ─────────────────────────────────── */
check('gh rule injects', (await shown('gh --version >/dev/null 2>&1; printf %s "$GH_TOKEN"')) === TOKEN)
check('git push rule injects', (await shown('git push origin main >/dev/null 2>&1; printf %s "$GH_TOKEN"')) === TOKEN)
check('git global flags tolerated', (await shown('git -C /tmp --no-pager fetch >/dev/null 2>&1; printf %s "$GH_TOKEN"')) === TOKEN)
check('git status NOT injected', (await shown('git status >/dev/null 2>&1; printf "[%s]" "$GH_TOKEN"')) === '[]')
check('unrelated command NOT injected', (await shown('printf "[%s]" "$GH_TOKEN"')) === '[]')

/* ── 2. guard A: env readers are refused ────────────────────────────────── */
check('env cannot read it', (await shown('env | grep -c "^GH_TOKEN="')) === '0')
check('a gh spawn piped into env is refused too', (await shown('gh --version >/dev/null 2>&1; env | grep -c "^GH_TOKEN="')) === '0')
check('printenv cannot read it', (await shown('printenv GH_TOKEN | wc -c')) === '0')

/* ── 3. guard B: redaction of a value that really was injected ──────────── */
const leaked = await run('gh --version >/dev/null 2>&1; printf %s "$GH_TOKEN"')
check('the child really holds the token', leaked.trim() === TOKEN)
const exec = { name: 'bash', callId: 'c1', arguments: {}, signal: new AbortController().signal }
const decision = await ctx.tools.postExecute(exec, { content: [{ type: 'text', text: `$ echo $GH_TOKEN\n${leaked}\n` }] })
const modelFacing = (decision.content ?? []).map((b) => b.text ?? '').join('')
check('result redacted', modelFacing.includes('[redacted:GH_TOKEN]'))
check('no plaintext token in result', !modelFacing.includes(TOKEN))
const b64 = Buffer.from(TOKEN, 'utf8').toString('base64')
const d2 = await ctx.tools.postExecute(exec, { content: [{ type: 'text', text: b64 }] })
check('base64 form redacted', !(d2.content ?? []).map((b) => b.text ?? '').join('').includes(b64))
const d3 = await ctx.tools.postExecute(exec, { content: [{ type: 'tool_use', text: TOKEN }] })
check('non-text block untouched', JSON.stringify(d3.content) === JSON.stringify([{ type: 'tool_use', text: TOKEN }]))

/* ── 4. live settings: a rules edit re-applies ─────────────────────────── */
writeFileSync(settingsPath, 'env-injector:\n  rules:\n    - command: "^nfx$"\n      envVar: GH_TOKEN\n      enabled: true\n')
await new Promise((r) => setTimeout(r, 400))
check('live edit: new rule applies', (await shown('nfx >/dev/null 2>&1; printf %s "$GH_TOKEN"')) === TOKEN)
check('live edit: gh no longer injects', (await shown('gh --version >/dev/null 2>&1; printf "[%s]" "$GH_TOKEN"')) === '[]')

await ctx.fiber.dispose()

let failed = 0
for (const { name, ok, detail } of results) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
