# dsh-env-injector

Rule-driven, **per-command** environment injection for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DSH builds every child environment from `scrubbedParentEnv()`, which strips
credential-shaped names (`/KEY|PASSWORD|SECRET|TOKEN/i`) and every `DSH_*` name
before the spawn spec's explicit `env` layer is merged on top. That is the right
default — harness secrets must not leak into children implicitly — but it also
means `gh`, `git` and `npm` never see `GH_TOKEN`/`NODE_AUTH_TOKEN` even when the
harness process itself has them.

This plugin puts back exactly the entries you ask for, exactly where you ask for
them — and **ships no rules of its own**, so an install that configures nothing
injects nothing:

```yaml
# $DSH_HOME/settings.yaml — applies live, no restart
env-injector:
  rules:
    - command: '^gh(\.exe)?$'      # executable name, as a regex
      envVar: GH_TOKEN             # read from process.env, injected into the child
      enabled: true
```

`gh pr list` now runs with `GH_TOKEN` in its environment. `npm install` does
not. Nothing else changes.

## What it guarantees

| Guarantee | How |
|---|---|
| **Only the matching spawn is affected** | The value is written into one *new* spec object (`{ ...spec, env: { ...spec.env, [envVar]: value } }`). `process.env` is never written, so no other command — before, after, or concurrent — sees anything. |
| **The caller's environment survives** | Injection appends to the caller's own `env` map; bash's `NO_COLOR`/`TERM`/`PAGER` overrides and a trusted caller's explicit entries are preserved. |
| **No match ⇒ no change at all** | The original spec *object* is passed through untouched (not a copy), so an unaffected spawn behaves byte-for-byte as it would without the plugin. |
| **Unset variable ⇒ no change** | A rule whose `envVar` is missing (or empty) in `process.env` injects nothing and warns once, naming the variable. |
| **Only the subprocess seam is touched** | One own data property per wrapped method on the service instance, restored on unload: `spawn` always, `spawnTerminal` while `terminal: true`. `resolveExecutable` and the rest of the seam are untouched. |
| **Rules are live** | Editing `$DSH_HOME/settings.yaml` re-compiles the rules for the next spawn — no restart, no reload. |
| **Read commands never receive a value** *(guard)* | A spawn containing `env`, `printenv` or another configured reader is refused wholesale — the caller's original spec object is returned, so nothing was added. Enforced in the injection path; no service required. |
| **Injected values are scrubbed from results** *(guard)* | A `tools/post-execute` listener replaces the value (and its base64/hex forms) with `[redacted:NAME]` in text blocks. Harm reduction, not a guarantee — see the security notes. |

## Install

```bash
# from the plugin checkout (or any path / git spec / tarball pnpm accepts)
dsh plugin --profile web add /path/to/dsh-env-injector

# then restart the harness: the composition gained a bundle layer
```

`dsh plugin` forwards to `pnpm` inside `$DSH_HOME/profiles/web`, then reconciles
`dsh.profile.bundles`: because this package declares
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, it is appended as a
profile layer automatically. Verify with:

```bash
dsh --profile web --dump-config | grep -A 4 'env-injector'
# - id: env-injector
#   name: dsh-env-injector
#   config:
#     rules: []
```

An empty `rules` list is the shipped state: the row is composed, the plugin is
loaded, and it injects nothing until you write rules (see
[Configure](#configure)). Note that this dump shows the **composition** layer
only — your `$DSH_HOME/settings.yaml` rules live in a settings namespace above
it and never appear here.

Remove it with `dsh plugin --profile web remove dsh-env-injector`.

> Verified end-to-end against DSH `0.1.5-rc.1` in a throwaway `$DSH_HOME`: the CLI
> linked the package, appended `dsh-env-injector` to `dsh.profile.bundles`, and
> `--dump-config` composed the row above.

### Restarting, and why the plugin needs one to (dis)appear

A harness **process** loads each profile layer's module once, at boot, and caches
it. So `--dump-config` can prove the row is *composed* while the running process
is still executing the previous version of the package — installing, upgrading,
or removing the plugin therefore takes effect only after the harness restarts:

```bash
# whatever runs the harness for you:
docker compose restart dsh     # container / compose deployment
systemctl restart dsh          # systemd unit
# or: stop the process and start it again the same way you started it
```

Restarting re-reads the profile composition and re-imports every layer, so the
new (or removed) module is what the process actually runs. Nothing else needs a
restart: **rule edits** in `$DSH_HOME/settings.yaml` are applied live by the
settings provider's file watcher, and a `cordis.patch.yml` edit is live where
the profile runs with `patchReload: live`.

To confirm what the running process actually loaded, grep its own output for the
plugin's lines:

```bash
docker compose logs dsh | grep '\[env-injector\]'   # docker / compose
journalctl -u dsh | grep '\[env-injector\]'         # systemd
dsh web 2>&1 | grep '\[env-injector\]'              # foreground: they go to stderr
# or: whatever captures the harness process's stdout/stderr
# [env-injector] settings namespace 'env-injector' attached — 1 rule(s): ^gh(\.exe)?$ → GH_TOKEN
# [env-injector] wrapping ctx.subprocess.spawn/spawnTerminal — 1 rule(s): ^gh(\.exe)?$ → GH_TOKEN (source: settings.yaml over the composition entry)
# [env-injector] guard: reads=deny shells=off redact=on
```

The `wrapping …` line is the authoritative one: it is emitted one tick later,
after the settings layer has attached, so it names the rules really in force and
the layer they came from. `no rules enabled` there means the plugin is loaded
but inert.

Those notices go to **stderr** because cordis' logger is the idiomatic channel
but the shipped composition mounts no logger *exporter* (its default sink is an
in-memory buffer): logger output never reaches the harness process log. Set
`logMatches: true` for one line per spawn (`injected GH_TOKEN for: …`); only
variable names are ever written, never values.

## Configure

### Where rules live: three layers, highest wins

| Layer | File | Applied |
|---|---|---|
| **User** | `$DSH_HOME/settings.yaml` → `env-injector:` section | **live** (file watcher) |
| Composition (per profile) | `$DSH_HOME/profiles/web/cordis.patch.yml` → `- id: env-injector` | live for the web profile (`patchReload: live`), else restart |
| Composition (home-wide) | `$DSH_HOME/cordis.patch.yml` → `- id: env-injector` | live (applied after the profile patch) |
| Schema floor | `src/index.ts` → `rules: []` | always present as the floor |

The settings service resolves **schema defaults → composition entry → user
section**. The schema floor is an **empty rule list**: the plugin defines no
rule of its own, so with nothing configured the wrapper is installed and injects
nothing — every variable that reaches a child was asked for by a rule you wrote.
Writes through `ctx.settings` (and therefore every configuration UI) touch only
the user layer, so deleting the `env-injector:` section resets everything to the
composition entry (and to "inject nothing" on a stock install).

### Editing in the Web UI

`$DSH_HOME/settings.yaml` is the same document the **Models** page writes and
the same one the Settings shell opens: **Settings → General → Open configuration
file** (loopback browsers only) opens it in your native editor. Save, and the
next spawn uses the new rules — the settings provider watches the file with a
100 ms debounce.

The **Settings → Plugins → Plugin configuration** tab renders only namespaces
that ship a browser-side card (`settings.plugin.item`). This plugin is
host-only, so it has no card there; an `env-injector:` section you add by hand
appears in the file and is validated by the plugin's schema on the next read.

### Rule reference

Every field, with its default. There is **no built-in rule**: `rules` starts
empty, so a section (or composition entry) without a `rules:` list injects
nothing.

```yaml
env-injector:
  rules:
    - command: '^gh(\.exe)?$'        # required: regex over the executable's file name
      argsPattern: ''                # optional: regex over the words after it ('' = any)
      envVar: GH_TOKEN               # required: name in process.env AND in the child
      enabled: true                  # optional, default true
      flags: ''                      # optional, default '': RegExp flags for both patterns
  overrideExisting: true             # default true: the harness value wins over spec.env
  terminal: true                     # default true: also cover spawnTerminal (PTY sessions)
  logMatches: false                  # default false: log each match (info) / miss (debug)
  guard:
    reads: true                      # default true: refuse injection into env/printenv-style commands
    shells: off                      # default off: a `bash -c '…'` command line still receives values
    redactOutput: true               # default true: scrub injected values out of tool results
    marker: '[redacted:{name}]'      # default: replacement text, {name} = the variable
    denyCommands: []                 # default []: use the built-in reader list; non-empty REPLACES it
```

`command` and `argsPattern` are **regex source strings**, never `/…/` literals —
a settings section must be losslessly JSON-serializable to persist, compare and
be described to a browser, so the plugin compiles the patterns itself. Use
single quotes in YAML so backslashes stay literal.

`command` is tested against the executable's **file name** first (`/usr/bin/gh`
is tested as `gh`) and against the full word as a fallback, so both `^gh$` and
`^/usr/bin/gh$` work. Patterns are unanchored regexes: `gh` also selects
`gh-tool`; write `^gh$` when you mean exactly that name.

`argsPattern` is tested against the words after the executable, joined by single
spaces, with each command in a shell line matched separately. Lists replace
wholesale (arrays do not merge), so a `rules:` list in `settings.yaml` is the
complete list.

### The read guard: keeping a value out of the model's reach

Injecting a value creates a process that can print it: any child the harness
spawns can run `echo $GH_TOKEN`. Two layers make that harder, and neither is a
sandbox — read the strengths before relying on them.

**Layer A — refuse the read commands (`guard.reads`, default on).** A spawn
whose command line contains a command that exists to read or rewrite the
environment is not injected at all, wherever that command sits: as the command,
as a pipeline stage, or as a wrapper.

```yaml
env-injector:
  guard:
    reads: true
    denyCommands: []        # [] = the built-in list; non-empty REPLACES it
```

Built-in list: `env`, `printenv`, `set`, `export`, `declare`, `typeset`,
`readonly`, `local`, `unset`, `compgen`, and the PowerShell spellings `gci`,
`Get-ChildItem`, `Get-Item`, `gi` (matching is case-insensitive, so Windows'
`SET` is covered too). The refusal withholds **every** matched value from that
spawn, not just the rule that hit a reader — `gh pr list | env` runs both in one
process tree, so a partial refusal would protect nothing. A refusal is logged as
`guard: refused GH_TOKEN (rule 0) for: gh, env`, once per variable and command
line.

**Layer B — scrub the results (`guard.redactOutput`, default on).** Every value
this plugin injected is replaced in tool results by `guard.marker`
(`[redacted:GH_TOKEN]`), in its raw form and in one base64/hex step
(`base64 <<< "$TOKEN"`). Values shorter than 8 bytes are left alone, so a short
variable cannot turn every result into noise. Only text blocks are rewritten —
a JSON result's `value` and non-text blocks are untouched, so nothing downstream
parses differently. Layer B needs the tool registry; without one the plugin says
so at load (`output redaction unavailable (no tools service mounted)`) and layer
A keeps working.

**Layer C — you decide (`guard.shells`).** The harness bash tool always runs the
model's command as `bash -c '<command line>'`. With the default `shells: off`
that command line still receives values, so `bash -c 'git push'` works and
`bash -c 'echo $GH_TOKEN'` also receives the variable — layer B is the only
thing standing between that value and the model. Set `shells: model` to refuse
every caller-composed command line:

```yaml
env-injector:
  guard:
    shells: model           # no shell command line is ever injected
```

With `shells: model`, credential-requiring commands must be spawned by a plugin
(direct `argv`, not through a shell), because the model's own `bash -c 'git
push'` will no longer receive the token. That is the honest trade: `off` is
convenient, `model` is what "the model cannot read it" actually requires.

### Persistent shells and PTY sessions (`minimal` preset)

The `standard` preset runs every bash call in a **fresh shell**, so the rule you
write for a command (`^gh$`) is the rule that fires. The `minimal` preset is
different: `dsh-tool-bash-persistent` feeds each command into **one long-lived
PTY shell** created through `ctx.subprocess.spawnTerminal`, so `gh` is never a
spawn of its own and a `^gh$` rule can never fire.

`terminal: true` (the default) makes the plugin wrap `spawnTerminal` too, so
such a session is covered by a rule on the **shell itself** — the only process
it spawns:

```yaml
env-injector:
  rules:
    # The PTY argv is ['/bin/bash','--noprofile','--norc'], so this fires once,
    # when the session's shell is created.
    - command: '^bash$'
      envVar: GH_TOKEN
      enabled: true
    # A fresh-shell composition still gets the precise, command-scoped rule.
    - command: '^gh(\.exe)?$'
      envVar: GH_TOKEN
      enabled: true
```

Two consequences belong to long-lived shells, not to this plugin:

* the environment is fixed when the shell starts — a rules edit affects the
  **next** session, not the shell already running;
* the variable is visible to **everything** that shell runs, not just `gh`. For
  the narrow scope, use a fresh-shell composition (`standard`), where a
  command-shaped rule is exact.

Set `terminal: false` to leave `spawnTerminal` completely untouched.

### Recipes

```yaml
env-injector:
  rules:
    # GitHub CLI, everywhere it appears.
    - command: '^gh(\.exe)?$'
      envVar: GH_TOKEN
      enabled: true
      flags: ''

    # git remote subcommands only — not `git commit`, not `git status`.
    # Tolerates the global flags that precede a subcommand.
    - command: '^git(\.exe)?$'
      argsPattern: '^(?:-[cC]\s+\S+\s+|--\S+(?:=\S+)?\s+)*(?:push|fetch|pull|clone|ls-remote)\b'
      envVar: GH_TOKEN
      enabled: true
      flags: ''

    # npm/pnpm publishing and private-registry installs.
    - command: '^(npm|pnpm|yarn)$'
      argsPattern: '\b(publish|install|add|ci|view|whoami)\b'
      envVar: NODE_AUTH_TOKEN
      enabled: true
      flags: ''

    # A vendor CLI with a different token, case-insensitive match.
    - command: '^acme$'
      argsPattern: '^(deploy|release)\b'
      envVar: ACME_API_KEY
      enabled: false                 # keep the rule, switch it off
      flags: 'i'
```

## How it works

```
ctx.subprocess.spawn(spec)
        │
        ├─ extractInvocations(spec.argv)      argv → commands
        │     • ['gh','pr','list']                    → gh pr list
        │     • ['bash','-c','gh pr list && git push']→ gh pr list, git push
        │     • ['pwsh','…','-Command','<preamble>gh pr list'] → gh pr list
        │     • ['bwrap','--ro-bind','/',…,'--','bash','-c','gh pr list']
        │                                              → gh pr list   ← the real one
        │     (assignments, sudo/env/nohup/timeout wrappers, quoted words,
        │      pipelines, `;`, nested shells and `--` separators are unwrapped)
        │
        ├─ matchRules(…)                      command regex × argsPattern regex
        │
        ├─ no match, or value unset ⇒ Reflect.apply(original, this, args)
        │                            (the caller's own spec object)
        │
        └─ match ⇒ original.spawn({ ...spec, env: { ...spec.env, [envVar]: value } })
```

**The argv is almost never `['bash','-c',cmd]`.** In a real deployment the shell
executors run inside a sandbox: `dsh-bash-sandbox` asks `ctx.sandbox` to confine
the command, and `dsh-sandbox-local`'s `confine()` returns
`[...runnerArgv, '--', ...argv]` — `bwrap` on Linux, the Landlock launcher as the
fallback, `sandbox-exec` on macOS, the ACL runner on Windows. So what reaches
`spawn` is:

```text
['bwrap','--ro-bind','/','/','--dev','/dev','--unshare-pid','--proc','/proc',
 '--die-with-parent','--tmpfs','/tmp','--bind','<workspace>','<workspace>',
 '--','bash','-c','<the command the user actually asked for>']
```

The matcher therefore does not assume the shell is `argv[0]`: it locates the
**innermost** command flag (`-c`, `-Command`, …), walks back to the shell that
governs it (only further flags may sit in between), and parses that operand —
which is why `pwsh … -NoLogo … -Command <cmd>` and a `sandbox-exec`-wrapped
`bash -c` both resolve to the same inner command. If no shell carries the work,
a `--` separator names the command; otherwise `argv[0]` is the command.

> Earlier versions checked only `argv[0]`, so under any sandbox they saw
> `bwrap`, matched nothing, and failed silently — for **every** rule, in both
> configuration layers. `test/sandbox.test.mjs` now runs the real sandbox
> provider and asserts the wrapped argv shape (`argv[0] !== 'bash'`) before
> asserting injection, so the hole cannot reopen unnoticed.

**Wrapping the service.** `ctx.subprocess` may be cordis' traceable service
proxy, which turns a method read into a fresh per-access proxy and routes a
method *write* onto a throwaway shadow object — an assignment like
`ctx.subprocess.spawn = fn` would silently do nothing. The plugin therefore
unwraps to the service instance (`view[Symbol.for('cordis.original')] ?? view`)
and installs an **own data property** with `Object.defineProperty`. Teardown
first deactivates the wrapper (anything still holding it passes arguments
straight through), then restores the previous descriptor only if the installed
one is still ours, so a wrapper installed later is never clobbered.

**Surviving a provider reload.** `inject = ['subprocess']` is not decoration:
cordis keys a fiber's epoch on the *uids of the fibers providing* its injected
services, so when the subprocess provider is re-provided the plugin is disposed
(restoring the original `spawn`) and re-applied against the new instance.

**Settings without a provider.** The settings integration is optional and lives
inside `ctx.inject(['settings'], …)`. With no settings provider mounted, the
plugin runs from the composition entry alone; if the provider detaches, the
entry becomes authoritative again. A bad regex is refused at *write* time
(`validate`), and an externally edited invalid section keeps the last good rules
instead of silently disabling injection.

**Diagnostics.** Matches, misses and refusals go through the `env-injector`
logger. Only variable *names* are ever logged — never values.

## Compatibility

| DSH version | Behaviour |
|---|---|
| `>= 0.1.5-rc.1` (current) | Uses `ctx.settings.installSection()`: entry as base layer, automatic source attach/detach, `validate` at write time. |
| Older `@deepseek-ai/dsh-settings` | Falls back automatically to `register()` + `watch()` + a disposal effect (see `src/index.ts`). |
| No settings provider | Runs from the composition entry; every rule edit needs a restart (or a live patch edit). The shipped entry has no rules, so you must add them there. |
| No tool registry | The read guard's denial layer is unaffected (it lives in the injection path). Output redaction is unavailable, and the load notice says so. |
| No `ctx.subprocess` (pre-seam DSH) | The plugin simply never activates — `inject: ['subprocess']` is never satisfied, so nothing is patched and nothing fails. |

The fallback path is feature-detected at runtime, not version-sniffed:

```ts
ctx.inject(['settings'], (settingsCtx) => {
  const settings = settingsCtx.settings
  if (typeof settings.installSection === 'function') {
    settings.installSection(ctx, NS, Config, entry, { setSource, onChange: rebuild, validate })
    return
  }
  const scope = settings.register(NS, Config, { base: entry })   // older providers
  source = () => scope.get()
  rebuild()
  const unwatch = scope.watch(rebuild)
  ctx.effect(() => () => { unwatch?.(); source = () => entry; rebuild() })
})
```

### Where the value comes from

`process.env` of the **harness process** — so the token has to be in the
environment DSH itself starts with: a `docker compose` `environment:` entry, a
systemd `Environment=`, or an export before `dsh web`. The plugin deliberately
does not read `$DSH_HOME/.credentials.yaml` or the credentials service; a
credential store reference is not an environment value, and widening the rule
schema to fetch one would make behaviour depend on a second service. Values are
read fresh at every spawn, so rotating the variable needs no reload.

### Making `git push` actually authenticate

`GH_TOKEN` alone does not authenticate HTTPS git — git needs a credential
helper. Install gh as that helper once:

```bash
gh auth setup-git          # writes credential.https://github.com.helper = !gh auth git-credential
```

That helper shells out to `gh`, which now receives `GH_TOKEN` from this plugin,
so `git push` over HTTPS works without an interactive prompt.

## Security notes

* A matched command — and **everything it spawns** — can read the injected
  value. Keep rules narrow; `command: '.*'` forwards the token to every child.
* The value overrides an explicit `spec.env` entry by default
  (`overrideExisting: true`) so a model-supplied `env` cannot spoof the token.
  Set it to `false` to let an explicit caller value win.
* Injection always wins over the harness scrub *by design*: it is the same
  explicit-`env` layer a trusted caller would use. The scrub keeps protecting
  every other variable and every non-matching command.
* **What the read guard does not stop** (the defaults, `reads: true` +
  `shells: off`):
  * `bash -c 'echo $GH_TOKEN'` still receives the variable — the model's shell
    command line is injected like any other, and only output redaction stands
    between that value and the model. Set `guard.shells: model` to refuse it.
  * Redaction matches the value, so a transformation it does not know
    (another encoding, a split, a substring, a character-wise rewrite) passes
    through. It also only sees results the model is shown in text blocks.
  * A command that receives the value can leak it **without printing it**:
    writing it to a file, feeding it to a hook or another program, sending it
    over the network. `git push` runs `.git/hooks/*`, which a model with
    workspace write access can author. No environment-layer guard can see that.
  * This is therefore *harm reduction with a clear audit trail*, not isolation.
    Real isolation is a separate OS user, a container, or a credential proxy —
    out of scope for an environment-injection plugin.
* The practical minimum: narrow rules (`^git(\.exe)?$` with an `argsPattern`,
  not `.*`), `guard.reads: true`, and a harness whose workspace the model cannot
  use to author what an injected command will execute.

## Limitations

* A PTY session (`spawnTerminal`) is one long-lived process, so it can only be
  matched by the shell's own argv and its environment is fixed at creation; the
  `minimal` preset therefore needs a `^bash$`-style rule, and everything that
  shell runs can read the variable. Use a fresh-shell composition for
  command-scoped precision.
* Matching is syntactic over `argv`; a command assembled at runtime
  (`bash -c "$CMD"`, `xargs`) cannot match. Shell and launcher nesting is
  followed up to three levels.
* Bare numeric operands after a wrapper are skipped (`nice -n 5 gh`), but a rule
  is not evaluated against a wrapper's own arguments.
* Rule arrays replace wholesale; there is no per-rule merge or stable rule id.
* The guard's reader list is a heuristic over command names, not a boundary:
  anything that can read the environment (`cat /proc/self/environ`, a language
  runtime's `os.environ`, a script the model writes) is out of its reach. It
  exists to stop the plugin from *handing* a value to an obvious reader.
* Redaction ignores values shorter than 8 bytes, and a value that is a common
  word would be redacted wherever it appears — the guard does not try to be
  clever about either case.

## Development

```bash
pnpm install                    # add --registry=https://registry.npmjs.org/ if your mirror lacks the rc builds
pnpm build                      # tsc → lib/ (committed: the loader imports lib/index.js)
pnpm test                       # 84 tests: matching, injection, guard, redaction, live settings, fallback, packaging
pnpm resolve-rules              # which rules AND which guard are really in force right now
```

| File | Role |
|---|---|
| `src/index.ts` | The whole plugin: schema, rule compilation, argv analysis, spawn wrapper, guard enforcement, redaction listener, settings wiring. |
| `src/tools.ts` | The optional tool-registry seam, declared structurally: this package imports no `@deepseek-ai/dsh-tools` types, so redaction costs consumers no extra peer packages. |
| `lib/index.js` | Built output — what `dsh` actually imports (one runtime import: `@deepseek-ai/schemastery`). |
| `cordis.patch.yml` | The bundle layer: one `insert` row whose composition entry carries an empty `rules:` list (the commented example rules are the documented starting point, not defaults). |
| `scripts/resolve-rules.mjs` | Offline probe: applies defaults → composition entry → `settings.yaml` by hand and prints which rules AND which guard are really in force, since `--dump-config` cannot show the settings layer. |
| `test/match.test.mjs` | Pure matching/injection unit tests, including the pass-through identity guarantee. |
| `test/guard.test.mjs` | The read guard: reader refusal (as command, pipeline stage and wrapper), the `shells` policy, and the redaction contract (raw/base64/hex, short values, non-text blocks). |
| `test/sandbox.test.mjs` | The real sandbox provider + real subprocess provider: asserts the confined argv shape and that injection survives it. |
| `test/e2e.test.mjs` | Real `dsh-subprocess-local` + real `dsh-settings-file`: a real `bash` child prints its own environment, a real `settings.yaml` edit re-rules it live, the guard blocks a real `env` spawn, and the redaction listener scrubs a real injected value. |
| `test/packaging.test.mjs` | The install claims: bundle patch, published paths, profile-shaped resolution and `unwrapExports`. |

## Credits

The spawn-wrapping idiom (unwrapping `cordis.original`, descriptor-level
save/restore, `ctx.effect` teardown) follows
[`dsh-subprocess-inherit-environment`](https://github.com/zhangzujian/dsh-subprocess-inherit-environment);
the rule/settings layering follows the `installSection` pattern used by DSH's own
`dsh-bash-local` and by [`dsh-plugin-proxy`](https://github.com/LucienLL/dsh-plugin-proxy).
