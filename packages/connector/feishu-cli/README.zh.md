---
description: "把官方飞书 lark-cli 放到私有 Shell PATH 上，加载其内嵌 skill，并执行插件页发起的账号操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-cli

[English](README.md) | 中文

## 概述

本包是[飞书插件](../feishu/README.zh.md)的 Host 行。它安装固定版本的 `@larksuite/cli`，把其 `lark-cli` 可执行文件放到私有 Shell PATH 上，并注册一个 `feishu` skill，为该 CLI 内嵌的子指南提供索引。它的 `feishu` Remote 为[飞书插件页面](../../client/ui-feishu/README.zh.md)检查 CLI 默认账号、通过 CLI 的浏览器流程关联应用并登录、退出登录以及取消操作。CLI 把凭据保存在默认配置中，用户自己的终端也共用这份配置。仅支持 macOS。

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

安装[飞书插件 bundle](../feishu/README.zh.md)，它会把本包作为 `feishu` 行插入；批准 `@larksuite/cli` 安装脚本的方法见该页面。在可执行文件就绪之前，插件加载会失败，错误信息会给出缺失的路径。

### 获得的能力

插件加载后，一个 `feishu` skill 进入 skill 目录。agent 用 `skill` 工具加载它，用 `lark-cli skills read` 打开所需的子指南（例如 `lark-doc` 或 `lark-shared`），并在当前沙箱与审批策略下通过普通 Shell 工具运行 `lark-cli` 命令。命令报告缺少应用配置或登录时，agent 会请用户到插件页连接飞书；只有用户要求在对话中完成时，才按 CLI 自带的流程配置和登录。保存登录状态的命令会在工作区之外写入，因此会申请单条命令审批。

在 Plugin Manager 中关闭该行会为后续 Shell 调用撤下 `feishu` skill 与私有 PATH 条目，CLI 配置与登录保持不变。

<a id="account-operations"></a>
### 账号操作

`feishu` Remote 为插件页服务。它同一时间最多运行一个由 Host 持有的账号操作，因此离开页面不会取消操作。关联应用和登录是两个独立操作，页面分别由各自的一次点击发起。

| 方法 | 作用 |
|---|---|
| `follow(signal)` | 推送账号、进行中的操作和最近一次结果；没有操作运行时，每个新订阅者会触发一次检查 |
| `check()` | 重新检查账号；返回操作 id |
| `linkApp()` | 运行 `config init --new`，用用户新建或选择的应用替换 CLI 的默认配置，其中的登录和其他应用一并替换；不会登录 |
| `signIn()` | 为已关联的应用运行 `auth login --json`，并确认登录的是同一个用户 |
| `signOut()` | 运行 `auth logout --json`，同时退出用户自己终端里的登录，然后重新检查 |
| `cancel(id)` | 在应用配置或登录期间取消该操作并等待其命令退出；其他步骤和已结束的 id 会被忽略 |

检查运行 `auth status --verify --json`。只有 CLI 报告用户可用且已被服务端核实时，账号才是 `connected`；用户缺失、未配置或需要刷新时为 `signed-out`；没有应用时为 `unconfigured`；其他情况为 `unverified`，例如核实时无法连到服务端。除 `unconfigured` 外，每种状态都带有已配置的 `appId`。`config init` 打印的链接和 `auth login` 报告的设备授权链接，只有是 `feishu.cn` 或 `larksuite.com` 上的 HTTPS 地址时才会提供。登录后仍有申请的权限未被授予时（`auth login` 以退出码 3 结束并把它们列为缺失），登录仍算成功；之后需要这些权限的命令会报告缺少哪些。结果分为成功、已取消和失败。失败时，Remote 结果和 Host 日志包含命令、观察到的退出码和已识别的 CLI 错误类别；原生消息、路径和授权数据均不保留。飞书网页显示成功不代表本地凭据已保存。运行 DSH 的进程需要能访问 CLI 配置和系统凭据存储；`DSH_HOME` 不会迁移这两者。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | 已安装 `@larksuite/cli` 包的 `bin` | 包含可执行 `lark-cli` 的绝对目录 |
| `commandTimeoutMs` | `30000` | 单条 skill 命令、账号检查或退出登录的期限，包含可执行文件查找 |

应用配置和登录最多等待用户在浏览器中操作 10 分钟，每条命令最多保留 1 MiB 的 stdout；这两个上限由 [CLI 账号库](../cli-account/README.zh.md)固定。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-feishu-cli)是受支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`src/index.ts`](src/index.ts) 是注册为 `ctx.feishu` 的 Remote 服务。它要求 subprocess 运行时位于本 Host，检查 `binDir/lark-cli` 是否可执行，把 `binDir` 作为提供 `lark-cli` 的 `feishu` PATH 贡献注册到 [Shell 环境](../../shell/shell-env/README.zh.md)，并注册 skill 提供方。[`src/cli.ts`](src/cli.ts) 定位 `lark-cli` 并解析其命令的 JSON 输出。[CLI 账号库](../cli-account/README.zh.md)在私有 PATH 上运行每条命令，使后端与 Shell 使用同一个可执行文件，并一次执行一个账号操作。[`src/account.ts`](src/account.ts) 在该运行时上实现飞书的命令，从命令输出行中读取配置与登录链接，并通过 [`src/diagnostic.ts`](src/diagnostic.ts) 对失败分类。释放时取消进行中的操作，中止正在运行的命令，并在这些进程退出后完成。

[`src/skills.ts`](src/skills.ts) 列出 `feishu` skill 时不运行 CLI。每次加载运行 `lark-cli skills list --json`，依次放入 DSH 指引、由每个子指南名称与描述组成的索引，以及打开子指南及其引用文件的说明；目录读取失败时本次加载失败，下次加载会重新读取目录。子指南内嵌在二进制中，因此 skill 的资源基址是 opaque 类型。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md)——这个应用插件所属的分组。
- [CLI 账号库](../cli-account/README.zh.md)——CLI 应用插件共用的命令执行与账号操作。
- [Shell 环境](../../shell/shell-env/README.zh.md)——后端 subprocess 与 Shell 工具共用的私有 PATH 贡献。
- [Skills](../../../docs/subsystems/skills.zh.md)——目录发布、加载与优先级。
- [飞书插件](../feishu/README.zh.md)——插入本行与页面行的 bundle。
- [飞书插件页面](../../client/ui-feishu/README.zh.md)——发起账号操作的插件页。
- [Plugin Manager](../../boot/plugin-manager/README.zh.md)——安装、构建脚本审批与启用。

-----

<a id="model-experience"></a>
## 模型体验

### Skill 目录条目

#### 模型看到什么

skill 目录中出现一个 `feishu` 条目，描述见下方。

##### 目录描述

```markdown
Feishu (飞书) and Lark through the bundled lark-cli: documents and wiki, Base, sheets, slides, Drive files, messages and group chats, calendar, video meetings and minutes, tasks, approvals, mail, contacts, OKR, attendance, events, and the CLI's app setup and sign-in. Load it before any Feishu or Lark task; it indexes the guides and how to open them.
```

#### Token 影响

插件加载期间该条目一直留在上下文中，约 350 个字符。

#### KV Cache 影响

该条目固定不变。加载或卸载插件会改变目录，目录作为新消息重新发布，不改动更早的上下文。

### 已加载的 skill 正文

#### 模型看到什么

`skill` 工具结果依次包含下方 DSH 指引、`## Guides` 索引（`lark-cli skills list --json` 报告的每个子指南各占一行 `` `name`: description ``），以及下方的打开说明。其资源描述为 `Embedded lark-cli guides; open them with the skills read command given in the loaded skill.`

##### DSH 指引

```markdown
# Feishu in DSH

Call this integration the Feishu plugin (飞书插件 in Chinese) in user-facing replies. Run `lark-cli` by name in the Host Shell; DSH installs the version this plugin pins. It uses the default lark-cli configuration and sign-in shared with the user's own terminal, so do not remove, switch, or sign out of apps or profiles unless the user asks.

When a command reports a missing app configuration or sign-in, first ask the user to connect Feishu on the Feishu plugin page in Plugins. Open the lark-shared guide and run its setup and auth flow yourself only when the user asks to finish it in this conversation. Never ask for or print app secrets or tokens.

Commands that save sign-in state, such as `auth login --device-code` and `config init`, write outside the workspace and use up their one-time authorization even when the save is denied: on the first attempt, set the Shell tool's `sandbox_permissions` to the narrowest mode that can write outside the workspace, with a `justification`. Run other commands in the existing sandbox and set `sandbox_permissions` only when a credential, lock, log, or cache write is denied.

Do not install another lark-cli or run `lark-cli update`.
```

##### 打开说明

```markdown
## Opening a guide

These guides belong to lark-cli and are not skills: open one with `lark-cli skills read <name>` in the Host Shell, not with the skill tool.

Read a file that a guide references, such as `references/...`, with `lark-cli skills read <name> <relative-path>`. Read a reference to another guide, such as `../lark-foo/...`, with the same command without the leading `../`: `lark-cli skills read lark-foo/...`.
```

#### Token 影响

每次加载把固定指引、索引与打开说明加入保留的工具历史。对 `lark-cli` 1.0.97 而言，索引列出 28 个子指南，工具结果约 8,000 个字符。agent 通过 `lark-cli` 读取的子指南及其引用文件作为普通 Shell 输出返回。

#### KV Cache 影响

加载会追加一条工具结果，不改写更早的上下文。

### Plugin CLIs 条目

#### 模型看到什么

本行在私有 PATH 条目中声明了 `lark-cli`，因此该行加载、且 Shell 在本 Host 上运行时，系统提示词中 [Shell 环境](../../shell/shell-env/README.zh.md#model-experience)的 Plugin CLIs 一节会列出 `` `lark-cli` (feishu) ``。

#### Token 影响

该条目只给这一节增加几个 token；这一节本身的文字归 Shell 环境所有。

#### KV Cache 影响

加载或卸载该行会改变这一节的文字，provider 的缓存复用可能在第一个变化的 token 处结束。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS。其他平台未经验证，且不会定位 Windows 可执行文件名 `lark-cli.exe`。
- 插件要求 subprocess 运行时位于本 Host；组合中的 subprocess 运行时在别处运行（例如通过 SSH）时，插件加载失败。
- 插件使用 CLI 的默认配置。在 DSH 中登录或退出会影响用户自己的终端，没有 DSH 私有账号或账号选择器。插件不提供解绑操作；关闭插件会保留配置与登录。
- 登录从 `lark-cli auth login --json` 的事件中读取设备授权链接和完成结果；CLI 版本改变这些事件时，连接以可重试的结果失败。
- 在文件沙箱下，普通命令中的 token 刷新可能被拒绝，此时需要单条命令审批。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

仓库安装在根目录 `pnpm-workspace.yaml` 中拒绝 `@larksuite/cli` 的安装脚本，因此检出的仓库没有原生二进制。要在源码中用真实 CLI 运行插件，请执行一次 `node packages/connector/feishu-cli/node_modules/@larksuite/cli/scripts/install.js`。单测与 `feishu-skills` 会话快照通过 `binDir` 使用替身可执行文件。

</details>
