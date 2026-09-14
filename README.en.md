# dsh-env-injector

**English** | [简体中文](README.md)

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

> The repository's default README is the Chinese one ([README.md](README.md)).
> This file is its English counterpart and the reference text when the two
> disagree.

## What it guarantees

| Guarantee | How |
|---|---|
| **Only the matching spawn is affected** | The value is written into one *new* spec object (`{ ...spec, env: { ...spec.env, [envVar]: value } }`). `process.env` is never written, so no other command — before, after, or concurrent — sees anything. |
| **The caller's environment survives** | Injection appends to the caller's own `env` map; bash's `NO_COLOR`/`TERM`/`PAGER` overrides and a trusted caller's explicit entries are preserved. |
| **No match ⇒ no change at all** | The original spec *object* is passed through untouched (not a copy), so an unaffected spawn behaves byte-for-byte as it would without the plugin. |
| **Unset variable ⇒ no change** | A rule whose `envVar` is missing (or empty) in `process.env` injects nothing and warns once, naming the variable. |
| **Only the subprocess seam is touched** | One own data property per wrapped method on the service instance, restored on unload: `spawn` always, `spawnTerminal` while `terminal: true`. `resolveExecutable` and the rest of the seam are untouched. |
| **Rules are live** | Editing `$DSH_HOME/settings.yaml` re-compiles the rules for the next spawn — no restart, no reload. |

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
```

The `wrapping …` line is the authoritative one. It is reported only once the
source that will actually be used has resolved, and it is re-reported if that
source changes afterwards. The settings namespace can attach well after the
plugin is applied — its document is read first, and the service itself may be
mounted by a later or slower bundle layer — so the plugin waits up to three
seconds before naming the composition entry as authoritative, and a service
that mounts but never resolves its namespace gets a warning instead of a silent
wait. `no rules enabled` there therefore means what it says: nothing is
configured anywhere. A load with no settings provider prints the same line after
that window, with `(source: composition entry only)`.

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

**Settings → Plugins → Plugin configuration** carries an **Environment
injection** card: the rule list, `overrideExisting`, `terminal` and
`logMatches`, each marked with whether the user layer carries it. The card ships
in this package's browser half (`dsh.client` → `lib/client.js`), because the tab
dispatches `settings.plugin.item` by settings namespace and renders only the
namespaces whose owner registered a card under that key.

The card stages what you type and writes on **Save**; **Discard** drops the
drafts, and **Reset** on a field stages a clear so the field follows the
deployment's composition entry again. A save writes one atomic mutation
covering only the fields you touched, so a concurrent edit to a field the card
never touched survives. A rule that cannot compile — an invalid regex or flag
set, an empty `command` or `envVar` — is reported under the field that carries
it and blocks the save instead of spending a refused round trip.

`$DSH_HOME/settings.yaml` is the same document the **Models** page writes and
the same one the Settings shell opens: **Settings → General → Open configuration
file** (loopback browsers only) opens it in your native editor. Save, and the
next spawn uses the new rules — the settings provider watches the file with a
100 ms debounce.

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

> **A `^bash$` rule does NOT cover `bash -c '<command>'`.** Matching looks
> *through* a shell to the commands it runs, on purpose: `^gh$` has to match
> `bash -c 'gh pr list'`, which is the only shape the harness bash tool ever
> spawns. So a fresh-shell composition (`standard` preset) needs rules for the
> **commands** (`^gh$`, `^git$`), and a `^bash$` rule there matches nothing at
> all — it looks harmless in the log, because the plugin summarises whatever
> rules are configured, not which ones have fired. `^bash$` earns its place in
> exactly one case: the PTY argv above, where the shell is the whole process.
> Set `logMatches: true` to see which rules actually fire.

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
| No `ctx.subprocess` (pre-seam DSH) | The plugin simply never activates — `inject: ['subprocess']` is never satisfied, so nothing is patched and nothing fails. |
| Web composition without the settings surface | The host half runs unchanged; the card never mounts, because the browser half waits for the `slots`, `locale` and `settingsScope` services. The namespace still appears in `settings.yaml` and is validated the same way. |

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

### What the plugin never does

* **No value is ever logged.** Every notice names variables, rules and command
  lines — never their contents. `logMatches` writes `injected GH_TOKEN for: …`,
  not the token.
* **`process.env` is never written**, and the injected entry lives in one spec
  object for one spawn.
* **`overrideExisting: true` by default**, so a model-supplied `env` cannot
  spoof a var the harness owns. Set it to `false` to let an explicit caller
  value win.
* **Injection wins over the harness scrub by design**: it is the same
  explicit-`env` layer a trusted caller would use. The scrub keeps protecting
  every other variable and every non-matching command.

### What injection does NOT protect you from

There is no read guard in this plugin: the promise is *delivery*, not
*containment*. A value that is injected is a value a child process holds.

* A matched command — and **everything it spawns** — can read the injected
  value. `env`, `printenv` and `bash -c 'echo $GH_TOKEN'` receive it like any
  other command, and nothing rewrites a tool result on the way back to the
  model, so a single echo of the variable is a single disclosure.
* A command that receives the value can leak it **without printing it**: writing
  it to a file, feeding it to a hook or another program, sending it over the
  network. `git push` runs `.git/hooks/*`, which a model with workspace write
  access can author. No environment-layer defence can see that.
* Long-lived sessions are the widest case: a PTY (`spawnTerminal`) holds the
  variable for the life of the session, and a background job keeps it for the
  life of the job.
* A command line assembled at runtime (`bash -c "$CMD"`) is matched — the shell
  is unwrapped either way — but that also means the *caller's* command line, not
  yours, decides what runs with the variable.

### The practical minimum

Narrow rules: `^git(\.exe)?$` with an `argsPattern` rather than `.*`, so
`git status` never carries a token. Prefer short-lived, low-privilege
credentials (a fine-grained token rather than a classic one). And when the token
must not be readable at all, do not hand it over as an environment variable —
use a credential helper, an agent socket or a proxy that keeps the secret
outside the child.

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
* Rule regexes are validated when the config is compiled, not by the schema, so
  a bad pattern in `settings.yaml` is refused at read time and the previous
  rules stay in force — the spawn keeps its old behaviour rather than losing
  injection silently.

## Development

```bash
pnpm install                    # add --registry=https://registry.npmjs.org/ if your mirror lacks the rc builds
pnpm build                      # tsc → lib/, then esbuild → lib/client.js (both committed)
pnpm typecheck                  # the host config and the browser half's own config
pnpm test                       # 79 tests: matching, injection, live settings, browser card, packaging
pnpm resolve-rules              # which rules are really in force right now
pnpm acceptance                 # the real seams: a real child process, a real settings.yaml
```

| File | Role |
|---|---|
| `src/index.ts` | The whole plugin: schema, rule compilation, argv analysis, spawn wrapper, settings wiring. |
| `src/client/index.tsx` | The browser half's entry: registers the card's dictionaries, binds the `env-injector` settings scope, and contributes the card to `settings.plugin.item`. |
| `src/client/card.tsx`, `src/client/controller.ts` | The card and its form model: staged drafts, per-field overridden state, one atomic save of the touched fields. |
| `src/client/contracts.ts` | The client's mirror of the section plus the pure checks that decide whether a draft could be written (deliberately shared with the card, not with the host's own compiler). |
| `lib/index.js` | Built output — what `dsh` actually imports (one runtime import: `@deepseek-ai/schemastery`). |
| `lib/client.js` | Built output — the browser bundle the client module system serves. Its header carries a digest of `src/client/**`; the test suite fails if the two drift. |
| `cordis.patch.yml` | The bundle layer: one `insert` row whose composition entry carries an empty `rules:` list (the commented example rules are the documented starting point, not defaults). |
| `scripts/build-client.mjs` | The browser-half build: esbuild bundle → the lazy-CJS factory the module system loads, refusing any module the client baseline does not seed. |
| `scripts/client-baseline.mjs` | The platform module table a browser half may resolve against, shared by the build and the tests. |
| `scripts/resolve-rules.mjs` | Offline probe: applies defaults → composition entry → `settings.yaml` by hand and prints which rules are really in force, since `--dump-config` cannot show the settings layer. |
| `scripts/acceptance.mjs` | The checks the unit suite cannot make because they need a deployment's real packages: a real child process receives a real token through the real `ctx.subprocess` service, and a `settings.yaml` edit re-rules it live. Verified against DSH `0.1.5-rc.1`. |
| `test/match.test.mjs` | Pure matching/injection unit tests, including the pass-through identity guarantee. |
| `test/sandbox.test.mjs` | The real sandbox provider + real subprocess provider: asserts the confined argv shape and that injection survives it. |
| `test/e2e.test.mjs` | Real `dsh-subprocess-local` + real `dsh-settings-file`: a real `bash` child prints its own environment, a real `settings.yaml` edit re-rules it live, the describe wire is checked for what a card renders, and the older-provider fallback runs with `installSection` removed from the real service. |
| `test/client.test.mjs` | The browser half against the shipped bundle: the loader contract, the card registration, the staged-save form model, and the card's DOM behavior in jsdom with real React. |
| `test/packaging.test.mjs` | The install claims: bundle patch, `dsh.client` declaration, published paths, profile-shaped resolution and `unwrapExports`. |

## Credits

The spawn-wrapping idiom (unwrapping `cordis.original`, descriptor-level
save/restore, `ctx.effect` teardown) follows
[`dsh-subprocess-inherit-environment`](https://github.com/zhangzujian/dsh-subprocess-inherit-environment);
the rule/settings layering follows the `installSection` pattern used by DSH's own
`dsh-bash-local` and by [`dsh-plugin-proxy`](https://github.com/LucienLL/dsh-plugin-proxy).
