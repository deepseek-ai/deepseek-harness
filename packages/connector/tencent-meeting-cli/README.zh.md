---
description: "把官方 tmeet 的绝对路径告诉模型，加载其技能，并执行插件页发起的账号操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tencent-meeting-cli

[English](README.md) | 中文

## 概述

本包是[腾讯会议插件](../tencent-meeting/README.zh.md)的 Host 行。它安装固定版本的 `@tencentcloud/tmeet`，在运行时上下文中把其平台可执行文件的绝对路径告诉模型，并注册一个 `tencent-meeting` skill，其子指南是官方 `tmeet-skill`，从 GitHub 上的腾讯会议 CLI 仓库下载。它把账号注册到 [CLI 账号注册表](../../client/ui-cli-account/README.zh.md)，其插件页区块负责检查登录、通过 CLI 的授权页面登录、退出登录和取消操作。CLI 把登录保存在默认配置中，与用户自己的终端共用。仅支持 macOS。

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

### 加入 profile

安装[腾讯会议插件 bundle](../tencent-meeting/README.zh.md)，它会把本包作为 `tencent-meeting` 行插入；该页面说明了 `@tencentcloud/tmeet` 的安装脚本。包里没有当前平台的可执行文件，或可执行文件缺失时，插件加载会失败，错误信息会给出平台或路径。

### 你会得到

插件加载后，技能目录中会多一个 `tencent-meeting` skill。Agent 用 `skill` 工具加载它，用文件工具打开 `tmeet-skill` 子指南及其参考文件，并在当前沙箱和审批策略下通过普通 Shell 工具按这个路径运行 `tmeet`。命令报告未登录或登录过期时，Agent 会请用户在插件页面连接腾讯会议；只有用户要求在对话中完成时，它才运行 `tmeet auth login --no-browser`，并且因为该命令会写入工作区之外，第一次尝试就带 `justification` 申请 `sandbox_permissions`。

子指南来自 `TencentCloud/tencentmeeting-cli` 标签 `v1.0.18`（提交 `e631b35`）中的 `skills/tmeet-skill/`，不含 `scripts/agent_init.py`。该行加载时下载这个提交的归档，并把校验后的文件保存在 `$DSH_HOME/cache/tencent-meeting/`；文件就位之前，skill 目录中没有 `tencent-meeting` skill，插件页会报告下载状态。下载失败时，由插件页的检查重试。

在 Plugin Manager 中关闭该行会撤下这个 skill，并从运行时上下文中移除这个路径。CLI 的登录和已下载的子指南会保留。

<a id="account-operations"></a>
### 账号操作

插件页通过 CLI 账号注册表发起这些操作，注册表由 Web 应用加载；headless profile 加载插件时没有它。Host 同一时间最多运行一个操作并持有它，因此离开页面不会取消它。

| 操作 | 效果 |
|---|---|
| `check` | 重新检查账号；没有操作运行时，每个打开 Web 应用的浏览器会触发一次 |
| `sign-in` | 运行 `auth login --no-browser`，等待用户在腾讯会议页面授权，然后检查服务端是否接受新的登录 |
| `sign-out` | 用户确认后运行 `auth logout`，这也会退出用户自己终端里的登录，然后重新检查 |
| 取消 | 在登录等待授权时取消它，并等待其命令退出；其他步骤会被忽略 |

检查运行 `auth status`。在 tmeet 1.0.18 中，它只输出纯文本，无论是否有用户登录，退出码都是 0。输出 `Not logged in.` 或 `Session has expired.`，或 `Logged in` 伴随已过期的 refresh token 时，账号为 `signed-out`；`Logged in` 伴随 `UserName:` 行时为 `connected` 并带用户名，CLI 只有在向服务端请求用户信息成功后才会打印这一行；其他 `Logged in` 为 `unverified`，例如该请求连不上服务端。退出码非零或其他输出会使检查失败，并保留之前的账号状态。`auth login` 在 stdout 的 `authorize url:` 行打印的链接，只有是 `meeting.tencent.com` 上的 HTTPS 地址时才会提供。结果分为成功、已取消和失败。失败时，页面和 Host 日志显示命令和观察到的退出码；CLI 的输出可能带有一次性授权码，因此会被省略。运行 DSH 的进程需要能访问 `~/.tmeet` 中的 CLI 配置、`~/Library/Application Support/tmeet` 中的加密凭据，以及保存其密钥的 macOS 钥匙串项；`DSH_HOME` 不会改变它们的位置。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | 不设置，此时运行当前平台已安装的 `@tencentcloud/tmeet` 可执行文件 | 包含可执行 `tmeet`（Windows 上为 `tmeet.exe`）的绝对目录 |
| `commandTimeoutMs` | `30000` | 一次账号检查或退出登录的截止时间，包含可执行文件查找 |
| `skillsDir` | 无 | 按仓库路径存放 `skills/tmeet-skill/` 文件的目录；设置后不下载子指南 |
| `skillsUrls` | `['https://codeload.github.com']` | 按顺序尝试的归档下载前缀 |
| `skillsTimeoutMs` | `120000` | 一个前缀送达完整归档的时限 |

登录最多等待用户 10 分钟，每条命令最多保留 1 MiB stdout；这两个上限由 [CLI 账号库](../cli-account/README.zh.md)固定。tmeet 自身在 5 分钟后停止等待授权。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tencent-meeting-cli)是受支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts) 是一个函数插件。它解析 `tmeet` 可执行文件，在运行时上下文中把它的路径告诉模型，并通过[上游技能库](../upstream-skills/README.zh.md)按 [`src/skills.ts`](src/skills.ts) 中的固定信息注册 `tencent-meeting` skill。账号视图携带下载状态，每次检查都会在不等待的情况下重新开始失败的下载。`@tencentcloud/tmeet` 在 `dist/` 下为每个平台提供一个按平台命名的可执行文件，其 `bin` 是一个 Node 启动器。因此 [`src/directory.ts`](src/directory.ts) 按 `process.platform` 和 `process.arch`，用与该启动器相同的文件名选出可执行文件，运行时上下文和插件自己的命令都使用这个路径。[CLI 账号库](../cli-account/README.zh.md)注册这条运行时上下文，按同一路径运行每条命令，并且同一时间只运行一个操作。[`src/account.ts`](src/account.ts) 在该运行时上实现 tmeet 命令，从 `auth login` 的输出行读取授权链接，并解析 `auth status` 的文本。[`src/presentation.ts`](src/presentation.ts) 用 [`src/locales.ts`](src/locales.ts) 中的文案，把每个视图映射为注册表提供的区块。释放时会取消进行中的操作、中止正在运行的命令，并在其进程退出后结束。

[`skills/tencent-meeting/SKILL.md`](skills/tencent-meeting/SKILL.md) 是本包携带的唯一 skill：DSH 指引、子指南索引，以及打开子指南的方式。上游只在其仓库中发布这个子指南，npm 包里没有，因此由该库下载；它是 skill 基础目录下的一组文件，不是独立的 skill。固定信息排除了 `scripts/agent_init.py`，它用于把调用方 Agent 和模型记录到 CLI 配置中供上游统计。DSH 指引与子指南不一致时，入口要求 Agent 以 DSH 指引为准：使用插件提供的 `tmeet` 而不是自行安装，跳过 `agent_init.py`，并把登录交给插件页面。参考文件是子指南目录中的普通文件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md) — 本应用插件所属的分组。
- [CLI 账号库](../cli-account/README.zh.md) — CLI 应用插件共用的命令执行与账号操作。
- [Skills](../../../docs/subsystems/skills.zh.md) — 目录发布、加载与优先级。
- [腾讯会议插件](../tencent-meeting/README.zh.md) — 插入本行和页面行的 bundle。
- [CLI 账号界面](../../client/ui-cli-account/README.zh.md) — 发起账号操作的注册表和插件页区块。

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

该行加载期间，[CLI 账号库](../cli-account/README.zh.md#model-experience)添加一条必需的运行时上下文，给出可执行文件的路径：`binDir` 中的 `tmeet`，或者默认使用当前平台已安装的 `@tencentcloud/tmeet` 可执行文件，例如 `dist/tmeet-macOS-AppleSilicon`。

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

系统提示词不变；加载或卸载该行、或路径变化时，追加一份运行时上下文快照。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS 和 Windows x64；Linux 未经验证。`@tencentcloud/tmeet` 没有 Windows arm64 可执行文件。
- 命令必须在本 Host 上运行。组合把命令放到别处运行（例如通过 SSH）时，插件仍会加载，但每条运行 `tmeet` 的命令都会因为那里没有这个路径而失败。
- 插件使用 CLI 的默认配置。在 DSH 中登录或退出登录会影响用户自己的终端，没有 DSH 专用的账号，也没有账号选择。
- 账号状态来自 tmeet 1.0.18 `auth status` 的纯文本输出，登录链接来自它的 `authorize url:` 行；改变这些文本的 CLI 版本会使检查或登录失败，并给出可重试的结果。服务端没有返回用户名的账号会显示为待确认。
- 子指南对应上游标签 `v1.0.18`；更新它要用 `scripts/upstream-skills-digest.ts` 生成新的固定信息，之后对照新的子指南检查入口的索引和 DSH 指引。
- 换用新的固定提交后，首次加载需要能访问 GitHub 或配置的镜像；下载成功之前，Agent 没有 `tencent-meeting` skill。
- 插件卸载或改为固定其他提交后，已下载的子指南仍留在 `$DSH_HOME/cache/tencent-meeting/`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

单元测试、`tencent-meeting-skills` 会话快照和 Web 端到端测试通过 `binDir` 使用替身可执行文件，通过 `skillsDir` 使用本地目录，因此都不会下载子指南。

</details>
