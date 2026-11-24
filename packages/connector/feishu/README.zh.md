---
description: "把飞书插件加入 profile：带内嵌技能的官方 lark-cli，以及插件页上的飞书账号连接。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-feishu

[English](README.md) | 中文

## 概述

飞书插件让对话通过官方 `lark-cli` 使用飞书。它安装固定版本的 `@larksuite/cli`，下载缺失的 `lark-cli` 可执行文件，在运行时上下文中把这个可执行文件的绝对路径告诉模型，并注册一个 `feishu` skill，为该 CLI 内嵌的子指南提供索引。它把账号注册到 [连接器账号注册表](../../client/ui-connector-account/README.zh.md)，其插件页区块负责检查默认账号、通过 CLI 的浏览器流程关联应用并登录、退出登录以及取消操作。CLI 把凭据保存在默认配置中，用户自己的终端也共用这份配置。仅支持 macOS 和 Windows x64。

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
dsh plugin --profile web add @deepseek-ai/dsh-feishu
dsh plugin --profile web remove @deepseek-ai/dsh-feishu
```

pnpm 会拦截 `@larksuite/cli` 的安装脚本，该脚本负责下载并校验官方原生程序；请通过插件页的**允许这些脚本并重试**，或 [Plugin Manager](../../boot/plugin-manager/README.zh.md) 记录的其他方式批准。没有运行该脚本的安装（例如源码检出或 `link:` 安装）没有可执行文件；这时 `feishu` 行照常加载，并[自行下载](#cli-download)。

<a id="cli-download"></a>
### 下载缺失的 CLI

`feishu` 行加载时没有设置 `binDir`、且 `@larksuite/cli` 包中没有可执行的 `lark-cli` 时，该行会发起一次检查，检查先用运行 DSH 的 Node 运行该包的安装脚本。脚本用 `curl` 获取本机平台的发布压缩包，先从 GitHub、再从 npm 镜像，每个来源最多 120 秒，按包内 `checksums.txt` 校验 SHA-256，并把二进制复制到该包的 `bin` 目录。可执行文件就位之前，运行时上下文不给出 `lark-cli` 路径，目录中也没有 `feishu` skill。下载不需要浏览器；插件页把它显示为检查的一个步骤，并提供**取消**。没有完成的下载使账号处于 `not-installed`：页面提示没能下载 CLI 并提供**重试**；除非是被取消，Host 日志中有一条警告，带脚本的退出码和错误输出。下一次检查会重新下载。可执行文件就位之后，还没读到账号就失败的检查提示暂时无法确认登录状态，并提供**重试**，不再提下载。

### 获得的能力

`lark-cli` 就位后，一个 `feishu` skill 进入 skill 目录。agent 用 `skill` 工具加载它，用 `lark-cli skills read` 打开所需的子指南（例如 `lark-doc` 或 `lark-shared`），并在当前沙箱与审批策略下通过普通 Shell 工具按这个路径运行 `lark-cli`。命令报告缺少应用配置或登录时，agent 会请用户到插件页连接飞书；只有用户要求在对话中完成时，才按 CLI 自带的流程配置和登录。保存登录状态的命令会在工作区之外写入，因此会申请单条命令审批。

在 Plugin Manager 中关闭插件会撤下 `feishu` skill、运行时上下文中的路径和账号区块，CLI 配置、登录和已下载的可执行文件保持不变。

<a id="account-operations"></a>
### 账号操作

插件页通过 连接器账号注册表发起这些操作，注册表由 Web 应用加载；headless profile 加载插件时没有它。Host 同一时间最多运行一个账号操作并持有它，因此离开页面不会取消操作。关联应用和登录是两个独立操作，页面分别由各自的一次点击发起。只有 `lark-cli` 缺失时，加载该行才会发起一次检查。

| 操作 | 作用 |
|---|---|
| `check` | `lark-cli` 缺失时先下载，然后重新检查账号；没有操作运行时，每个打开 Web 应用的浏览器会触发一次 |
| `link-app` | 运行 `config init --new`，用用户新建或选择的应用替换 CLI 的默认配置，其中的登录和其他应用一并替换；不会登录。更换已关联的应用前会先询问 |
| `sign-in` | 为已关联的应用运行 `auth login --json`，并确认登录的是同一个用户 |
| `sign-out` | 用户确认后运行 `auth logout --json`，同时退出用户自己终端里的登录，然后重新检查 |
| 取消 | 在下载、应用配置或登录期间取消操作并等待其命令退出；其他步骤会被忽略 |

检查运行 `auth status --verify --json`。只有 CLI 报告用户可用且已被服务端核实时，账号才是 `connected`；用户缺失、未配置或需要刷新时为 `signed-out`；没有应用时为 `unconfigured`；其他情况为 `unverified`，例如核实时无法连到服务端。`connected`、`signed-out` 和 `unverified` 带有已配置的 `appId`。`config init` 打印的链接和 `auth login` 报告的设备授权链接，只有是 `feishu.cn` 或 `larksuite.com` 上的 HTTPS 地址时才会提供。登录后仍有申请的权限未被授予时（`auth login` 以退出码 3 结束并把它们列为缺失），登录仍算成功；之后需要这些权限的命令会报告缺少哪些。结果分为成功、已取消和失败。命令失败时，页面和 Host 日志显示命令名和观察到的退出码；原生消息、路径和授权数据均不保留。飞书网页显示成功不代表本地凭据已保存。运行 DSH 的进程需要能访问 CLI 配置和系统凭据存储；`DSH_HOME` 不会迁移这两者。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | 已安装 `@larksuite/cli` 包的 `bin` | 包含可执行 `lark-cli`（Windows 上为 `lark-cli.exe`）的绝对目录；设置后不再下载可执行文件，目录中没有它时该行加载失败，并给出缺失的路径 |

账号检查和退出登录使用 [`cli-account` 行](../cli-account/README.zh.md#use-this-package)的 `commandTimeoutMs`，默认 30 秒。应用配置和登录最多等待用户在浏览器中操作 10 分钟，每条命令最多保留 1 MiB 的 stdout；这两个上限由 CLI 账号 Service 固定。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-feishu)是受支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 profile 其他层之后把本包作为 `feishu` 行插入，插件页以本包名作为账号区块的 key。[`src/index.ts`](src/index.ts) 是一个函数插件。它把 `lark-cli` 的路径和账号注册到 `ctx.cliAccounts`，把下载缺失的 `lark-cli` 声明为这次注册的 [`prepare` 步骤](../cli-account/README.zh.md#prepare-before-a-check)，注册 skill 提供方，并在 `lark-cli` 缺失时发起一次检查，使没有浏览器的会话也能得到 CLI 和 skill；设置了 `binDir` 时，它要求加载时那里有可执行的 `lark-cli`（Windows 上为 `lark-cli.exe`）。[`src/cli.ts`](src/cli.ts) 定位 `lark-cli`，通过 `ctx.subprocess` 运行 `@larksuite/cli` 的安装脚本来下载缺失的可执行文件，并解析账号命令的 JSON 输出。脚本退出后可执行文件就位即为下载成功，与退出码无关，因为运行同一脚本的另一个进程可能已经把它放好。[CLI 账号 Service](../cli-account/README.zh.md) 在 `lark-cli` 已安装期间于运行时上下文中把这个路径告诉模型，在它缺失时于检查的第一条命令之前运行 `prepare` 步骤，按同一路径运行每条命令，一次执行一个账号操作，并以退出码报告失败的命令。[`src/account.ts`](src/account.ts) 用飞书的命令完成每个操作，并从命令输出行中读取配置与登录链接。[`src/presentation.ts`](src/presentation.ts) 用 [`src/locales.ts`](src/locales.ts) 中的文案，把每个视图映射为注册表提供的区块。释放时取消进行中的操作，中止正在运行的命令和下载，并在这些进程退出后完成。

[`skills/feishu/SKILL.md`](skills/feishu/SKILL.md) 是本包携带的唯一 skill：DSH 指引、`lark-cli` 1.0.97 内嵌的 28 个子指南的索引，以及打开它们的方法。[`src/skills.ts`](src/skills.ts) 在插件加载时读取一次入口，并把它作为 `feishu` 提供方的唯一 skill 列出，资源基址为 opaque 类型，因此目录列出入口、加载返回该文件时都不运行 CLI。它只在 `lark-cli` 已安装期间列出入口。目录会缓存列出的结果，因此在没有该入口时列出过之后，插件会在 `lark-cli` 就位后使目录失效一次。插件在每次下载尝试之后和每次账号操作之前检查这一点，因为被取消或失败的安装脚本可能已经复制了二进制，用户也可以在 DSH 之外运行该脚本。子指南留在二进制中，agent 用 `lark-cli skills read` 读取。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md)——这个应用插件所属的分组。
- [CLI 账号 Service](../cli-account/README.zh.md)——CLI 应用插件共用的命令执行、CLI 路径上下文与账号操作。
- [Skills](../../../docs/subsystems/skills.zh.md)——目录发布、加载与优先级。
- [连接器账号界面](../../client/ui-connector-account/README.zh.md)——发起账号操作的注册表和插件页区块。
- [Plugin Manager](../../boot/plugin-manager/README.zh.md)——安装、构建脚本审批与启用。

-----

<a id="model-experience"></a>
## 模型体验

### Skill 目录条目

#### 模型看到什么

`lark-cli` 已安装期间，skill 目录中出现一个 `feishu` 条目，描述见下方。

##### 目录描述

```markdown
Feishu (飞书) and Lark through the bundled lark-cli: documents and wiki, Base, sheets, slides, Drive files, messages and group chats, calendar, video meetings and minutes, tasks, approvals, mail, contacts, OKR, attendance, events, and the CLI's app setup and sign-in. Load it before any Feishu or Lark task; it indexes the guides and how to open them.
```

#### Token 影响

插件已加载且 `lark-cli` 已安装期间，该条目一直留在上下文中，约 350 个字符。

#### KV Cache 影响

该条目固定不变。加载或卸载插件、或目录列出之后 `lark-cli` 才安装好，都会改变目录，目录作为新消息重新发布，不改动更早的上下文。

### 已加载的 skill 正文

#### 模型看到什么

`feishu` 的 `skill` 工具结果约 6,700 个字符：DSH 指引、为 `lark-cli` 1.0.97 内嵌的 28 个子指南各给一行并附路由规则的索引，以及打开子指南的方法。DSH 指引告诉 agent 按当前运行时上下文给出的绝对路径运行 `lark-cli`，在自己运行 CLI 的配置与登录流程之前先请用户到插件页连接飞书，并为保存登录状态的命令设置最窄的 `sandbox_permissions`。打开说明告诉 agent 子指南不是 skill，子指南及其引用的文件都用 `lark-cli skills read` 读取。其资源描述为 `Embedded lark-cli guides; open them with the skills read command given in the loaded skill.`

#### Token 影响

每次加载把入口正文加入保留的工具历史。agent 通过 `lark-cli` 读取的子指南及其引用文件作为普通 Shell 输出返回。

#### KV Cache 影响

加载会追加一条工具结果，不改写更早的上下文。

### CLI 路径

#### 模型看到什么

该行已加载且 `lark-cli` 已安装期间，[CLI 账号 Service](../cli-account/README.zh.md#model-experience) 添加一条必需的运行时上下文，给出 `binDir` 中 `lark-cli` 的路径；`binDir` 默认是已安装的 `@larksuite/cli` 包的 `bin` 目录。

##### 运行时上下文条目

```markdown
Feishu CLI: run `lark-cli` by its absolute path "<binDir>/lark-cli"; the bare name may resolve to another installation or to none.
```

##### Windows 上的运行时上下文条目

```markdown
Feishu CLI: run `lark-cli` by its absolute path with the call operator, & '<binDir>\lark-cli.exe'; the bare name may resolve to another installation or to none.
```

#### Token 影响

每份运行时上下文快照中一行，约 110 个字符加上路径。

#### KV Cache 影响

系统提示词不变；下载完成、加载或卸载该行、或路径变化时，追加一份运行时上下文快照。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS 和 Windows x64；其他平台未经验证。
- 命令必须在本 Host 上运行。组合把命令放到别处运行（例如通过 SSH）时，插件仍会加载，但每条运行 `lark-cli` 的命令都会因为那里没有这个路径而失败。
- 插件使用 CLI 的默认配置。在 DSH 中登录或退出会影响用户自己的终端，没有 DSH 私有账号或账号选择器。插件不提供解绑操作；关闭插件会保留配置与登录。
- 登录从 `lark-cli auth login --json` 的事件中读取设备授权链接和完成结果；CLI 版本改变这些事件时，连接以可重试的结果失败。
- 入口的子指南索引对应 `lark-cli` 1.0.97；固定到另一个 `@larksuite/cli` 版本时，需要对照该版本的 `lark-cli skills list` 检查索引。
- 在文件沙箱下，普通命令中的 token 刷新可能被拒绝，此时需要单条命令审批。
- 没有运行 `@larksuite/cli` 安装脚本的安装，在第一次检查时需要 `curl`、`tar`（Windows 上为 PowerShell），以及到 GitHub 或 npm 镜像的网络；下载成功之前没有 `feishu` skill 和 CLI 路径。插件已加载期间用户在 DSH 之外安装 `lark-cli` 时，运行时上下文会先于目录给出它的路径，`feishu` skill 要到下一次账号操作（例如插件页的**重试**）才进入目录。页面不显示进度。进程在下载期间退出（例如一次性的 headless 运行）会停止下载，下一个进程重新开始。这样停止或被取消的下载，会把脚本的 `lark-cli-*` 目录（连同未下完的归档）留在系统临时目录中。
- 安装脚本把二进制复制到该包的 `bin` 目录时不经过重命名。进程在复制期间被停止可能留下不完整的文件，而它会被当作已安装；删除这个 `bin` 目录后，下一次检查会重新下载。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

仓库安装在根目录 `pnpm-workspace.yaml` 中拒绝 `@larksuite/cli` 的安装脚本，因此检出的仓库没有原生二进制，直到插件第一次在没有 `binDir` 的情况下加载，并把它下载到 `packages/connector/feishu/node_modules/@larksuite/cli/bin`。单测与 `feishu-skills` 会话快照通过 `binDir` 使用替身可执行文件；下载的单测替换了可执行文件检查和子进程运行时，因此既不运行脚本，也不向该包写入。

</details>
