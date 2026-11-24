---
description: "把钉钉插件加入 profile：官方 dws 及其技能，以及插件页上的钉钉登录。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-dingtalk

[English](README.md) | 中文

## 概述

钉钉插件让对话通过钉钉官方 CLI（DingTalk Workspace CLI，命令 `dws`）使用钉钉。它从一个固定版本的 release 下载这个 CLI 和钉钉官方技能到 DSH 缓存目录，在运行时上下文中把 `dws` 的绝对路径告诉模型，并注册一个 `dingtalk` skill 为这些技能建立索引。它把账号注册到 [连接器账号注册表](../../client/ui-connector-account/README.zh.md)，其插件页区块负责检查登录、通过浏览器登录、退出登录和取消操作。CLI 把登录保存在 `~/.dws` 和系统钥匙串中，与用户自己的终端共用。仅支持 macOS 和 Windows x64。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

在 Web 侧边栏的**插件**页面安装，或使用 CLI：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-dingtalk
dsh plugin --profile web remove @deepseek-ai/dsh-dingtalk
```

本包没有需要批准的安装脚本。`dingtalk` 行加载时，会下载 dws release 1.0.64 的两个资产：当前平台的归档（16 到 20 MB）和 `dws-skills.zip`（3.3 MB）。每个资产都先从 GitHub Releases 下载，GitHub 失败或在 `releaseTimeoutMs` 内没有送达时改用官方 Gitee 镜像；该行校验大小和 SHA-256 后，保存在它的缓存目录中：由 `dsh` 启动的 profile 中是 `$DSH_HOME/cache/dingtalk/<profile>/`，其他情况是 `$DSH_HOME/cache/dingtalk/`。它的 release 第一次在 profile 的目录中就位时（加载时已在位，或下载完成后），该行删除一次其中的其他 release，因此插件更新换了固定的 release 之后只留下一份；release 没有变化时不会重新下载。下载完成之前，运行时上下文不给出 `dws` 的路径，技能目录中也没有 `dingtalk` skill。当前平台没有对应的归档时，该行加载失败并给出平台；如需使用其他 `dws`，请设置 `binDir`。同时设置 `binDir` 和 `skillsDir` 时，该行不下载任何内容。

登录需要一个已加入组织的钉钉账号，并且组织管理员已在钉钉开发者后台开启 CLI 访问。未开启时，用户可以在授权页申请。

### 你会得到

下载完成后，技能目录中会多一个 `dingtalk` skill。Agent 用 `skill` 工具加载它，用文件工具打开当前产品对应的子指南（例如 `dingtalk-calendar` 或 `dingtalk-doc`），并在当前沙箱和审批策略下通过普通 Shell 工具按路径运行 `dws`；运行子指南脚本的命令会把 `dws` 所在目录放到 PATH 最前面。Agent 用 `dws auth status --readonly --format json` 检查登录状态，这项检查不写 `~/.dws`，在文件沙箱下也能报告真实状态。检查或命令报告未登录、登录过期时，Agent 会请用户在插件页面连接钉钉；只有用户要求在对话中完成时，它才运行 `dws auth login --no-browser`，并且因为该命令会写入工作区之外，第一次尝试就带 `justification` 申请 `sandbox_permissions`。命令因为文件沙箱拒绝写入 `~/.dws` 而失败时，不算登录失效，Agent 会带 `sandbox_permissions` 和 `justification` 重跑同一条命令。

在 Plugin Manager 中关闭插件会撤下这个 skill、运行时上下文中的路径和账号区块。CLI 的登录和已下载的资产会保留。

<a id="account-operations"></a>
### 账号操作

插件页通过 连接器账号注册表发起这些操作，注册表由 Web 应用加载；headless profile 加载插件时没有它。Host 同一时间最多执行一个操作并持有它，因此离开页面不会取消它。该行加载时会启动一次检查，dws 或其技能缺失时这次检查也会下载。

| 操作 | 效果 |
|---|---|
| `check` | dws 或其技能缺失时先下载，再重新检查账号；没有操作运行时，每个打开 Web 应用的浏览器会触发一次 |
| `sign-in` | 运行 `auth login --no-browser --format json`，等待用户在这台电脑的浏览器中授权，然后检查 dws 是否报告该账号已登录。已连接的区块以“登录其他组织”再次提供它：dws 按组织和用户各保存一个账号，用另一个账号授权会新增该账号，用当前账号授权只刷新它；随后的检查显示 dws 报告为当前的账号 |
| `sign-out` | 用户确认后，对最近一次检查发现的账号运行 `auth logout --profile <corpId>:<userId>`，这也会让用户自己的终端退出该账号，然后重新检查 |
| 取消 | 在登录等待授权时取消它，或在检查下载时取消下载，并等待命令或下载停止；其他步骤会被忽略 |

检查运行 `auth status --format json`，它会向服务端刷新已过期的访问令牌，无论是否有用户登录，退出码都是 0。`authenticated` 为 true 时，账号为 `connected`，并带上 dws 报告的用户名和组织名；为 false 且原因属于 dws 报告为无法判断的几种（`local_state_requires_repair`、`local_state_unreadable`、`ciphertext_key_mismatch`、`dek_missing`、`keychain_unavailable`）时为 `unverified`；其余为 `signed-out`。退出码非零，或输出不是状态 JSON，会使检查失败并保留之前的账号状态，只是下载就位之后 `not-installed` 会换成 `unchecked`；下载没有完成时为 `not-installed`。退出登录要求两个 id 都存在，因此不会选中一个组织的全部账号；其他组织的账号保持登录，下一次检查显示 dws 届时报告的当前账号。`auth login` 在 stderr 中单独一行、带缩进打印的链接，只有是 `login.dingtalk.com` 上的 HTTPS 地址时才会提供。结果分为成功、已取消和失败。失败时，页面和 Host 日志显示命令和观察到的退出码；CLI 的输出会被省略。运行 DSH 的进程需要能访问 `~/.dws` 和该 CLI 的 macOS 钥匙串项；`DSH_HOME` 不会改变它们的位置。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | 保存已下载可执行文件的缓存目录 | 包含可执行 `dws`（Windows 上为 `dws.exe`）的绝对目录；设置后不下载可执行文件 |
| `skillsDir` | 保存已下载技能的缓存目录 | 布局与 release 的 `dws-skills.zip` 中 `multi/` 目录相同的目录；设置后不下载技能 |
| `releaseUrls` | `DingTalk-Real-AI/dingtalk-workspace-cli` 在 GitHub Releases 和 Gitee 镜像的下载前缀 | 按顺序尝试的 HTTPS 前缀，用于下载 `binDir` 和 `skillsDir` 未提供的内容；每个都在 `v<版本>/<资产名>` 下提供资产，且 `Content-Length` 等于资产大小。前缀带有查询、片段或凭据，或者无法解析为 URL 时，加载失败 |
| `releaseTimeoutMs` | `300000` | 一个前缀送达一个资产的时限，整数毫秒；超时后尝试下一个 |

账号检查和退出登录使用 [`cli-account` 行](../cli-account/README.zh.md#use-this-package)的 `commandTimeoutMs`，默认 30 秒。登录最多等待用户 10 分钟，每条命令最多保留 1 MiB stdout；这两个上限由 CLI 账号 Service 固定。dws 自身在 6 分钟后停止等待授权。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-dingtalk)是支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 profile 其他层之后把本包作为 `dingtalk` 行插入，插件页以本包名作为账号区块的 key。[`src/index.ts`](src/index.ts) 是一个函数插件。它把 `dws` 的路径和账号注册到 `ctx.cliAccounts`，把安装这个 release 声明为这次注册的 [`prepare` 步骤](../cli-account/README.zh.md#prepare-before-a-check)，在 `src/release.ts` 发布的 skill 根目录上挂载一个名为 `dingtalk` 的[文件系统 skill 提供方](../../skill/skill-filesystem/README.zh.md)，并启动一次检查，使没有浏览器的会话也能找到 `dws` 和该 skill。该提供方不包含默认根目录，并监听 skill 根目录，因为第一次下载发布它时，目录可能已经列出过。本包不使用 npm 包 `dingtalk-workspace-cli`：它的安装脚本会把官方技能复制到默认 skill 提供方扫描的 `~/.agents/skills`，以及其他 Agent 的 skill 目录，插件撤下后它们仍会留下。dws 内嵌了同样的技能，但 `dws skill setup` 只写入这类 Agent 目录。

[`src/release.ts`](src/release.ts) 固定发布版本、各平台的归档和 `dws-skills.zip`，每项都记录 release 的 `checksums.txt` 中的名称、大小和 SHA-256。它只下载缺少的资产；响应的 `Content-Length` 不符时，在读取正文之前就拒绝，随后校验摘要。它用 `tar` 解压 `.tar.gz` 平台归档，用 `fflate` 只取出 Windows `.zip` 归档根目录下的 `dws.exe`，并用 `fflate` 解压技能归档中 `multi/` 下的条目及根目录的 `LICENSE`、`NOTICE`，都解压到同级的临时目录；技能条目的路径含空段、`.`、`..` 或反斜杠时拒绝。解压结果通过改名发布，另一个进程先发布的目录会被保留。失败或在 `releaseTimeoutMs` 内没有送达的下载源各记录一条警告；取消操作会停止下载。安装因为取消之外的原因失败时，例如归档无法解压或缓存目录无法写入，会记录一条带原因的警告，因为账号操作只报告下载没有完成。缓存目录中的 skill 根目录 `skill-<摘要>/` 包含包内总入口在 `dingtalk/SKILL.md` 的副本，以及指向技能目录的符号链接 `dingtalk/guides`；在 Windows 上它是目录联接（junction），不需要创建符号链接的权限。摘要覆盖总入口和链接目标，因此已发布的根目录不会再变；加载时技能目录已经存在，就同步发布根目录。一个 profile 的缓存目录只由这个 profile 的各个进程读取。release 第一次在其中就位时（加载时已在位，或安装完成后），`prune` 删除其中这个 release 不使用的所有 `dws-…` 和 `skill-…` 条目，包括被配置的 `binDir` 取代的已下载 dws；该行每次加载只删除一次。release 尚未安装时它什么也不删；删不掉的条目（例如 Windows 上仍在运行的 `dws.exe`）记为警告，留到之后的加载时再删。由于只删除一次，某个进程的 release 被同一 profile 的另一个进程删除后，它在下一次检查时重新安装，并保留那个进程的 release；这种情况见[已知限制](#known-limitations-and-deferred-work)。不是由 `dsh` 启动的组合没有 profile；它的缓存目录可能被多个安装共用，其中的内容都不会被删除。

`dws` 和技能都已安装时，[CLI 账号 Service](../cli-account/README.zh.md) 在运行时上下文中把这个路径告诉模型；任一项缺失时，它在检查的第一条命令之前运行 `prepare` 步骤；它按同一路径运行每条命令，一次执行一个账号操作，并以退出码报告失败的命令。[`src/account.ts`](src/account.ts) 用 dws 的命令完成每个操作，从 `auth login` 的 stderr 行中读取授权链接，并解析 `auth status` 的 JSON。[`src/presentation.ts`](src/presentation.ts) 用 [`src/locales.ts`](src/locales.ts) 中的文案，把每个视图映射为注册表提供的区块。它把已登录账号的 id 留在 Host 上供退出登录使用；Remote 视图只包含名字。释放时取消进行中的操作，中止正在运行的命令和下载，并在这些进程退出后完成。

[`skills/dingtalk/SKILL.md`](skills/dingtalk/SKILL.md) 是唯一的 skill：DSH 指引、16 个子指南的索引，以及打开方式。子指南是 release `v1.0.64` 的 `dws-skills.zip` 中的 `multi/` 目录树，上游安装程序默认使用它；另一种 `mono/` 是重复同样内容的单一入口。文件系统提供方只发现 `<root>/<name>/SKILL.md`，因此子指南不是独立的 skill。子指南之间用 `../dingtalk-shared/SKILL.md` 这样的相对路径互相引用，由于子指南保持同级布局，这些路径可以解析；它们的辅助脚本也从各自的 `scripts/` 目录运行。DSH 指引与子指南不一致时，总入口要求 Agent 以 DSH 指引为准：使用插件提供的 `dws`，不另装或升级，不运行 `dws skill setup`，并把登录交给插件页面。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md) — 本应用插件所属的分组。
- [CLI 账号 Service](../cli-account/README.zh.md) — CLI 应用插件共用的命令执行、CLI 路径上下文与账号操作。
- [Skills](../../../docs/subsystems/skills.zh.md) — 目录发布、加载与优先级。
- [连接器账号界面](../../client/ui-connector-account/README.zh.md) — 发起账号操作的注册表和插件页区块。

-----

<a id="model-experience"></a>
## 模型体验

### 技能目录条目

#### 模型看到的内容

技能目录列出一个 `dingtalk` skill。它的中文描述列出所覆盖的钉钉产品，并要求 Agent 在用户提到钉钉或这些产品、或给出钉钉链接时先加载它，再按索引读取对应的子指南。

#### Token 影响

插件加载且 skill 根目录已发布期间，该条目一直留在上下文中。名称和描述合计约 160 个字符。

#### KV Cache 影响

同一插件版本的目录是固定的。加载或卸载插件，或第一次下载发布 skill 根目录，都会改变目录，目录会作为新消息重新发布，之前的上下文保持不变。

### 加载后的技能正文

#### 模型看到的内容

`dingtalk` 的 `skill` 工具结果约 2,400 个字符：DSH 指引、16 个子指南各一句话的索引，以及打开方式。DSH 指引要求 Agent 按当前运行时上下文给出的绝对路径运行插件提供的 `dws`，不另装或升级，不运行 `dws skill setup`，只用 `dws auth status --readonly --format json` 检查登录状态，在自己运行 `dws auth login --no-browser` 之前先请用户在插件页面连接，并在该命令第一次尝试时就申请 `sandbox_permissions`；命令因为写不了 `~/.dws` 而失败时，带 `sandbox_permissions` 重跑同一条命令，而不是请用户重新连接，对话中出现过一次这种拒绝后，后面访问钉钉数据的命令第一次运行就申请；dws 报告 CLI 访问未开启时，告诉用户需要组织管理员开启；两者不一致时以 DSH 指引为准。它的资源目录是 DSH 缓存中 skill 根目录下的 `dingtalk` 目录，因此 Agent 用文件工具而不是 `skill` 工具打开 `guides/<名字>/SKILL.md`，并以每个子指南自己的目录解析其中的相对路径和脚本。

#### Token 影响

每次加载都会把总入口正文加入保留的工具历史。子指南的 `SKILL.md`（4,000 到 21,000 个字符）及其引用的文件作为普通的文件读取输出返回。

#### KV Cache 影响

加载会追加一条工具结果，不会改写之前的上下文。

### CLI 路径

#### 模型看到的内容

该行加载、且 `dws` 和技能都已安装时，[CLI 账号 Service](../cli-account/README.zh.md#model-experience) 添加一条必需的运行时上下文，给出 `binDir` 中 `dws` 的路径；`binDir` 默认是缓存目录中的 `dws-<version>-<platform>-<arch>`。第二行针对按名称调用 `dws` 的子指南脚本。

##### 运行时上下文条目

```markdown
DingTalk CLI: run `dws` by its absolute path "<binDir>/dws"; the bare name may resolve to another installation or to none.
Scripts in the DingTalk skill call `dws` by name; prefix only the commands that run them with PATH="<binDir>:$PATH", and never export PATH or run `dws` by name yourself.
```

##### Windows 上的运行时上下文条目

```markdown
DingTalk CLI: run `dws` by its absolute path with the call operator, & '<binDir>\dws.exe'; the bare name may resolve to another installation or to none.
Scripts in the DingTalk skill call `dws` by name; start only the commands that run them with $env:PATH = '<binDir>;' + $env:PATH, and never run `dws` by name yourself.
```

#### Token 影响

每份运行时上下文快照中两行，约 270 个字符加上路径及其目录。

#### KV Cache 影响

系统提示词不变；安装完成、加载或卸载该行、或路径变化时，追加一份运行时上下文快照。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS 和 Windows x64。固定的 Linux 归档未经验证，release 中的 Windows arm64 归档没有固定。
- 命令必须在本 Host 上运行。组合把命令放到别处运行（例如通过 SSH）时，插件仍会加载，但每条运行 `dws` 的命令都会因为那里没有这个路径而失败。
- 插件使用 CLI 的默认配置。在 DSH 中登录或退出登录会影响用户自己的终端，以及这台电脑上其他运行 dws 的程序，没有 DSH 专用的账号。页面只显示 dws 报告为当前的账号，不提供在已保存账号之间选择；在终端执行 `dws profile switch` 可以更换当前账号。
- 从插件页面登录需要运行 DSH 的这台电脑上的浏览器，因为 CLI 的授权回调监听 `127.0.0.1`。
- 插件不设置 `DWS_CHANNEL`，在只允许已登记渠道访问 CLI 的组织中未经验证。
- 除非同时设置了 `binDir` 和 `skillsDir`，第一次检查需要能访问 GitHub 或 Gitee，成功之前没有 `dingtalk` skill；Gitee 镜像可能比 release 晚几天。下载源必须发送 `Content-Length`。
- dws 保留其默认的遥测和更新检查；DSH 指引要求 Agent 不要升级它。
- 在文件沙箱下，访问钉钉数据的 `dws` 命令都会在打开 `~/.dws` 下的锁文件时失败，每条命令都需要单条命令审批才能运行。不带 `--readonly` 的 `dws auth status` 在文件沙箱下以退出码 0 把已登录的账号报告成未登录，因此自己运行这项检查的子指南脚本（例如考勤签到报表）会以登录错误退出。
- 移除插件后，已下载的资产和 skill 根目录仍会留在 Harness 缓存中。每个加载该插件的 profile 都各自下载一份 dws 和技能。没有 profile 时，换到新的 release 后，更早的 release 也会留在那里。
- 同一个 profile 的多个进程可以同时运行该插件的不同版本，例如一个在插件更新之前启动，另一个在更新之后启动。后启动的进程会删除先启动的进程正在使用的 release：在先启动的进程中，运行 `dws` 的命令失败，技能目录中也没有 `dingtalk` skill，直到它下一次检查重新下载完成。此后两个 release 都保留，直到这个 profile 的某个进程再次加载该插件。
- 子指南对应 release `v1.0.64`；更新版本需要修改固定的大小和摘要，再对照新的子指南检查总入口的索引和 DSH 指引。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

单元测试和 `dingtalk-skills` 会话快照通过 `binDir` 使用替身可执行文件，通过 `skillsDir` 使用替身技能；下载相关的测试从本地 HTTP 服务提供测试归档。技能测试固定了 16 个上游技能名称，因此更新版本时也要更新这份列表。

</details>
