---
description: "把固定版本的官方 dws 及其技能安装到 DSH 缓存目录，把 dws 放进私有 Shell PATH，加载其技能，并执行插件页发起的账号操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-dingtalk-cli

[English](README.md) | 中文

## 概述

本包是[钉钉插件](../dingtalk/README.zh.md)的 Host 行。它从同一个固定版本的 release 下载钉钉官方 CLI（DingTalk Workspace CLI，命令 `dws`）和钉钉官方技能到 DSH 缓存目录，把 `dws` 放进私有 Shell PATH，并注册一个 `dingtalk` skill，其子指南就是这些技能。它的 `dingtalk` Remote 为[钉钉插件页面](../../client/ui-dingtalk/README.zh.md)检查 CLI 的登录、通过 CLI 的浏览器授权页面登录、退出当前账号，以及取消操作。CLI 把登录保存在 `~/.dws` 和系统钥匙串中，与用户自己的终端共用。仅支持 macOS。

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

安装[钉钉插件 bundle](../dingtalk/README.zh.md)，它会把本包作为 `dingtalk` 行插入。本包没有安装脚本。该行加载时，会下载 dws release 1.0.64 的两个资产：当前平台的归档（16 到 18 MB）和 `dws-skills.zip`（3.3 MB）。每个资产都先从 GitHub Releases 下载，GitHub 失败时改用官方 Gitee 镜像；该行校验大小和 SHA-256 后，保存在 `$DSH_HOME/cache/dingtalk/`。下载完成之前，Shell PATH 上没有 `dws`，技能目录中也没有 `dingtalk` skill。当前平台没有对应的归档时，该行加载失败并给出平台；如需使用其他 `dws`，请设置 `binDir`。同时设置 `binDir` 和 `skillsDir` 时，该行不下载任何内容。

登录需要一个已加入组织的钉钉账号，并且组织管理员已在钉钉开发者后台开启 CLI 访问。未开启时，用户可以在授权页申请。

### 你会得到

下载完成后，技能目录中会多一个 `dingtalk` skill。Agent 用 `skill` 工具加载它，用文件工具打开当前产品对应的子指南（例如 `dingtalk-calendar` 或 `dingtalk-doc`），并在当前沙箱和审批策略下通过普通 Shell 工具运行 `dws` 命令。命令报告未登录或登录过期时，Agent 会请用户在插件页面连接钉钉；只有用户要求在对话中完成时，它才运行 `dws auth login --no-browser`，并且因为该命令会写入工作区之外，第一次尝试就带 `justification` 申请 `sandbox_permissions`。

在 Plugin Manager 中关闭该行，之后的 Shell 调用就不再有这个 skill 和私有 PATH 条目。CLI 的登录和已下载的资产会保留。

<a id="account-operations"></a>
### 账号操作

`dingtalk` Remote 为插件页提供服务。它同一时间最多执行一个操作，操作归 Host 所有，因此离开页面不会取消它。该行加载时会启动一次检查，dws 或其技能缺失时这次检查也会下载。

| 方法 | 效果 |
|---|---|
| `follow(signal)` | 推送账号、进行中的操作和最近一次结果；没有操作时，每个新订阅者会触发一次检查 |
| `check()` | dws 或其技能缺失时先下载，再重新检查账号；返回操作 id |
| `signIn()` | 运行 `auth login --no-browser --format json`，等待用户在这台电脑的浏览器中授权，然后检查 dws 是否报告该账号已登录 |
| `signOut()` | 对最近一次检查发现的账号运行 `auth logout --profile <corpId>:<userId>`，这也会让用户自己的终端退出该账号，然后重新检查 |
| `cancel(id)` | 在登录等待授权时取消该操作，并等待其命令退出；其他步骤和已结束的 id 会被忽略 |

检查运行 `auth status --format json`，它会向服务端刷新已过期的访问令牌，无论是否有用户登录，退出码都是 0。`authenticated` 为 true 时，账号为 `connected`，并带上 dws 报告的用户名和组织名；为 false 且原因属于 dws 报告为无法判断的几种（`local_state_requires_repair`、`local_state_unreadable`、`ciphertext_key_mismatch`、`dek_missing`、`keychain_unavailable`）时为 `unverified`；其余为 `signed-out`。退出码非零，或输出不是状态 JSON，会使检查失败并保留之前的账号状态；下载没有完成时为 `not-installed`。退出登录要求两个 id 都存在，因此不会选中一个组织的全部账号；其他组织的账号保持登录，下一次检查显示 dws 届时报告的当前账号。`auth login` 在 stderr 中单独一行、带缩进打印的链接，只有是 `login.dingtalk.com` 上的 HTTPS 地址时才会提供。结果分为成功、已取消和失败。失败时，Remote 结果和 Host 日志包含命令和观察到的退出码；CLI 的输出会被省略。运行 DSH 的进程需要能访问 `~/.dws` 和该 CLI 的 macOS 钥匙串项；`DSH_HOME` 不会改变它们的位置。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | 保存已下载可执行文件的缓存目录 | 包含可执行 `dws` 的绝对目录；设置后不下载可执行文件 |
| `skillsDir` | 保存已下载技能的缓存目录 | 布局与 release 的 `dws-skills.zip` 中 `multi/` 目录相同的目录；设置后不下载技能 |
| `releaseUrls` | `DingTalk-Real-AI/dingtalk-workspace-cli` 在 GitHub Releases 和 Gitee 镜像的下载前缀 | 按顺序尝试的 HTTPS 前缀，用于下载 `binDir` 和 `skillsDir` 未提供的内容；每个都在 `v<版本>/<资产名>` 下提供资产，且 `Content-Length` 等于资产大小 |
| `commandTimeoutMs` | `30000` | 一次账号检查或退出登录的截止时间，包含可执行文件查找 |

登录最多等待用户 10 分钟，每条命令最多保留 1 MiB stdout；这两个上限由 [CLI 账号库](../cli-account/README.zh.md)固定。dws 自身在 6 分钟后停止等待授权。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-dingtalk-cli)是支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts) 是注册为 `ctx.dingtalk` 的 Remote 服务。它要求 subprocess 运行时位于本 Host，把 `dws` 所在目录作为 `dingtalk` PATH 贡献注册到 [Shell 环境](../../shell/shell-env/README.zh.md)，在 `src/release.ts` 发布的 skill 根目录上挂载一个名为 `dingtalk` 的[文件系统 skill 提供方](../../skill/skill-filesystem/README.zh.md)，并启动一次检查，使没有浏览器的会话也能找到 `dws` 和该 skill。该提供方不包含默认根目录，并监听 skill 根目录，因为第一次下载发布它时，目录可能已经列出过。本包不使用 npm 包 `dingtalk-workspace-cli`：它的安装脚本会把官方技能复制到默认 skill 提供方扫描的 `~/.agents/skills`，以及其他 Agent 的 skill 目录，插件撤下后它们仍会留下。dws 内嵌了同样的技能，但 `dws skill setup` 只写入这类 Agent 目录。

[`src/release.ts`](src/release.ts) 固定发布版本、各平台的归档和 `dws-skills.zip`，每项都记录 release 的 `checksums.txt` 中的名称、大小和 SHA-256。它只下载缺少的资产；响应的 `Content-Length` 不符时，在读取正文之前就拒绝，随后校验摘要。它用 `tar` 解压平台归档，用 `fflate` 解压技能归档中 `multi/` 下的条目及根目录的 `LICENSE`、`NOTICE`，都解压到同级的临时目录；技能条目的路径含空段、`.`、`..` 或反斜杠时拒绝。解压结果通过改名发布，另一个进程先发布的目录会被保留。每个失败的下载源记录一条警告。skill 根目录 `$DSH_HOME/cache/dingtalk/skill-<摘要>/` 包含包内总入口在 `dingtalk/SKILL.md` 的副本，以及指向技能目录的符号链接 `dingtalk/guides`。摘要覆盖总入口和链接目标，因此已发布的根目录不会再变；加载时技能目录已经存在，就同步发布根目录。

[CLI 账号库](../cli-account/README.zh.md)在私有 PATH 上运行每条命令，使后端与 Shell 使用同一个可执行文件，并一次执行一个操作。[`src/account.ts`](src/account.ts) 在该运行时上实现 dws 的命令，在检查的第一条命令之前准备好版本，从 `auth login` 的 stderr 行中读取授权链接，并解析 `auth status` 的 JSON。它把已登录账号的 id 留在 Host 上供退出登录使用；Remote 视图只包含名字。释放时取消进行中的操作，中止正在运行的命令和下载，并在这些进程退出后完成。

[`skills/dingtalk/SKILL.md`](skills/dingtalk/SKILL.md) 是唯一的 skill：DSH 指引、16 个子指南的索引，以及打开方式。子指南是 release `v1.0.64` 的 `dws-skills.zip` 中的 `multi/` 目录树，上游安装程序默认使用它；另一种 `mono/` 是重复同样内容的单一入口。文件系统提供方只发现 `<root>/<name>/SKILL.md`，因此子指南不是独立的 skill。子指南之间用 `../dingtalk-shared/SKILL.md` 这样的相对路径互相引用，由于子指南保持同级布局，这些路径可以解析；它们的辅助脚本也从各自的 `scripts/` 目录运行。DSH 指引与子指南不一致时，总入口要求 Agent 以 DSH 指引为准：使用插件提供的 `dws`，不另装或升级，不运行 `dws skill setup`，并把登录交给插件页面。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md) — 本应用插件所属的分组。
- [CLI 账号库](../cli-account/README.zh.md) — CLI 应用插件共用的命令执行与账号操作。
- [Shell 环境](../../shell/shell-env/README.zh.md) — 后端子进程与 Shell 工具共用的私有 PATH 贡献。
- [Skills](../../../docs/subsystems/skills.zh.md) — 目录发布、加载与优先级。
- [钉钉插件](../dingtalk/README.zh.md) — 插入本行和页面行的 bundle。
- [钉钉插件页面](../../client/ui-dingtalk/README.zh.md) — 发起账号操作的插件页。

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

`dingtalk` 的 `skill` 工具结果约 2,100 个字符：DSH 指引、16 个子指南各一句话的索引，以及打开方式。DSH 指引要求 Agent 按名称运行插件提供的 `dws`，不另装或升级，不运行 `dws skill setup`，在自己运行 `dws auth login --no-browser` 之前先请用户在插件页面连接，并在该命令第一次尝试时就申请 `sandbox_permissions`；dws 报告 CLI 访问未开启时，告诉用户需要组织管理员开启；两者不一致时以 DSH 指引为准。它的资源目录是 DSH 缓存中 skill 根目录下的 `dingtalk` 目录，因此 Agent 用文件工具而不是 `skill` 工具打开 `guides/<名字>/SKILL.md`，并以每个子指南自己的目录解析其中的相对路径和脚本。

#### Token 影响

每次加载都会把总入口正文加入保留的工具历史。子指南的 `SKILL.md`（4,000 到 21,000 个字符）及其引用的文件作为普通的文件读取输出返回。

#### KV Cache 影响

加载会追加一条工具结果，不会改写之前的上下文。

### Plugin CLIs 条目

#### 模型看到的内容

本行在私有 PATH 条目中声明了 `dws`，因此该行加载、且 Shell 在本 Host 上运行时，系统提示词中 [Shell 环境](../../shell/shell-env/README.zh.md#model-experience)的 Plugin CLIs 一节会列出 `` `dws` (dingtalk) ``。

#### Token 影响

该条目只给这一节增加几个 token；这一节本身的文字归 Shell 环境所有。

#### KV Cache 影响

加载或卸载该行会改变这一节的文字，provider 的缓存复用可能在第一个变化的 token 处结束。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS。固定的 Linux 归档未经验证，Windows 没有固定的归档。
- 插件要求本机 Host 上的 subprocess 运行时；当组合中的 subprocess 运行时在别处运行（例如通过 SSH）时，插件加载会失败。
- 插件使用 CLI 的默认配置。在 DSH 中登录或退出登录会影响用户自己的终端，以及这台电脑上其他运行 dws 的程序，没有 DSH 专用的账号，也没有账号选择。
- 从插件页面登录需要运行 DSH 的这台电脑上的浏览器，因为 CLI 的授权回调监听 `127.0.0.1`。
- 插件不设置 `DWS_CHANNEL`，在只允许已登记渠道访问 CLI 的组织中未经验证。
- 除非同时设置了 `binDir` 和 `skillsDir`，第一次检查需要能访问 GitHub 或 Gitee，成功之前没有 `dingtalk` skill；Gitee 镜像可能比 release 晚几天。下载源必须发送 `Content-Length`。
- dws 保留其默认的遥测和更新检查；DSH 指引要求 Agent 不要升级它。
- 在文件沙箱下，刷新令牌或写入 `~/.dws` 的普通命令可能被拒绝，此时需要单条命令审批。
- 移除插件或换到新版本后，已下载的资产和 skill 根目录仍会留在 Harness 缓存中。
- 子指南对应 release `v1.0.64`；更新版本需要修改固定的大小和摘要，再对照新的子指南检查总入口的索引和 DSH 指引。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

单元测试和 `dingtalk-skills` 会话快照通过 `binDir` 使用替身可执行文件，通过 `skillsDir` 使用替身技能；下载相关的测试从本地 HTTP 服务提供测试归档。技能测试固定了 16 个上游技能名称，因此更新版本时也要更新这份列表。

</details>
