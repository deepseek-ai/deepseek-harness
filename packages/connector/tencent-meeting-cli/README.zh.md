---
description: "把官方 tmeet 放进私有 Shell PATH，加载其技能，并执行插件页发起的账号操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tencent-meeting-cli

[English](README.md) | 中文

## 概述

本包是[腾讯会议插件](../tencent-meeting/README.zh.md)的 Host 行。它安装固定版本的 `@tencentcloud/tmeet`，把其平台可执行文件以 `tmeet` 的名字链接进私有 Shell PATH，并注册一个 `tencent-meeting` skill，其子指南是官方 `tmeet-skill`。它的 `tencentMeeting` Remote 为[腾讯会议插件页面](../../client/ui-tencent-meeting/README.zh.md)检查 CLI 的登录、通过 CLI 的授权页面登录、退出登录，以及取消操作。CLI 把登录保存在默认配置中，与用户自己的终端共用。仅支持 macOS。

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

插件加载后，技能目录中会多一个 `tencent-meeting` skill。Agent 用 `skill` 工具加载它，用文件工具打开 `tmeet-skill` 子指南及其参考文件，并在当前沙箱和审批策略下通过普通 Shell 工具运行 `tmeet` 命令。命令报告未登录或登录过期时，Agent 会请用户在插件页面连接腾讯会议；只有用户要求在对话中完成时，它才运行 `tmeet auth login --no-browser`，并且因为该命令会写入工作区之外，第一次尝试就带 `justification` 申请 `sandbox_permissions`。

在 Plugin Manager 中关闭该行，之后的 Shell 调用就不再有这个 skill 和私有 PATH 条目。CLI 的登录会保留。

<a id="account-operations"></a>
### 账号操作

`tencentMeeting` Remote 为插件页服务。它同一时间最多运行一个由 Host 持有的操作，因此离开页面不会取消它。

| 方法 | 效果 |
|---|---|
| `follow(signal)` | 推送账号、进行中的操作和最近一次结果；没有操作时，每个新订阅者会触发一次检查 |
| `check()` | 重新检查账号；返回操作 id |
| `signIn()` | 运行 `auth login --no-browser`，等待用户在腾讯会议页面授权，然后检查服务端是否接受新的登录 |
| `signOut()` | 运行 `auth logout`，这也会退出用户自己终端里的登录，然后重新检查 |
| `cancel(id)` | 在登录等待授权时取消该操作，并等待其命令退出；其他步骤和已结束的 id 会被忽略 |

检查运行 `auth status`。在 tmeet 1.0.18 中，它只输出纯文本，无论是否有用户登录，退出码都是 0。输出 `Not logged in.` 或 `Session has expired.`，或 `Logged in` 伴随已过期的 refresh token 时，账号为 `signed-out`；`Logged in` 伴随 `UserName:` 行时为 `connected` 并带用户名，CLI 只有在向服务端请求用户信息成功后才会打印这一行；其他 `Logged in` 为 `unverified`，例如该请求连不上服务端。退出码非零或其他输出会使检查失败，并保留之前的账号状态。`auth login` 在 stdout 的 `authorize url:` 行打印的链接，只有是 `meeting.tencent.com` 上的 HTTPS 地址时才会提供。结果分为成功、已取消和失败。失败时，Remote 结果和 Host 日志包含命令和观察到的退出码；CLI 的输出可能带有一次性授权码，因此会被省略。运行 DSH 的进程需要能访问 `~/.tmeet` 中的 CLI 配置、`~/Library/Application Support/tmeet` 中的加密凭据，以及保存其密钥的 macOS 钥匙串项；`DSH_HOME` 不会改变它们的位置。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | Harness 主目录下的一个缓存目录，其中链接当前平台已安装的 `@tencentcloud/tmeet` 可执行文件 | 包含可执行 `tmeet` 的绝对目录 |
| `commandTimeoutMs` | `30000` | 一次账号检查或退出登录的截止时间，包含可执行文件查找 |

登录最多等待用户 10 分钟，每条命令最多保留 1 MiB stdout；这两个上限由 [CLI 账号库](../cli-account/README.zh.md)固定。tmeet 自身在 5 分钟后停止等待授权。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tencent-meeting-cli)是受支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts) 是注册为 `ctx.tencentMeeting` 的 Remote 服务。它要求 Host subprocess 运行时，解析 `tmeet` 所在目录，把该目录作为 `tencent-meeting` PATH 贡献注册到 [Shell 环境](../../shell/shell-env/README.zh.md)，并在本包的 `skills/` 目录上挂载一个名为 `tencent-meeting` 的[文件系统 skill provider](../../skill/skill-filesystem/README.zh.md)，不包含默认根目录，也不监听变化。`@tencentcloud/tmeet` 在 `dist/` 下为每个平台提供一个按平台命名的可执行文件，其 `bin` 是一个 Node 启动器。因此 [`src/directory.ts`](src/directory.ts) 按 `process.platform` 和 `process.arch`，用与该启动器相同的文件名选出可执行文件，并把它以 `tmeet` 的名字链接到 `$DSH_HOME/cache/tencent-meeting/<hash>/`，其中 hash 是可执行文件路径 SHA-256 的前 16 位十六进制数。每次加载都会原子地替换该链接，因此不同路径的安装不会共用一个链接。[CLI 账号库](../cli-account/README.zh.md)在私有 PATH 上运行每条命令，使后端与 Shell 使用同一个可执行文件，并且同一时间只运行一个操作。[`src/account.ts`](src/account.ts) 在该运行时上实现 tmeet 命令，从 `auth login` 的输出行读取授权链接，并解析 `auth status` 的文本。释放时会取消进行中的操作、中止正在运行的命令，并在其进程退出后结束。

[`skills/tencent-meeting/SKILL.md`](skills/tencent-meeting/SKILL.md) 是唯一的 skill：DSH 指引、子指南索引，以及打开子指南的方式。[`skills/tencent-meeting/guides/tmeet-skill/`](skills/tencent-meeting/guides/tmeet-skill) 是 `TencentCloud/tencentmeeting-cli` 标签 `v1.0.18`（提交 `e631b35`）中 `skills/tmeet-skill/` 的 `SKILL.md` 和 `references/` 的原样副本，因为上游只在该仓库中发布这个 skill，npm 包里没有。其中的 `scripts/agent_init.py` 用于把调用方 Agent 和模型记录到 CLI 配置中供上游统计，没有复制。文件系统 provider 只发现 `<root>/<name>/SKILL.md`，因此子指南不是独立的 skill。DSH 指引与子指南不一致时，入口要求 Agent 以 DSH 指引为准：使用插件提供的 `tmeet` 而不是自行安装，跳过 `agent_init.py`，并把登录交给插件页面。参考文件是子指南目录中的普通文件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md) — 本应用插件所属的分组。
- [CLI 账号库](../cli-account/README.zh.md) — CLI 应用插件共用的命令执行与账号操作。
- [Shell 环境](../../shell/shell-env/README.zh.md) — 后端子进程与 Shell 工具共用的私有 PATH 贡献。
- [Skills](../../../docs/subsystems/skills.zh.md) — 目录发布、加载与优先级。
- [腾讯会议插件](../tencent-meeting/README.zh.md) — 插入本行和页面行的 bundle。
- [腾讯会议插件页面](../../client/ui-tencent-meeting/README.zh.md) — 发起账号操作的插件页。

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

`tencent-meeting` 的 `skill` 工具结果约 1,200 个字符：DSH 指引、一句话的 `tmeet-skill` 子指南索引，以及打开方式。DSH 指引要求 Agent 按名称运行插件提供的 `tmeet`，跳过子指南的安装检查和 `agent_init.py` 步骤，在自己运行 `tmeet auth login --no-browser` 之前先请用户在插件页面连接，并在该命令第一次尝试时就申请 `sandbox_permissions`；两者不一致时以 DSH 指引为准。它的资源目录是 `skills/tencent-meeting`，因此 Agent 用文件工具而不是 `skill` 工具打开 `guides/tmeet-skill/SKILL.md`，并以子指南自己的目录解析其中的相对路径。

#### Token 影响

每次加载都会把入口正文加入保留的工具历史。子指南约 18,000 个字符，它和参考文件都以普通的文件读取输出进入上下文。

#### KV Cache 影响

加载会追加一条工具结果，不会改写之前的上下文。

### Plugin CLIs 条目

#### 模型看到的内容

本行在私有 PATH 条目中声明了 `tmeet`，因此该行加载、且 Shell 在本 Host 上运行时，系统提示词中 [Shell 环境](../../shell/shell-env/README.zh.md#model-experience)的 Plugin CLIs 一节会列出 `` `tmeet` (tencent-meeting) ``。

#### Token 影响

该条目只给这一节增加几个 token；这一节本身的文字归 Shell 环境所有。

#### KV Cache 影响

加载或卸载该行会改变这一节的文字，provider 的缓存复用可能在第一个变化的 token 处结束。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS。Linux 未经验证，Windows 没有可链接的可执行文件。
- 插件要求本机 Host 上的 subprocess 运行时；当组合中的 subprocess 运行时在别处运行（例如通过 SSH）时，插件加载会失败。
- 插件使用 CLI 的默认配置。在 DSH 中登录或退出登录会影响用户自己的终端，没有 DSH 专用的账号，也没有账号选择。
- 账号状态来自 tmeet 1.0.18 `auth status` 的纯文本输出，登录链接来自它的 `authorize url:` 行；改变这些文本的 CLI 版本会使检查或登录失败，并给出可重试的结果。服务端没有返回用户名的账号会显示为待确认。
- 移除插件后，Harness 缓存中仍会留下它的链接目录。
- 子指南对应上游标签 `v1.0.18`；更新它需要手工复制，之后要对照新的子指南检查入口的索引和 DSH 指引。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

子指南保留上游的空白字符，包括 `SKILL.md` 中一行只含空格的行和四个没有末尾换行的文件，且没有任何空白豁免：提交新增带行尾空白的上游内容时，pre-commit 的 `git diff --cached --check` 会失败。单元测试和 `tencent-meeting-skills` 会话快照通过 `binDir` 使用替身可执行文件。

</details>
