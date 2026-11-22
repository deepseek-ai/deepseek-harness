---
description: "把企业微信插件加入 profile：官方 wecom-cli 及其技能，以及插件页上的企业微信授权。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-wecom

[English](README.md) | 中文

## 概述

企业微信插件让对话通过官方 `wecom-cli` 使用企业微信。它安装固定版本的 `@wecom/cli`，在运行时上下文中把其 `wecom-cli` 可执行文件的绝对路径告诉模型，并注册一个 `wecom` skill，其子指南是官方企业微信技能，从该 CLI 的 GitHub 仓库下载。它把授权注册到 [连接器账号注册表](../../client/ui-connector-account/README.zh.md)，插件页因此能显示授权，并检查授权、通过 CLI 的扫码页面绑定机器人，或取消操作。CLI 把机器人凭据保存在默认配置中，与用户自己的终端共用。仅支持 macOS 和 Windows x64。

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

在 Web 侧栏的**插件**页面安装，或使用 CLI：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-wecom
dsh plugin --profile web remove @deepseek-ai/dsh-wecom
```

`@wecom/cli` 把原生程序放在 `@wecom/cli-darwin-arm64` 等平台包中，这些包安装时不运行构建脚本。没有与本机匹配的平台包或可执行文件缺失时，`wecom` 行会加载失败，并给出缺失的包名或路径。

### 获得的能力

插件加载后，一个 `wecom` skill 进入 skill 目录。agent 用 `skill` 工具加载它，用文件工具打开所需的子指南（例如 `wecomcli-doc` 或 `wecomcli-message`），并在当前沙箱与审批策略下通过普通 Shell 工具按这个路径运行 `wecom-cli`。`wecom-cli auth show --status` 报告未授权时，agent 会请用户到插件页连接企业微信；只有用户要求在对话中完成时，才运行 CLI 自带的 `auth init`，并且因为该命令会写入工作区之外，第一次尝试就带 `justification` 申请 `sandbox_permissions`。命令返回 `errcode` 853004（`cli token expired`）时，agent 不会请用户重新授权，也不会转述服务端的升级建议，而是带 `sandbox_permissions` 和 `justification` 重跑同一条命令，因为在文件沙箱下 CLI 保存不了刚换到的 token。

子指南来自 `WecomTeam/wecom-cli` 在提交 `4c74ff2` 时的 `skills/`。该行加载时下载这个提交的归档，并把校验后的文件保存在 `$DSH_HOME/cache/wecom/`；文件就位之前，skill 目录中没有 `wecom` skill，插件页会报告下载状态。下载失败时，由插件页的检查重试。

在 Plugin Manager 中关闭插件会撤下 skill、运行时上下文中的路径和授权区块，CLI 的授权和已下载的子指南保持不变。

<a id="account-operations"></a>
### 授权操作

插件页通过 连接器账号注册表发起这些操作，注册表由 Web 应用加载；headless profile 加载插件时没有它。Host 同一时间最多运行一个操作并持有它，因此离开页面不会取消操作。

| 操作 | 作用 |
|---|---|
| `check` | 重新检查授权；没有操作运行时，每个打开 Web 应用的浏览器会触发一次 |
| `connect` | 运行 `auth init --noninteractive --no-browser`，等待用户扫码，然后确认 CLI 报告机器人已授权。已授权的区块以“更换机器人”再次提供它，需先确认，因为新绑定会替换终端共用的那一个 |
| 取消 | 在等待扫码期间取消连接并等待其命令退出；其他步骤会被忽略 |

检查运行 `auth show`。授权状态从 CLI 输出的 `Status` 行读作 `authorized` 或 `unauthorized`，CLI 打印 `Bot ID` 行时，从中读取已绑定机器人的 id 并显示在区块中；其他输出或非零退出码会使检查失败，并保留之前的状态。`auth init` 在 stdout 中单独一行打印的链接，只有是 `work.weixin.qq.com` 上的 HTTPS 地址时才会提供。结果分为成功、已取消和失败。失败时，页面和 Host 日志显示命令和观察到的退出码；CLI 的输出可能带有扫码会话，因此不保留。`wecom-cli` 没有撤销授权的命令，因此插件不提供断开连接。运行 DSH 的进程需要能访问 CLI 配置；`DSH_HOME` 不会迁移它。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | 已安装 `@wecom/cli-<platform>-<arch>` 包的 `bin` | 包含可执行 `wecom-cli`（Windows 上为 `wecom-cli.exe`）的绝对目录 |
| `skillsDir` | 无 | 按仓库路径存放 `skills/` 文件的目录；设置后不下载子指南 |

授权检查使用 [`cli-account` 行](../cli-account/README.zh.md#use-this-package)的 `commandTimeoutMs`，默认 30 秒。扫码授权最多等待用户 10 分钟，每条命令最多保留 1 MiB 的 stdout；这两个上限由 CLI 账号 Service 固定。子指南从 [`upstream-skills` 行](../upstream-skills/README.zh.md#use-this-package)的 `skillsUrls` 下载，每个前缀的时限是该行的 `skillsTimeoutMs`。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-wecom)是受支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 profile 其他层之后把本包作为 `wecom` 行插入，插件页以本包名作为授权区块的 key。[`src/index.ts`](src/index.ts) 是一个函数插件。它检查 `binDir/wecom-cli`（Windows 上为 `wecom-cli.exe`）是否可执行，按 [`src/skills.ts`](src/skills.ts) 中的固定信息把 `wecom` skill 注册到 `ctx.upstreamSkills`，并把这个路径和授权注册到 `ctx.cliAccounts`。账号视图携带下载状态，每次检查都会在不等待的情况下重新开始失败的下载。[`src/directory.ts`](src/directory.ts) 定位 `@wecom/cli` 作为可选依赖安装的平台包。[CLI 账号 Service](../cli-account/README.zh.md) 在运行时上下文中把这个路径告诉模型，按同一路径运行每条命令，一次执行一个操作，并以退出码报告失败的命令。[`src/account.ts`](src/account.ts) 用企业微信的命令完成每个操作，并从 `auth init` 的输出行中读取扫码链接。[`src/presentation.ts`](src/presentation.ts) 用 [`src/locales.ts`](src/locales.ts) 中的文案，把每个视图映射为注册表提供的区块。释放时取消进行中的操作，中止正在运行的命令，并在这些进程退出后完成。

[`skills/wecom/SKILL.md`](skills/wecom/SKILL.md) 是本包携带的唯一 skill：DSH 指引、子指南索引和打开方式。上游只在其仓库发布这些子指南，没有放进 npm 包，因此由[上游技能 Service](../upstream-skills/README.zh.md) 下载；它们是 skill 基础目录下的文件，不是独立的 skill。DSH 指引与 `wecomcli-shared` 不一致时，总入口要求 agent 以 DSH 指引为准：使用插件提供的 `wecom-cli`，不再自行安装，并把授权引导到插件页。引用文件是每个子指南目录中的普通文件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md)——这个应用插件所属的分组。
- [CLI 账号 Service](../cli-account/README.zh.md)——CLI 应用插件共用的命令执行、CLI 路径上下文与账号操作。
- [上游技能 Service](../upstream-skills/README.zh.md)——子指南的下载、校验与发布。
- [Skill](../../../docs/subsystems/skills.zh.md)——目录发布、加载与优先级。
- [连接器账号界面](../../client/ui-connector-account/README.zh.md)——发起授权操作的注册表和插件页区块。

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

`wecom` 的 `skill` 工具结果约 2,300 个字符：DSH 指引、为 15 个子指南各写一句话并保留上游分流规则的索引，以及打开子指南的方式。DSH 指引要求 agent 按当前运行时上下文给出的绝对路径运行插件提供的 `wecom-cli`，先请用户到插件页连接，再考虑自行运行 `auth init --noninteractive`，第一次运行该命令就申请 `sandbox_permissions`，命令返回 `errcode` 853004 时带 `sandbox_permissions` 重跑同一条命令，而不是请用户重新授权或转述服务端的升级建议，重跑后仍返回 853004 才请用户重新授权；与 `wecomcli-shared` 不一致时以它为准。其资源根目录是下载目录，即 `skillsDir` 或 `$DSH_HOME/cache/wecom/skills-<摘要>`，因此 agent 用文件工具而不是 `skill` 工具打开 `skills/<name>/SKILL.md`，把子指南按名字提到的技能当作对应子指南，并按子指南自己的目录解析其中的相对路径。

#### Token 影响

每次加载把总入口正文加入保留的工具历史。子指南及其引用文件作为普通的文件读取输出返回。

#### KV Cache 影响

加载会追加一条工具结果，不改写更早的上下文。

### CLI 路径

#### 模型看到什么

该行加载期间，[CLI 账号 Service](../cli-account/README.zh.md#model-experience) 添加一条必需的运行时上下文，给出 `binDir` 中 `wecom-cli` 的路径；`binDir` 默认是 `@wecom/cli` 安装的平台包的 `bin` 目录。第二行针对按名称调用 `wecom-cli` 的子指南脚本，例如 `build_page.py`。

##### 运行时上下文条目

```markdown
WeCom CLI: run `wecom-cli` by its absolute path "<binDir>/wecom-cli"; the bare name may resolve to another installation or to none.
Scripts in the WeCom skill call `wecom-cli` by name; prefix only the commands that run them with PATH="<binDir>:$PATH", and never export PATH or run `wecom-cli` by name yourself.
```

##### Windows 上的运行时上下文条目

```markdown
WeCom CLI: run `wecom-cli` by its absolute path with the call operator, & '<binDir>\wecom-cli.exe'; the bare name may resolve to another installation or to none.
Scripts in the WeCom skill call `wecom-cli` by name; start only the commands that run them with $env:PATH = '<binDir>;' + $env:PATH, and never run `wecom-cli` by name yourself.
```

#### Token 影响

每份运行时上下文快照中两行，约 280 个字符加上路径及其目录。

#### KV Cache 影响

系统提示词不变；加载或卸载该行、或路径变化时，追加一份运行时上下文快照。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS 和 Windows x64；其他平台未经验证。`@wecom/cli` 没有发布 Windows arm64 平台包。
- 命令必须在本 Host 上运行。组合把命令放到别处运行（例如通过 SSH）时，插件仍会加载，但每条运行 `wecom-cli` 的命令都会因为那里没有这个路径而失败。
- 插件使用 CLI 的默认配置。在 DSH 中授权会影响用户自己的终端，没有 DSH 私有机器人或机器人选择器。`wecom-cli` 无法撤销授权，因此页面和关闭插件都不会移除它；页面只能把已绑定的机器人换成另一个。
- 连接从 `auth init --noninteractive --no-browser` 的纯文本输出中读取扫码链接；CLI 版本改变该输出时，连接以可重试的结果失败。
- 子指南跟随上游提交 `4c74ff2`；更新时要用 `scripts/upstream-skills-digest.ts` 生成新的固定信息，之后按新的子指南核对总入口的索引和 DSH 指引。
- 换用新的固定提交后，首次加载需要能访问 GitHub 或配置的镜像；下载成功之前，agent 没有 `wecom` skill。
- 插件卸载或改为固定其他提交后，已下载的子指南仍留在 `$DSH_HOME/cache/wecom/`。
- 在文件沙箱下，`wecom-cli` 读取已保存的授权时不需要写入，所以在已保存的 token 过期之前命令可以直接运行。token 过期后，CLI 无法把刚换到的 token 保存到工作区之外的配置目录，命令会返回 `errcode` 853004 和服务端的升级建议。重跑这条命令需要一次单条命令审批，之后命令又可以在沙箱中运行，直到下一次过期。页面的检查只读取本地状态，不会刷新 token。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

子指南保留上游的空白，包括表示 Markdown 换行的行尾空格，且没有任何空白豁免：新增带行尾空白的上游行的提交，会被 pre-commit 的 `git diff --cached --check` 拒绝。单测与 `wecom-skills` 会话快照通过 `binDir` 使用替身可执行文件。

</details>
