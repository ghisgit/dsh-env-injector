# dsh-env-injector

[English](README.md) | **简体中文**

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的、
**按命令**注入环境变量的规则驱动插件。

DSH 会用 `scrubbedParentEnv()` 构造每个子进程的环境：它会先剥掉形如凭据的变量名
（`/KEY|PASSWORD|SECRET|TOKEN/i`）以及所有 `DSH_*` 名字，再叠加 spawn spec 里显式
声明的 `env` 层。这个默认是对的——harness 的密钥不该隐式泄漏给子进程——但代价是
即使 harness 进程自己有 `GH_TOKEN`/`NODE_AUTH_TOKEN`，`gh`、`git`、`npm` 也永远
看不到它们。

本插件把你要求的那几条变量，精确地放回你要求的位置——并且**自身不带任何内置规则**：
什么都没配置的安装不会注入任何东西。

```yaml
# $DSH_HOME/settings.yaml — 实时生效，无需重启
env-injector:
  rules:
    - command: '^gh(\.exe)?$'      # 可执行文件名，正则
      envVar: GH_TOKEN             # 从 process.env 读取，注入子进程
      enabled: true
```

之后 `gh pr list` 的环境里就有 `GH_TOKEN`，而 `npm install` 没有，其他一切不变。

> 英文版是权威文档（[README.md](README.md)）。本文件与它同步维护；两者若有不一致，
> 以英文版为准。

## 保证什么

| 保证 | 如何做到 |
|---|---|
| **只影响命中的那次 spawn** | 值被写进一个*新的* spec 对象（`{ ...spec, env: { ...spec.env, [envVar]: value } }`）。`process.env` 从不被写入，所以其他命令——之前、之后、并发的——都看不到任何东西。 |
| **调用方自己的环境被保留** | 注入是往调用方已有的 `env` map 上追加；bash 的 `NO_COLOR`/`TERM`/`PAGER` 覆盖项和可信调用方显式给出的条目都不会被顶掉。 |
| **没有命中 ⇒ 完全不改动** | 原 spec *对象*原样透传（不是拷贝），所以未受影响的 spawn 与没装插件时逐字节一致。 |
| **变量未设置 ⇒ 不注入** | 规则里的 `envVar` 在 `process.env` 中缺失（或为空）时不注入任何东西，并只警告一次（点名变量）。 |
| **只碰 subprocess 这一个 seam** | 服务实例上每个被包装的方法只加一个 own data property，卸载时还原：`spawn` 始终包裹，`terminal: true` 时额外包裹 `spawnTerminal`。`resolveExecutable` 及其余 seam 不动。 |
| **规则是实时的** | 编辑 `$DSH_HOME/settings.yaml` 会为下一次 spawn 重新编译规则——不重启、不重载。 |

## 安装

```bash
# 从插件 checkout（或任何 pnpm 能接受的路径 / git spec / tarball）
dsh plugin --profile web add /path/to/dsh-env-injector

# 然后重启 harness：组合里多了一个 bundle 层
```

`dsh plugin` 会在 `$DSH_HOME/profiles/web` 里转发给 `pnpm`，然后协调
`dsh.profile.bundles`：因为本包声明了
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，它会被自动追加为一个
profile 层。验证：

```bash
dsh --profile web --dump-config | grep -A 4 'env-injector'
# - id: env-injector
#   name: dsh-env-injector
#   config:
#     rules: []
```

空的 `rules` 列表就是出厂状态：行已组合、插件已加载，但在你写规则之前不注入任何
东西（见[配置](#配置)）。注意这个 dump 只显示**组合层**——`$DSH_HOME/settings.yaml`
里的规则位于其上的 settings namespace，永远不会出现在这里。

卸载：`dsh plugin --profile web remove dsh-env-injector`。

> 已在一次性 `$DSH_HOME` 中针对 DSH `0.1.5-rc.1` 做过端到端验证：CLI 链接了包、
> 把 `dsh-env-injector` 追加进 `dsh.profile.bundles`，`--dump-config` 组合出了上面
> 那一行。

### 重启：为什么插件必须重启才能出现（或消失）

一个 harness **进程**在启动时会把每个 profile 层的模块 import 一次并缓存。所以
`--dump-config` 能证明那一行已被*组合*，而正在运行的进程可能仍在执行旧版本的包——
安装、升级、卸载插件都只有在 harness 重启后才生效：

```bash
# 用你自己的方式重启 harness：
docker compose restart dsh     # 容器 / compose 部署
systemctl restart dsh          # systemd 单元
# 或者：用你启动它的方式停掉进程再启动
```

重启会重新读取 profile 组合并重新 import 每一层，于是进程真正运行的就是新的（或已
移除的）模块。除此之外都不需要重启：`$DSH_HOME/settings.yaml` 的**规则编辑**由
settings provider 的文件 watcher 实时应用，而 `cordis.patch.yml` 的编辑在
`patchReload: live` 的 profile 下同样实时。

要确认正在运行的进程到底加载了什么，直接 grep 它自己的输出：

```bash
docker compose logs dsh | grep '\[env-injector\]'   # docker / compose
journalctl -u dsh | grep '\[env-injector\]'         # systemd
dsh web 2>&1 | grep '\[env-injector\]'              # 前台运行：它们写到 stderr
# 或者：任何捕获 harness 进程 stdout/stderr 的地方
# [env-injector] settings namespace 'env-injector' attached — 1 rule(s): ^gh(\.exe)?$ → GH_TOKEN
# [env-injector] wrapping ctx.subprocess.spawn/spawnTerminal — 1 rule(s): ^gh(\.exe)?$ → GH_TOKEN (source: settings.yaml over the composition entry)
```

`wrapping …` 那行是权威的。它只在真正会被使用的来源解析完成之后才打印，并且在该来源
之后发生变化时会重新打印。settings namespace 可能在插件被应用后很久才 attach——它
的文档要先被读取，而 settings 服务本身可能由更晚（或更慢）的 bundle 层挂载——所以
插件最多等待三秒，之后才会宣称「组合entry是权威来源」；如果服务已挂载但 namespace
始终不解析，会给出明确警告而不是静默等待。因此那里的 `no rules enabled` 就是字面
意思：任何地方都没有配置规则。完全没有 settings provider 时，会在该窗口之后打印同
样的行，标注 `(source: composition entry only)`。

这些提示走 **stderr**，因为 cordis logger 才是惯用通道，但出厂组合没有挂载任何
logger *exporter*（默认 sink 是内存缓冲）：logger 输出永远到不了 harness 进程日志。
把 `logMatches: true` 打开可以每次 spawn 打一行（`injected GH_TOKEN for: …`）；任何
时候都只写变量**名**，绝不写值。

## 配置

### 规则放在哪：三层，高者胜

| 层 | 文件 | 生效方式 |
|---|---|---|
| **用户层** | `$DSH_HOME/settings.yaml` → `env-injector:` 段 | **实时**（文件 watcher） |
| 组合层（按 profile） | `$DSH_HOME/profiles/web/cordis.patch.yml` → `- id: env-injector` | web profile 下实时（`patchReload: live`），否则需重启 |
| 组合层（home 级） | `$DSH_HOME/cordis.patch.yml` → `- id: env-injector` | 实时（在 profile patch 之后应用） |
| Schema 兜底 | `src/index.ts` → `rules: []` | 始终存在的底 |

settings 服务的解析顺序是 **schema 默认值 → 组合 entry → 用户段**。schema 兜底是
一个**空规则列表**：插件不定义自己的任何规则，所以什么都没配置时包装器已安装但不注入
任何东西——每个到达子进程的变量，都是你写的某条规则要求的。通过 `ctx.settings`（也
就是所有配置界面）写入只会改用户层，所以删掉 `env-injector:` 段会把一切重置回组合
entry（在出厂安装上即「不注入」）。

### 在 Web UI 里编辑

`$DSH_HOME/settings.yaml` 就是 **Models** 页面写入的同一份文档，也是 Settings 外壳
打开的那份：**Settings → General → Open configuration file**（仅限 loopback 浏览器）
会在你的本地编辑器里打开它。保存后，下一次 spawn 就用新规则——settings provider 以
100 ms 防抖监听该文件。

**Settings → Plugins → Plugin configuration** 标签只渲染带浏览器端卡片
（`settings.plugin.item`）的 namespace。本插件是 host-only，在那里没有卡片；你手工
添加的 `env-injector:` 段会出现在文件里，并在下一次读取时由插件 schema 校验。

### 规则参考

每个字段及其默认值。**没有任何内置规则**：`rules` 初始为空，所以没有 `rules:` 列表的
段（或组合 entry）不注入任何东西。

```yaml
env-injector:
  rules:
    - command: '^gh(\.exe)?$'        # 必填：对可执行文件名做匹配的正则
      argsPattern: ''                # 可选：对可执行文件之后的词做匹配（'' = 任意）
      envVar: GH_TOKEN               # 必填：process.env 中的名字，也是子进程中的名字
      enabled: true                  # 可选，默认 true
      flags: ''                      # 可选，默认 ''：两个正则共用的 RegExp flags
  overrideExisting: true             # 默认 true：harness 的值胜过 spec.env
  terminal: true                     # 默认 true：同时覆盖 spawnTerminal（PTY 会话）
  logMatches: false                  # 默认 false：记录每次命中（info）/未命中（debug）
```

`command` 与 `argsPattern` 是**正则源码字符串**，不是 `/…/` 字面量——settings 段必须
可无损 JSON 序列化（才能持久化、比较、描述给浏览器），所以正则由插件自己编译。YAML
里请用单引号，反斜杠才会保持字面。

`command` 先对可执行文件的**文件名**测试（`/usr/bin/gh` 会以 `gh` 参与测试），再以
完整词作为回退，所以 `^gh$` 和 `^/usr/bin/gh$` 都可用。模式是非锚定正则：`gh` 也会
选中 `gh-tool`；要精确匹配就写 `^gh$`。

`argsPattern` 对可执行文件之后的词做测试（以单空格连接），shell 命令行里的每条命令
分别匹配。列表是整体替换（数组不合并），所以 `settings.yaml` 里的 `rules:` 就是完整
列表。

### 持久 shell 与 PTY 会话（`minimal` preset）

`standard` preset 每次 bash 调用都是**新 shell**，所以你为某命令写的规则（`^gh$`）
就是会命中的规则。`minimal` preset 不同：`dsh-tool-bash-persistent` 把每条命令喂进
**一个长期存活的 PTY shell**，该 shell 通过 `ctx.subprocess.spawnTerminal` 创建，
于是 `gh` 从不是独立的 spawn，`^gh$` 规则永远不会命中。

`terminal: true`（默认）让插件同时包装 `spawnTerminal`，因此这类会话由一条针对
**shell 自身**的规则覆盖——它是该会话唯一 spawn 的进程：

```yaml
env-injector:
  rules:
    # PTY 的 argv 是 ['/bin/bash','--noprofile','--norc']，所以这条只在会话创建时命中一次。
    - command: '^bash$'
      envVar: GH_TOKEN
      enabled: true
    # 新 shell 组合仍可用精确的、按命令限定的规则。
    - command: '^gh(\.exe)?$'
      envVar: GH_TOKEN
      enabled: true
```

> **`^bash$` 规则并不覆盖 `bash -c '<命令>'`。** 匹配会**穿过** shell 去看它要跑的
> 命令，这是刻意的：`^gh$` 必须能命中 `bash -c 'gh pr list'`，因为那是 harness bash
> 工具唯一会 spawn 的形状。所以新 shell 组合（`standard` preset）需要为**命令**写规则
> （`^gh$`、`^git$`），而那里的 `^bash$` 规则什么都匹配不到——它在日志里看起来无害，
> 因为插件汇总的是「配置了哪些规则」，而不是「哪些规则触发过」。`^bash$` 只在一种
> 情况下有价值：上面那个 PTY argv，shell 就是全部进程。打开 `logMatches: true` 可以
> 看到规则实际是否触发。

有两条后果属于长期存活的 shell，而不是本插件：

* 环境在 shell 启动时就固定了——规则编辑影响**下一个**会话，不影响已在运行的 shell；
* 变量对那个 shell 运行的**一切**可见，而不只是 `gh`。要窄范围，就用新 shell 组合
  （`standard`），那里按命令形状写的规则是精确的。

设 `terminal: false` 可以完全不动 `spawnTerminal`。

### 配方

```yaml
env-injector:
  rules:
    # GitHub CLI，出现即注入。
    - command: '^gh(\.exe)?$'
      envVar: GH_TOKEN
      enabled: true
      flags: ''

    # 只针对 git 的远程子命令——不是 `git commit`，也不是 `git status`。
    # 容忍子命令之前的全局参数。
    - command: '^git(\.exe)?$'
      argsPattern: '^(?:-[cC]\s+\S+\s+|--\S+(?:=\S+)?\s+)*(?:push|fetch|pull|clone|ls-remote)\b'
      envVar: GH_TOKEN
      enabled: true
      flags: ''

    # npm/pnpm 发布与私有源安装。
    - command: '^(npm|pnpm|yarn)$'
      argsPattern: '\b(publish|install|add|ci|view|whoami)\b'
      envVar: NODE_AUTH_TOKEN
      enabled: true
      flags: ''

    # 某个厂商 CLI，用另一个 token，大小写不敏感匹配。
    - command: '^acme$'
      argsPattern: '^(deploy|release)\b'
      envVar: ACME_API_KEY
      enabled: false                 # 保留规则，先关掉
      flags: 'i'
```

## 工作原理

```
ctx.subprocess.spawn(spec)
        │
        ├─ extractInvocations(spec.argv)      argv → 命令
        │     • ['gh','pr','list']                    → gh pr list
        │     • ['bash','-c','gh pr list && git push']→ gh pr list, git push
        │     • ['pwsh','…','-Command','<preamble>gh pr list'] → gh pr list
        │     • ['bwrap','--ro-bind','/',…,'--','bash','-c','gh pr list']
        │                                              → gh pr list   ← 真正要跑的那个
        │     （赋值前缀、sudo/env/nohup/timeout 包装、引号内的词、
        │       管道、`;`、嵌套 shell 与 `--` 分隔符都会被解开）
        │
        ├─ matchRules(…)                      命令正则 × argsPattern 正则
        │
        ├─ 未命中，或值未设置 ⇒ Reflect.apply(original, this, args)
        │                            （调用方自己的 spec 对象）
        │
        └─ 命中 ⇒ original.spawn({ ...spec, env: { ...spec.env, [envVar]: value } })
```

**argv 几乎从来不是 `['bash','-c',cmd]`。** 真实部署里 shell 执行器跑在沙箱内：
`dsh-bash-sandbox` 让 `ctx.sandbox` 去限制命令，而 `dsh-sandbox-local` 的
`confine()` 返回 `[...runnerArgv, '--', ...argv]`——Linux 上是 `bwrap`，回退是
Landlock launcher，macOS 上是 `sandbox-exec`，Windows 上是 ACL runner。所以真正到达
`spawn` 的是：

```text
['bwrap','--ro-bind','/','/','--dev','/dev','--unshare-pid','--proc','/proc',
 '--die-with-parent','--tmpfs','/tmp','--bind','<workspace>','<workspace>',
 '--','bash','-c','<the command the user actually asked for>']
```

因此匹配器不假设 shell 在 `argv[0]`：它会定位**最内层**的命令标志（`-c`、`-Command`
等），向上回溯到管辖它的那个 shell（中间只允许还有别的标志），并解析该操作数——这就
是为什么 `pwsh … -NoLogo … -Command <cmd>` 和被 `sandbox-exec` 包住的 `bash -c` 都
能解析出同一条内部命令。如果没有 shell 承载工作，`--` 分隔符会指明命令；否则
`argv[0]` 就是命令。

> 早期版本只检查 `argv[0]`，于是在任何沙箱下都只看到 `bwrap`、什么都匹配不到、并且
> **静默失败**——对**每一条**规则、在两个配置层都是如此。现在
> `test/sandbox.test.mjs` 会跑真实沙箱 provider，先断言被包装后的 argv 形状
> （`argv[0] !== 'bash'`），再断言注入，所以这个洞不会再悄悄打开。

**包装服务。** `ctx.subprocess` 可能是 cordis 的可追踪服务代理：它把一次方法读取变成
一个新的按访问代理，并把方法*写入*路由到一个一次性影子对象上——所以
`ctx.subprocess.spawn = fn` 这样的赋值会静默失效。因此插件先解包到服务实例
（`view[Symbol.for('cordis.original')] ?? view`），再用 `Object.defineProperty` 安装
一个 **own data property**。拆除时先停用包装器（仍持有它的引用会直通传参），然后只在
已安装的描述符仍是我们的时还原上一个描述符，所以后来安装的包装器永远不会被覆盖。

**熬过 provider 重载。** `inject = ['subprocess']` 不是装饰：cordis 用「提供该服务的
fiber 的 uid」来标记 fiber 的 epoch，所以当 `ctx.subprocess` 被重新提供时，插件会被
销毁（还原原始 `spawn`）并针对新实例重新应用。

**没有 provider 时的 settings。** settings 集成是可选的，位于
`ctx.inject(['settings'], …)` 内。没有挂载 settings provider 时，插件只靠组合 entry
运行；provider 分离时，entry 重新成为权威。坏正则在*写入*时就被拒绝（`validate`），
而外部编辑进来的非法段会保留上一份好规则，而不是悄悄关掉注入。

**诊断。** 命中、未命中与拒绝都走 `env-injector` logger。只记录变量*名*——绝不记录值。

## 兼容性

| DSH 版本 | 行为 |
|---|---|
| `>= 0.1.5-rc.1`（当前） | 使用 `ctx.settings.installSection()`：entry 作为 base 层，自动 attach/detach 来源，写入时 `validate`。 |
| 更旧的 `@deepseek-ai/dsh-settings` | 自动回退到 `register()` + `watch()` + 一个销毁 effect（见 `src/index.ts`）。 |
| 没有 settings provider | 从组合 entry 运行；每次规则编辑都需要重启（或改 patch 实时生效）。出厂的 entry 没有规则，所以你必须在那里添加。 |
| 没有 `ctx.subprocess`（早期无此 seam 的 DSH） | 插件完全不激活——`inject: ['subprocess']` 永不满足，所以什么都不打补丁、也不会失败。 |

回退路径是运行时特性探测，而不是嗅探版本号：

```ts
ctx.inject(['settings'], (settingsCtx) => {
  const settings = settingsCtx.settings
  if (typeof settings.installSection === 'function') {
    settings.installSection(ctx, NS, Config, entry, { setSource, onChange: rebuild, validate })
    return
  }
  const scope = settings.register(NS, Config, { base: entry })   // 更旧的 provider
  source = () => scope.get()
  rebuild()
  const unwatch = scope.watch(rebuild)
  ctx.effect(() => () => { unwatch?.(); source = () => entry; rebuild() })
})
```

### 值从哪来

来自**harness 进程**的 `process.env`——所以 token 必须在 DSH 启动时的环境里：一条
`docker compose` 的 `environment:`、一条 systemd `Environment=`，或者在 `dsh web` 前
export。插件刻意不读 `$DSH_HOME/.credentials.yaml`，也不用 credentials 服务：凭据存储
的引用不是环境变量的值，为取它而扩宽规则 schema 会让行为依赖第二个服务。值在每次
spawn 时现读，所以轮换变量无需重载。

### 让 `git push` 真的能认证

只有 `GH_TOKEN` 并不能让 HTTPS git 认证——git 需要一个凭据 helper。把 gh 装成该
helper（一次即可）：

```bash
gh auth setup-git          # 写入 credential.https://github.com.helper = !gh auth git-credential
```

该 helper 会调用 `gh`，而 `gh` 现在能从本插件拿到 `GH_TOKEN`，于是 HTTPS 的
`git push` 无需交互式提示即可工作。

## 安全说明

### 插件绝不会做的事

* **值永不进日志。** 每条提示只写变量名、规则下标和命令行，绝不写内容。
  `logMatches` 写的是 `injected GH_TOKEN for: …`，不是 token。
* **`process.env` 从不被写入**，注入的条目只活在一次 spawn 的那一个 spec 对象里。
* **默认 `overrideExisting: true`**，模型提供的 `env` 无法伪造成 harness 拥有的变量。
  设为 `false` 可让显式的调用方值胜出。
* **注入按设计胜过 harness 的清洗**：它就是可信调用方会使用的那层显式 `env`。清洗继续
  保护其他所有变量和所有未命中的命令。

### 注入**不能**给你什么保护

本插件没有读防护：它承诺的是*送达*，不是*围堵*。注入出去的值，就是子进程手里的值。

* 命中的命令——**以及它派生的一切**——都能读到注入值。`env`、`printenv`、
  `bash -c 'echo $GH_TOKEN'` 与别的命令一样会拿到它，而结果返回模型之前没有任何环节会
  改写它，所以对变量的一次 echo 就是一次泄漏。
* 拿到值的命令可以**不打印**就泄漏：写进文件、喂给 hook 或另一个程序、通过网络发出。
  `git push` 会执行 `.git/hooks/*`，而拥有 workspace 写权限的模型可以自己写一个。
  任何环境变量层的防护都看不到这些。
* 长期会话是暴露面最大的一种：PTY（`spawnTerminal`）在整个会话存活期间都持有该变量，
  后台 job 则在 job 存活期间持有。
* 运行时拼出来的命令行（`bash -c "$CMD"`）照样会被匹配——shell 无论如何都会被解开——
  但这也意味着决定「拿这个变量跑什么」的是*调用方*的命令行，而不是你写的规则。

### 实践中的最小面

规则要窄：`^git(\.exe)?$` 配 `argsPattern`，而不是 `.*`，这样 `git status` 永远不会带上
token。优先使用短时效、低权限的凭据（细粒度 token 而不是经典 token）。当 token 必须
完全不可读时，不要把它作为环境变量交出去——用 credential helper、agent socket 或把密钥
留在子进程之外的代理。

## 限制

* PTY 会话（`spawnTerminal`）是一个长期存活的进程，所以只能由 shell 自己的 argv 命中，
  且其环境在创建时固定；`minimal` preset 因此需要 `^bash$` 这类规则，而那个 shell 跑的
  一切都能读到该变量。要按命令限定精度，请用新 shell 组合。
* 匹配是对 `argv` 的语法匹配；运行时拼出来的命令（`bash -c "$CMD"`、`xargs`）无法命中。
  shell 与 launcher 嵌套最多向下跟随三层。
* 包装命令之后的裸数字操作数会被跳过（`nice -n 5 gh`），但规则不会针对包装命令自身的
  参数求值。
* 规则数组是整体替换；没有按规则合并，也没有稳定的规则 id。
* 规则正则是在编译配置时校验的，不是由 schema 校验，所以 `settings.yaml` 里的坏模式会在
  读取时被拒绝、上一份规则继续生效——该 spawn 保持旧行为，而不是静默失去注入。

## 开发

```bash
pnpm install                    # 如果你的镜像缺 rc 构建，加 --registry=https://registry.npmjs.org/
pnpm build                      # tsc → lib/（已提交：loader 导入的是 lib/index.js）
pnpm test                       # 60 个测试：匹配、注入、实时 settings、旧 provider 回退、打包
pnpm resolve-rules              # 当前真正生效的规则
pnpm acceptance                 # 真实 seam：真实子进程、真实 settings.yaml
```

| 文件 | 作用 |
|---|---|
| `src/index.ts` | 整个插件：schema、规则编译、argv 分析、spawn 包装、settings 接线。 |
| `lib/index.js` | 构建产物——`dsh` 实际导入的东西（唯一的运行时 import：`@deepseek-ai/schemastery`）。 |
| `cordis.patch.yml` | bundle 层：一个 `insert` 行，其组合 entry 携带空的 `rules:` 列表（注释里的示例规则是文档化的起点，不是默认值）。 |
| `scripts/resolve-rules.mjs` | 离线探针：手工叠加 defaults → composition entry → `settings.yaml`，打印真正生效的规则，因为 `--dump-config` 看不到 settings 层。 |
| `scripts/acceptance.mjs` | 单测做不到、因为它需要部署真实包的检查：真实子进程通过真实 `ctx.subprocess` 服务拿到真实 token，`settings.yaml` 编辑实时改写规则。已针对 DSH `0.1.5-rc.1` 验证。 |
| `test/match.test.mjs` | 纯匹配/注入单测，含「直通即原对象」的同一性保证。 |
| `test/sandbox.test.mjs` | 真实沙箱 provider + 真实 subprocess provider：断言受限 argv 形状，以及注入能穿过它。 |
| `test/e2e.test.mjs` | 真实 `dsh-subprocess-local` + 真实 `dsh-settings-file`：真实 `bash` 子进程打印自己的环境、真实 `settings.yaml` 编辑实时改写规则，旧 provider 回退在真实服务上（去掉 `installSection`）跑通。 |
| `test/packaging.test.mjs` | 安装相关的声明：bundle patch、发布路径、profile 形状的解析与 `unwrapExports`。 |

## 致谢

spawn 包装手法（解包 `cordis.original`、描述符级保存/还原、`ctx.effect` 拆除）沿用了
[`dsh-subprocess-inherit-environment`](https://github.com/zhangzujian/dsh-subprocess-inherit-environment)；
规则/settings 分层沿用了 DSH 自身使用的 `installSection` 模式。
