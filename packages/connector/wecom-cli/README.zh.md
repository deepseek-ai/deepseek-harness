---
description: "把官方 wecom-cli 放进私有 Shell PATH，加载其技能，并执行插件页发起的授权操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-wecom-cli

[English](README.md) | 中文

## 概述

本包是[企业微信插件](../wecom/README.zh.md)的 Host 行。它安装固定版本的 `@wecom/cli`，把其 `wecom-cli` 可执行文件放进私有 Shell PATH，并注册一个 `wecom` skill，其子指南是官方企业微信技能。它的 `wecom` Remote 为[企业微信插件页面](../../client/ui-wecom/README.zh.md)检查 CLI 的授权、通过 CLI 的扫码页面绑定机器人，以及取消操作。CLI 把机器人凭据保存在默认配置中，与用户自己的终端共用。仅支持 macOS。

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

安装[企业微信插件 bundle](../wecom/README.zh.md)，它会把本包作为 `wecom` 行插入。在可执行文件就绪之前，插件加载会失败，错误信息会给出缺失的路径或平台包。

### 获得的能力

插件加载后，一个 `wecom` skill 进入 skill 目录。agent 用 `skill` 工具加载它，用文件工具打开所需的子指南（例如 `wecomcli-doc` 或 `wecomcli-message`），并在当前沙箱与审批策略下通过普通 Shell 工具运行 `wecom-cli` 命令。`wecom-cli auth show --status` 报告未授权时，agent 会请用户到插件页连接企业微信；只有用户要求在对话中完成时，才运行 CLI 自带的 `auth init`，并因为它会在工作区之外写入而申请单条命令审批。

在 Plugin Manager 中关闭该行会为后续 Shell 调用撤下 skill 与私有 PATH 条目，CLI 的授权保持不变。

<a id="account-operations"></a>
### 授权操作

`wecom` Remote 为插件页服务。它同一时间最多运行一个由 Host 持有的操作，因此离开页面不会取消操作。

| 方法 | 作用 |
|---|---|
| `follow(signal)` | 推送授权状态、进行中的操作和最近一次结果；没有操作运行时，每个新订阅者会触发一次检查 |
| `check()` | 重新检查授权；返回操作 id |
| `connect()` | 运行 `auth init --noninteractive --no-browser`，等待用户扫码，然后确认 CLI 报告机器人已授权 |
| `cancel(id)` | 在等待扫码期间取消该操作并等待其命令退出；其他步骤和已结束的 id 会被忽略 |

检查运行 `auth show --status`。授权状态按 CLI 的输出原样读作 `authorized` 或 `unauthorized`；其他输出或非零退出码会使检查失败，并保留之前的状态。`auth init` 在 stdout 中单独一行打印的链接，只有是 `work.weixin.qq.com` 上的 HTTPS 地址时才会提供。结果分为成功、已取消和失败。失败时，Remote 结果和 Host 日志包含命令和观察到的退出码；CLI 的输出可能带有扫码会话，因此不保留。`wecom-cli` 没有撤销授权的命令，因此插件不提供断开连接。运行 DSH 的进程需要能访问 CLI 配置；`DSH_HOME` 不会迁移它。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | 已安装 `@wecom/cli-<platform>-<arch>` 包的 `bin` | 包含可执行 `wecom-cli` 的绝对目录 |
| `commandTimeoutMs` | `30000` | 单次授权检查的期限，包含可执行文件查找 |

扫码授权最多等待用户 10 分钟，每条命令最多保留 1 MiB 的 stdout；这两个上限由 [CLI 账号库](../cli-account/README.zh.md)固定。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-wecom-cli)是受支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`src/index.ts`](src/index.ts) 是注册为 `ctx.wecom` 的 Remote 服务。它要求 subprocess 运行时位于本 Host，检查 `binDir/wecom-cli` 是否可执行，把 `binDir` 作为 `wecom` PATH 贡献注册到 [Shell 环境](../../shell/shell-env/README.zh.md)，并在本包的 `skills/` 目录上挂载一个名为 `wecom` 的[文件系统 skill 提供方](../../skill/skill-filesystem/README.zh.md)，不包含默认根目录，也不监听变化。[`src/directory.ts`](src/directory.ts) 定位 `@wecom/cli` 作为可选依赖安装的平台包。[CLI 账号库](../cli-account/README.zh.md)在私有 PATH 上运行每条命令，使后端与 Shell 使用同一个可执行文件，并一次执行一个操作。[`src/account.ts`](src/account.ts) 在该运行时上实现企业微信的命令，并从 `auth init` 的输出行中读取扫码链接。释放时取消进行中的操作，中止正在运行的命令，并在这些进程退出后完成。

[`skills/wecom/SKILL.md`](skills/wecom/SKILL.md) 是唯一的 skill：DSH 指引、子指南索引和打开方式。[`skills/wecom/guides/`](skills/wecom/guides) 原样复制自 `WecomTeam/wecom-cli` 在提交 `4c74ff2` 时的 `skills/`，因为上游只在该仓库发布这些 skill，没有放进 npm 包。文件系统提供方只发现 `<root>/<name>/SKILL.md`，因此子指南不是独立的 skill。DSH 指引与 `wecomcli-shared` 不一致时，总入口要求 agent 以 DSH 指引为准：使用插件提供的 `wecom-cli`，不再自行安装，并把授权引导到插件页。引用文件是每个子指南目录中的普通文件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md)——这个应用插件所属的分组。
- [CLI 账号库](../cli-account/README.zh.md)——CLI 应用插件共用的命令执行与账号操作。
- [Shell 环境](../../shell/shell-env/README.zh.md)——后端 subprocess 与 Shell 工具共用的私有 PATH 贡献。
- [Skill](../../../docs/subsystems/skills.zh.md)——目录发布、加载与优先级。
- [企业微信插件](../wecom/README.zh.md)——插入本行与页面行的 bundle。
- [企业微信插件页面](../../client/ui-wecom/README.zh.md)——发起授权操作的插件页。

-----

<a id="model-experience"></a>
## 模型体验

### Skill 目录条目

#### 模型看到什么

skill 目录只列出一个 `wecom` skill。其中文描述列出它覆盖的企业微信功能，并要求 agent 在用户提到企业微信或这些功能、或给出 `doc.weixin.qq.com`、`drive.weixin.qq.com` 链接时加载它，再读取对应的子指南。

#### Token 影响

插件加载期间这一条目一直留在上下文中。其名称与描述合计约 160 个字符。

#### KV Cache 影响

同一插件版本的目录固定不变。加载或卸载插件会改变目录，目录作为新消息重新发布，不改动更早的上下文。

### 已加载的 skill 正文

#### 模型看到什么

`wecom` 的 `skill` 工具结果约 2,000 个字符：DSH 指引、为 15 个子指南各写一句话并保留上游分流规则的索引，以及打开子指南的方式。DSH 指引要求 agent 按名称运行插件提供的 `wecom-cli`，先请用户到插件页连接，再考虑自行运行 `auth init --noninteractive`，并以单条命令审批运行该命令；与 `wecomcli-shared` 不一致时以它为准。其资源根目录是 `skills/wecom`，因此 agent 用文件工具而不是 `skill` 工具打开 `guides/<name>/SKILL.md`，把子指南按名字提到的技能当作对应子指南，并按子指南自己的目录解析其中的相对路径。

#### Token 影响

每次加载把总入口正文加入保留的工具历史。子指南及其引用文件作为普通的文件读取输出返回。

#### KV Cache 影响

加载会追加一条工具结果，不改写更早的上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS。其他平台未经验证，且不会定位 Windows 可执行文件名 `wecom-cli.exe`。
- 插件要求 subprocess 运行时位于本 Host；组合中的 subprocess 运行时在别处运行（例如通过 SSH）时，插件加载失败。
- 插件使用 CLI 的默认配置。在 DSH 中授权会影响用户自己的终端，没有 DSH 私有机器人或机器人选择器。`wecom-cli` 无法撤销授权，因此页面和关闭插件都不会移除它。
- 连接从 `auth init --noninteractive --no-browser` 的纯文本输出中读取扫码链接；CLI 版本改变该输出时，连接以可重试的结果失败。
- 子指南跟随上游提交 `4c74ff2`；更新时需手动复制，之后要按新的子指南核对总入口的索引和 DSH 指引。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`.gitattributes` 把 `skills/wecom/guides/**` 标为 vendored 并免除空白检查，使复制的文件保留上游空白；总入口 `SKILL.md` 照常检查。单测与 `wecom-skills` 会话快照通过 `binDir` 使用替身可执行文件。

</details>
