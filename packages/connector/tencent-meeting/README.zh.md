---
description: "把腾讯会议插件加入 profile：官方 tmeet 及其技能，以及插件页上的腾讯会议登录。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tencent-meeting

[English](README.md) | 中文

## 概述

腾讯会议插件让对话通过官方 `tmeet` CLI 使用腾讯会议。它安装固定版本的 `@tencentcloud/tmeet`，在运行时上下文中把其平台可执行文件的绝对路径告诉模型，并注册一个 `tencent-meeting` skill，其子指南是官方 `tmeet-skill`，从该 CLI 的 GitHub 仓库下载。它把账号注册到 [连接器账号注册表](../../client/ui-connector-account/README.zh.md)，其插件页区块负责检查登录、通过 CLI 的授权页面登录、退出登录和取消操作。CLI 把登录保存在默认配置中，与用户自己的终端共用。仅支持 macOS 和 Windows x64。

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

在 Web 侧栏的 **插件** 页面安装，或使用 CLI：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-tencent-meeting
dsh plugin --profile web remove @deepseek-ai/dsh-tencent-meeting
```

`@tencentcloud/tmeet` 声明了安装脚本，因此第一次安装会停下来，待处理的构建脚本中列出 `@tencentcloud/tmeet`。在插件页面选择 **允许这些脚本并重试**；使用 CLI 时，在 profile 的 `pnpm-workspace.yaml` 中把它的 `allowBuilds` 设为 `true`，然后重新运行命令。该脚本会把包里的可执行文件设为可执行，并运行 `tmeet auth logout`，这会退出这台电脑上 tmeet 的登录，包括用户自己的终端。这项允许会保留在 profile 中，因此之后每次安装新版本的 `@tencentcloud/tmeet` 都会运行该脚本并再次退出登录；之后在插件页面重新登录即可。包里没有当前平台的可执行文件，或可执行文件缺失时，插件加载会失败，错误信息会给出平台或路径。

### 你会得到

插件加载后，技能目录中会多一个 `tencent-meeting` skill。Agent 用 `skill` 工具加载它，用文件工具打开 `tmeet-skill` 子指南及其参考文件，并在当前沙箱和审批策略下通过普通 Shell 工具按这个路径运行 `tmeet`。命令报告未登录或登录过期时，Agent 会请用户在插件页面连接腾讯会议；只有用户要求在对话中完成时，它才运行 `tmeet auth login --no-browser`，并且因为该命令会写入工作区之外，第一次尝试就带 `justification` 申请 `sandbox_permissions`。

子指南来自 `TencentCloud/tencentmeeting-cli` 标签 `v1.0.18`（提交 `e631b35`）中的 `skills/tmeet-skill/`，不含 `scripts/agent_init.py`。该行加载时下载这个提交的归档，并把校验后的文件保存在 `$DSH_HOME/cache/tencent-meeting/`；文件就位之前，skill 目录中没有 `tencent-meeting` skill，运行时上下文不给出 `tmeet` 路径，插件页显示的是下载而不是账号。插件页的检查会等待下载，并把它显示为一个带**取消**的步骤。没有完成的下载使账号处于 `not-installed`：页面提示没能下载技能并提供**重试**，下一次检查会重新下载。

在 Plugin Manager 中关闭插件会撤下这个 skill、运行时上下文中的路径和账号区块。CLI 的登录和已下载的子指南会保留。

<a id="account-operations"></a>
### 账号操作

插件页通过 连接器账号注册表发起这些操作，注册表由 Web 应用加载；headless profile 加载插件时没有它。Host 同一时间最多运行一个操作并持有它，因此离开页面不会取消它。

| 操作 | 效果 |
|---|---|
| `check` | 子指南缺失时先等待它下载完成（没有下载在运行时发起一次），然后重新检查账号；没有操作运行时，每个打开 Web 应用的浏览器会触发一次 |
| `sign-in` | 运行 `auth login --no-browser`，等待用户在腾讯会议页面授权，然后检查服务端是否接受新的登录 |
| `sign-out` | 用户确认后运行 `auth logout`，这也会退出用户自己终端里的登录，然后重新检查 |
| 取消 | 在登录等待授权期间取消登录，或在检查等待子指南下载期间取消检查，并等待命令或下载停止；其他步骤会被忽略 |

检查运行 `auth status`。在 tmeet 1.0.18 中，它只输出纯文本，无论是否有用户登录，退出码都是 0。输出 `Not logged in.` 或 `Session has expired.`，或 `Logged in` 伴随已过期的 refresh token 时，账号为 `signed-out`；`Logged in` 伴随 `UserName:` 行时为 `connected` 并带用户名，CLI 只有在向服务端请求用户信息成功后才会打印这一行；其他 `Logged in` 为 `unverified`，例如该请求连不上服务端。退出码非零或其他输出会使检查失败，并保留之前的账号状态，只是下载就位之后 `not-installed` 会换成 `unchecked`；没有完成的下载使状态成为 `not-installed`。`auth login` 在 stdout 的 `authorize url:` 行打印的链接，只有是 `meeting.tencent.com` 上的 HTTPS 地址时才会提供。结果分为成功、已取消和失败。失败时，页面和 Host 日志显示命令和观察到的退出码；CLI 的输出可能带有一次性授权码，因此会被省略。运行 DSH 的进程需要能访问 `~/.tmeet` 中的 CLI 配置、`~/Library/Application Support/tmeet` 中的加密凭据，以及保存其密钥的 macOS 钥匙串项；`DSH_HOME` 不会改变它们的位置。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | 不设置，此时运行当前平台已安装的 `@tencentcloud/tmeet` 可执行文件 | 包含可执行 `tmeet`（Windows 上为 `tmeet.exe`）的绝对目录 |
| `skillsDir` | 无 | 按仓库路径存放 `skills/tmeet-skill/` 文件的目录；设置后不下载子指南 |

账号检查和退出登录使用 [`cli-account` 行](../cli-account/README.zh.md#use-this-package)的 `commandTimeoutMs`，默认 30 秒。登录最多等待用户 10 分钟，每条命令最多保留 1 MiB stdout；这两个上限由 CLI 账号 Service 固定。tmeet 自身在 5 分钟后停止等待授权。子指南从 [`upstream-skills` 行](../upstream-skills/README.zh.md#use-this-package)的 `skillsUrls` 下载，每个前缀的时限是该行的 `skillsTimeoutMs`。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tencent-meeting)是受支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 profile 其他层之后把本包作为 `tencent-meeting` 行插入，插件页以本包名作为账号区块的 key。[`src/index.ts`](src/index.ts) 是一个函数插件。它解析 `tmeet` 可执行文件，按 [`src/skills.ts`](src/skills.ts) 中的固定信息把 `tencent-meeting` skill 注册到 `ctx.upstreamSkills`，并把这个路径和账号注册到 `ctx.cliAccounts`。这次注册的 [`prepare` 步骤](../cli-account/README.zh.md#prepare-before-a-check)就是 skill 句柄的 `installed` 和 `install`，因此每次检查都先等待子指南下载完成，没有下载在运行时发起一次。`@tencentcloud/tmeet` 在 `dist/` 下为每个平台提供一个按平台命名的可执行文件，其 `bin` 是一个 Node 启动器。因此 [`src/directory.ts`](src/directory.ts) 按 `process.platform` 和 `process.arch`，用与该启动器相同的文件名选出可执行文件，运行时上下文和插件自己的命令都使用这个路径。[CLI 账号 Service](../cli-account/README.zh.md) 在子指南就位期间于运行时上下文中把这个路径告诉模型，在它缺失时于检查的第一条命令之前运行 `prepare` 步骤，按同一路径运行每条命令，同一时间只运行一个操作，并以退出码报告失败的命令。[`src/account.ts`](src/account.ts) 用 tmeet 命令完成每个操作，从 `auth login` 的输出行读取授权链接，并解析 `auth status` 的文本。[`src/presentation.ts`](src/presentation.ts) 用 [`src/locales.ts`](src/locales.ts) 中的文案，把每个视图映射为注册表提供的区块。释放时会取消进行中的操作、中止正在运行的命令和子指南的下载，并在这些命令的进程退出后结束。

[`skills/tencent-meeting/SKILL.md`](skills/tencent-meeting/SKILL.md) 是本包携带的唯一 skill：DSH 指引、子指南索引，以及打开子指南的方式。上游只在其仓库中发布这个子指南，npm 包里没有，因此由[上游技能 Service](../upstream-skills/README.zh.md) 下载；它是 skill 基础目录下的一组文件，不是独立的 skill。固定信息排除了 `scripts/agent_init.py`，它用于把调用方 Agent 和模型记录到 CLI 配置中供上游统计。DSH 指引与子指南不一致时，入口要求 Agent 以 DSH 指引为准：使用插件提供的 `tmeet` 而不是自行安装，跳过 `agent_init.py`，并把登录交给插件页面。参考文件是子指南目录中的普通文件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md) — 本应用插件所属的分组。
- [CLI 账号 Service](../cli-account/README.zh.md) — CLI 应用插件共用的命令执行、CLI 路径上下文与账号操作。
- [上游技能 Service](../upstream-skills/README.zh.md) — 子指南的下载、校验与发布。
- [Skills](../../../docs/subsystems/skills.zh.md) — 目录发布、加载与优先级。
- [连接器账号界面](../../client/ui-connector-account/README.zh.md) — 发起账号操作的注册表和插件页区块。

-----

<a id="model-experience"></a>
## 模型体验

### 技能目录条目

#### 模型看到的内容

技能目录列出一个 `tencent-meeting` skill。它的中文描述列出涵盖的腾讯会议功能，并要求 Agent 在用户提到腾讯会议、会议号、会议录制或纪要时先加载它，再读取 `tmeet-skill` 子指南。

#### Token 影响

插件加载期间，该条目一直留在上下文中。名称和描述合计约 130 个字符。

#### KV Cache 影响

同一插件版本的目录是固定的。加载或卸载插件会改变目录，目录会作为新消息重新发布，之前的上下文保持不变。

### 加载后的技能正文

#### 模型看到的内容

`tencent-meeting` 的 `skill` 工具结果约 1,200 个字符：DSH 指引、一句话的 `tmeet-skill` 子指南索引，以及打开方式。DSH 指引要求 Agent 按当前运行时上下文给出的绝对路径运行插件提供的 `tmeet`，跳过子指南的安装检查和 `agent_init.py` 步骤，在自己运行 `tmeet auth login --no-browser` 之前先请用户在插件页面连接，并在该命令第一次尝试时就申请 `sandbox_permissions`；两者不一致时以 DSH 指引为准。它的资源目录是下载目录，即 `skillsDir` 或 `$DSH_HOME/cache/tencent-meeting/skills-<摘要>`，因此 Agent 用文件工具而不是 `skill` 工具打开 `skills/tmeet-skill/SKILL.md`，并以子指南自己的目录解析其中的相对路径。

#### Token 影响

每次加载都会把入口正文加入保留的工具历史。子指南约 18,000 个字符，它和参考文件都以普通的文件读取输出进入上下文。

#### KV Cache 影响

加载会追加一条工具结果，不会改写之前的上下文。

### CLI 路径

#### 模型看到的内容

该行加载且子指南就位期间，[CLI 账号 Service](../cli-account/README.zh.md#model-experience) 添加一条必需的运行时上下文，给出可执行文件的路径：`binDir` 中的 `tmeet`，或者默认使用当前平台已安装的 `@tencentcloud/tmeet` 可执行文件，例如 `dist/tmeet-macOS-AppleSilicon`。

##### 运行时上下文条目

```markdown
Tencent Meeting CLI: run `tmeet` by its absolute path "<executable>"; the bare name may resolve to another installation or to none.
```

##### Windows 上的运行时上下文条目

```markdown
Tencent Meeting CLI: run `tmeet` by its absolute path with the call operator, & '<executable>'; the bare name may resolve to another installation or to none.
```

#### Token 影响

每份运行时上下文快照中一行，约 115 个字符加上路径。

#### KV Cache 影响

系统提示词不变；子指南下载完成、加载或卸载该行、或路径变化时，追加一份运行时上下文快照。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS 和 Windows x64；Linux 未经验证。`@tencentcloud/tmeet` 没有 Windows arm64 可执行文件。
- 安装新版本的 `@tencentcloud/tmeet` 会退出这台电脑上 tmeet 的登录，因为已允许的安装脚本会运行 `tmeet auth logout`。
- 命令必须在本 Host 上运行。组合把命令放到别处运行（例如通过 SSH）时，插件仍会加载，但每条运行 `tmeet` 的命令都会因为那里没有这个路径而失败。
- 插件使用 CLI 的默认配置。在 DSH 中登录或退出登录会影响用户自己的终端，没有 DSH 专用的账号，也没有账号选择。
- 账号状态来自 tmeet 1.0.18 `auth status` 的纯文本输出，登录链接来自它的 `authorize url:` 行；改变这些文本的 CLI 版本会使检查或登录失败，并给出可重试的结果。服务端没有返回用户名的账号会显示为待确认。
- 子指南对应上游标签 `v1.0.18`；更新它要用 `scripts/upstream-skills-digest.ts` 生成新的固定信息，之后对照新的子指南检查入口的索引和 DSH 指引。
- 换用新的固定提交后，首次加载需要能访问 GitHub 或配置的镜像；下载成功之前，Agent 既没有 `tencent-meeting` skill 也没有 `tmeet` 路径，页面也不提供登录。两者都访问不到的电脑需要设置 `skillsDir`。headless profile 没有页面的检查，因此加载时失败的下载要到下一次加载才会重试。
- 插件卸载或改为固定其他提交后，已下载的子指南仍留在 `$DSH_HOME/cache/tencent-meeting/`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

单元测试、`tencent-meeting-skills` 会话快照和 Web 端到端测试通过 `binDir` 使用替身可执行文件，通过 `skillsDir` 使用本地目录，因此都不会下载子指南。

</details>
