---
description: "通过 cua-mcp profile 以 stdio 向 Codex、Claude Code 等 MCP 客户端提供 Computer Use。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-cua-mcp

[English](README.md) | 中文

## 概述

这个实验性组合包独立组成 `cua-mcp` profile，即 Computer Use 的 MCP stdio 服务器。每个 DSH 安装都自带它；只选本组合包的 profile manifest 就能让 `dsh --profile cua-mcp` 向一个 MCP 客户端提供 `cua_get_api_reference`、`cua_run_code` 与 `cua_reset`。该 profile 只由本组合包构成：不加载任何模型适配器、提示侧工具或遥测行。一个连接拥有一个 Agent，其程序在多次调用之间于内存中保留应用与窗口对象。应用与指针访问的授权可无人值守放行，或作为 elicitation 转发给客户端；模型归接入的 harness 所有。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 启动服务器

组合包是 `dsh` 安装的运行时依赖，因此只选它这一层的 profile 直接从安装中加载它；不涉及 pnpm、registry 或网络。在 Harness home（`$DSH_HOME`，默认 `~/.dsh`）下创建一次 profile，之后 `dsh --profile cua-mcp` 就是 stdio 命令，源码检出在 `pnpm run build` 之后通过 `pnpm dsh` 运行它。不要把组合包加进已经组合了 `dsh-base` 的 profile（例如 `dsh plugin --profile cua-mcp add` 创建的那种）：两套组合声明同样的行 id，Web 插件页也因此隐藏本组合包，而 Host 清单仍把它报告为可选组合包。

```sh
mkdir -p "${DSH_HOME:-$HOME/.dsh}/profiles/cua-mcp"
printf '%s\n' '{ "name": "dsh-profile-cua-mcp", "private": true, "dependencies": {}, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-cua-mcp"] } } }' > "${DSH_HOME:-$HOME/.dsh}/profiles/cua-mcp/package.json"
```

Python runtime wheel 自带同一份安装：在 harness 以 `DSH_HOME` 传入的 home 下写入同样的 manifest，然后把它的可执行程序用作 stdio 命令：

```python
from deepseek_harness_runtime import resolve_bundled_launch_args

command = [*resolve_bundled_launch_args(), "--profile", "cua-mcp"]  # the MCP stdio command
```

### 接入客户端

`dsh --profile cua-mcp` 就是 stdio 命令，`--help` 打印它自己的帮助。客户端配置项以绝对路径指向安装的 `dsh` 可执行程序，传入 `--profile cua-mcp`，在服务器应使用非默认 Harness home 时设置 `DSH_HOME`，用 `DSH_CUA_CONSENT` 设置授权模式，并在程序应工作于默认工作区之外的目录时设置 `DSH_CUA_WORKSPACE`；源码检出在 `pnpm run build` 之后以 `node` 为命令、`<checkout>/apps/cli/lib/bin.js` 为首个参数。Codex 在 `~/.codex/config.toml` 中加入：

```toml
[mcp_servers.dsh_cua]
command = "/absolute/path/to/dsh"
args = ["--profile", "cua-mcp"]
env = { DSH_HOME = "/absolute/path/to/dsh-home", DSH_CUA_CONSENT = "elicit" }
required = true
startup_timeout_sec = 120
tool_timeout_sec = 600
enabled_tools = ["cua_get_api_reference", "cua_run_code", "cua_reset"]
omit_tools_from = ["code_mode", "deferred"]

[mcp_servers.dsh_cua.tools.cua_run_code]
output_token_limit = 25000
```

`required = true` 让 Codex 在首个模型请求之前等待服务器就绪，并在服务器无法启动时结束会话；不设置时 Codex 只等待 `mcp_optional_startup_grace_ms`（默认一秒），首个请求可能不带这三个工具。`startup_timeout_sec = 120` 限定这段等待并留给首次 helper 准备，`tool_timeout_sec = 600` 对齐默认程序上限，`enabled_tools` 配合 `omit_tools_from` 让三个工具直接暴露而不进入工具搜索，`output_token_limit` 把 `cua_run_code` 的输出预算提高到 25,000 token。

`codex exec` 以审批策略 `never` 运行，此时 Codex 会拒绝 `cua_run_code`（本服务器唯一标注为 destructive 与 open-world 的工具），错误为 `MCP tool call requires approval, but approval policy is never`（在 codex-cli 0.153.2 上观察到）。因此无人值守运行要在 `cua_run_code` 表中加入 `approval_mode = "approve"`，并设置 `DSH_CUA_CONSENT = "allow"`。

Claude Code 以十分钟工具超时注册同一配置项：

```sh
claude mcp add-json dsh_cua '{"type":"stdio","command":"/absolute/path/to/dsh","args":["--profile","cua-mcp"],"env":{"DSH_HOME":"/absolute/path/to/dsh-home","DSH_CUA_CONSENT":"elicit"},"timeout":600000,"alwaysLoad":true}'
```

其他客户端在 `mcpServers` 下使用同样的 `command`、`args` 与 `env`。Claude Code、`dsh-mcp-client` 与 Codex 三条配置都经真实 macOS 桌面验证，其中 Codex 是在 codex-cli 0.153.2 与 0.166.0-alpha.5.1 上通过 `codex exec` 并以 `DSH_CUA_CONSENT=allow` 验证的；没有客户端经本 profile 操作过 Windows 桌面。Codex 的交互式审批提示及其 elicitation 转发未在此实测；按 Codex 配置参考，截至 2026-11-11，Codex 只有在 `approval_policy.granular.mcp_elicitations = true` 时才转发 elicitation。DSH 自己的 `dsh-mcp-client` 未声明 elicitation 能力，Claude Code 2.1 的 print 模式会拒绝 elicitation，因此经这两类客户端的无人值守运行需要 `DSH_CUA_CONSENT=allow`。

按名称放行工具的客户端必须放行全部三个：缺少 `cua_get_api_reference` 时，它的模型拿不到 `cua` API 参考。服务器使用的 Harness home 不要与采用未压缩 Session 日志的 profile 共用：本 profile 在 `sessions` 下写入 zstd 压缩的日志，设置了 `compression: none` 的 profile（例如 `sdk-minimal`）在含有这些日志的目录上查询 Session 会失败。

在 macOS 上，profile 首次启动时准备已签名的 Computer Use helper，并需要为其授予辅助功能与屏幕录制权限；[macOS 提供方](../cua-macos/README.zh.md)负责这部分设置。本 profile 没有权限页面，因此要在「系统设置 → 隐私与安全性」中添加 helper 应用来授予这两项权限：源码检出在 macOS 提供方包的 `native/.build/prepared/<arch>/<build>/` 目录下准备 `DSH Computer Use Dev.app`，其中 `current.json` 记录当前选中的构建；已安装的包附带 `DSH Computer Use.app`。两项权限都授予之前，`await cua.getCapabilities()` 会报告缺失的标志，应用操作会失败；桌面处于锁定状态时这些操作以 `SESSION_LOCKED` 失败。

在原生 Windows 上，profile 挂载 [Windows 提供方](../cua-windows/README.zh.md)，helper 的准备由它负责：源码检出用 PATH 上的 .NET 10 SDK 构建 helper；npm 安装不附带 helper。此时要在 profile 的 `cordis.patch.yml` 中用 `cua-mcp-provider-windows` 行的 `helperPath` 指明 helper：即 `dsh-cua-windows.exe` 的绝对路径，x64 取自解压后的独立 ZIP，ARM64 取自对应架构的构建。patch 会替换该行的整个 config，因此要重述组合包的字段：

```yaml
- id: cua-mcp-provider-windows
  config:
    agentPreset: ptc
    screenshotTarget:
      longEdge: 2048
      maxBytes: 2097152
    helperPath: 'C:\absolute\path\to\dsh-cua-windows.exe'
```

该提供方不启动应用，也不提供 `Always allow` 授权：程序选中应用之前要先打开它，在 `elicit` 模式下每个连接都会重新询问授权。profile 不在 WSL 下挂载它。

在其他 Host 上 profile 没有提供方也能启动：列表有 `cua_get_api_reference` 与 `cua_reset`，二者都返回指出缺少提供方的错误，调用 `cua_run_code` 以 `unknown tool` 失败。提供方行无法激活时（例如 Windows 行缺少 helper）列表相同，启动器会在 stderr 上指出失败原因。

### 你会得到什么

`cua_get_api_reference` 返回 `cua` API 参考：提供方为连接的 Agent 注册的指引，包含每个方法的签名与操作规则，也就是 DSH 模型在系统提示中收到的那段文本。它不带参数，不运行程序，也不触碰桌面和程序环境，因此程序运行期间同样可以应答。服务器说明要求模型在每次对话开始时调用它；它的描述要求在参考已不在模型上下文中、或程序因未知的 `cua` 方法失败时再调用一次。

`cua_run_code` 就是该 Agent 的 DSH 注册项以 MCP 工具的形式提供：每次 `tools/list` 都从工具注册表读取它的名称、描述和参数 schema，因此提供方的定义是唯一来源，`description` 按该定义必填，`timeoutMs` 限制单个程序。投影省略注册项中的沙箱提权字段 `sandbox_permissions` 与 `justification`，指定它们的调用在执行前被拒绝；其余参数原样交给 DSH 工具执行器，由它校验参数并回答未知名称，因此非法调用返回 DSH 的错误结果。程序作为 TypeScript REPL 语句在提供方保留的 Node 环境中对全局 `cua` 对象运行。结果携带程序传给 `inspect(...)` 的内容：文本成为文本块，每张被 inspect 的截图成为内联图片，且图片正是程序观察到的那一版，因此文本中的像素坐标与图片一致；没有 inspect 任何值的程序返回一条完成提示。执行规则在工具描述里。程序在工作区中启动，同一连接的程序按到达顺序逐个运行；取消调用会取消其程序。失败的调用返回 DSH 的失败信息并设置 `isError`，不带 DSH 的 `Error:` 前缀。

`cua_reset` 只丢弃程序环境。程序进程结束，因此其中的变量、导入以及应用和窗口对象都不复存在；仍在运行的 `cua_run_code` 程序被取消，reset 在该程序返回之后才返回。连接的 Agent 连同其本机连接和授权决定都保留：本会话已放行的应用不会再次询问，已拒绝的应用保持拒绝，已保存的授权和 helper 的系统权限不受影响。下一个程序在新进程中启动，拥有新的 `cua` 对象，并通过 `cua.getApp` 重新选择应用；reset 期间到达的程序在它之后运行。进程清理失败的 reset 返回错误，此后程序会失败，直到后续的 `cua_reset` 成功。在环境不可用之后，或不希望保留的状态带入下一个任务时使用它。

连接的 Agent 在 stdio 传输打开之前创建于工作区中，因此首次列表就带有它的注册项；客户端关闭 stdin 时销毁，进程随之退出。工作区是 `DSH_CUA_WORKSPACE`，变量未设置时为 Harness home 下的 `cua-mcp/workspace`；profile 会创建它，程序在其中启动，默认的 `workspace-write` 沙箱允许程序写入的也是这个目录，与客户端从哪个目录启动服务器无关。应用授权按该 Agent 遵循 [CUA 授权规则](../cua/README.zh.md)：`DSH_CUA_CONSENT=allow` 在无人值守下为本会话放行每个请求；默认的 `elicit` 把请求作为表单 elicitation 转发给客户端，答案即 CUA 的选项标签；被拒绝的表单为本会话记录一次拒绝，不支持 elicitation 的客户端会收到指明 `allow` 模式的错误。

-----

<a id="configuration"></a>
## 配置

在 profile 的 `cordis.patch.yml` 中配置 `cua-mcp` 行；组合包 patch 把 `DSH_CUA_CONSENT` 与 `DSH_CUA_WORKSPACE` 映射到它。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `consent` | `elicit` | `allow` 在无人值守下为本会话放行应用与指针授权；`elicit` 把每个请求转发给 MCP 客户端。 |
| `workspace` | Harness home 下的 `cua-mcp/workspace` | 连接的 Agent 工作所在的绝对目录。程序在其中启动，它也是程序的 `workspace-write` 根。启动时在目录不存在时创建它；路径为相对路径或目录无法创建时，在 stderr 报告并以退出码 1 结束。 |

patch 还以 `screenshotTarget: { longEdge: 2048, maxBytes: 2097152 }` 挂载该 Host 的原生提供方（macOS 上是 `cua-mcp-provider` 行，原生 Windows 上是 `cua-mcp-provider-windows` 行），因为这里没有模型路由来选择请求图片；并以 `agentPreset: ptc` 搭配空的 `cua-mcp` preset，使连接的 Agent 只获得 `cua_run_code` 而没有其他面向模型的行。可在 profile patch 中按 id 覆盖这些行；覆盖会替换该行的整个 config，因此要重述需要保留的字段。`sandbox-policy` 行的 `workspaceRoot` 与 `workspace` 解析为同一目录；程序的根是其 Agent 的工作目录，因此该字段只作用于没有 Session 的调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[patch](cordis.patch.yml) 在空根上组成整个 profile：带 JSONL 持久化与投影的会话、附件、保存应用授权的存储、程序进程所依赖的子进程、沙箱、审批与文件系统 seam、带原生执行器的工具、系统提示、用户提问、不挂适配器的 llm hub、带 agent-loop 工厂的 Agent 注册表、带空默认 preset 的 preset 注册表、`computer-use` 注册表、每种 Host 一行的原生提供方（Darwin 上是 macOS，原生 Windows 上是 Windows），以及本前端。只列出本组合包的 profile manifest 选中这套组合；启动器不经模板直接从安装中加载它。前端用 `parseCmdline` 解析调用，把 stdin EOF 绑定到启动器的有界关闭，并在启动器提交就绪后创建工作区、把官方 MCP 服务器连接到 stdio 传输。`cua-mcp` 不是启动必需条目：行无法激活时启动器在 stderr 上报告，而不是停止 profile。

[`server.ts`](src/server.ts) 通过协议服务器的低层 `tools/list` 与 `tools/call` handler 提供三个工具：列表把该 Agent 的 `cua_run_code` 注册项按协议的工具类型校验后投影出来，排在该文件定义的两个工具之间。连接的 Agent 挂载注册表的默认 preset，并把工作区记录为自己的工作目录，沙箱策略据此解析其程序的 `workspace-write` 根。`cua_get_api_reference` 通过 `ctx.systemPrompt.assemble` 读取提供方为该 Agent 注册的提示段，不保存任何状态。`cua_run_code` 调用在 `ctx.agents.withInitiator` 内带着 Agent 和请求 signal、不经模型步骤地通过 `ctx.tools.execute` 运行，因此 Session 日志只有嵌套的 `tool/ptc-dispatch` 事件而没有根 `tool/call`；[`projection.ts`](src/projection.ts) 渲染结果及其延后的截图上下文，并通过 `ctx.cuaPrograms.screenshotRequestTarget` 读取每张图片。`cua_reset` 用 `agent.cancel` 取消该 Agent 正在运行的程序，调用 `ctx.cuaPrograms.release`，由提供方的程序运行时释放该 state owner 的环境，并在 Agent 空闲后返回；同一时刻只进行一次释放，程序调用会等待它，因为前一个进程尚在退出时运行时会拒绝程序。[`consent.ts`](src/consent.ts) 是该 Agent 的 `user-questions/request` 应答者。`cua_run_code` 调用作为该 Agent 的维护活动运行，因此 Agent 在调用进行中被销毁时会取消该调用，等它及其嵌套调用结算之后才释放本机连接并关闭 Session。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [共享 CUA 包](../cua/README.zh.md) — 对象 API、授权规则与 `cua_run_code`。
- [macOS 提供方](../cua-macos/README.zh.md) — helper 准备、权限与平台指引。
- [Windows 提供方](../cua-windows/README.zh.md) — helper 设置、交互规则与平台限制。
- [计算机操作](../../../docs/subsystems/computer-use.zh.md)与 [MCP](../../../docs/subsystems/mcp.zh.md) — 子系统参考。
- [profile 组合](../../boot/app-boot/README.zh.md) — 组合包层与 patch 生命周期。
- [决策记录](../../../.agents/notes/implemented/architecture/2026-11-09-computer-use-mcp-server.zh.md) — 服务器为何运行在 profile 内并为每个连接持有一个 Agent。

-----

<a id="model-experience"></a>
## 模型体验

### 外部 harness 的模型

#### 模型看到什么

接入 harness 的模型通过 `tools/list` 和 `initialize` 看到 `cua_get_api_reference`、该 Agent 的 `cua_run_code` 定义、`cua_reset` 与服务器说明。提供方注册的 `cua` API 参考作为 `cua_get_api_reference` 调用的结果进入其上下文，服务器说明要求每次对话开始时调用它；`cua_run_code` 的结果只携带程序输出与被 inspect 的截图。该 profile 中不存在 DSH 模型请求。

#### Token 影响

工具描述携带注册项的执行规则，约 3,200 个字符；一次 `cua_get_api_reference` 的结果就是 API 参考，使用当前 macOS 提供方时约 13,000 个字符，按仓库四字符/token 估算约 3,300 token，每次调用支付一次。截图是提供方 `screenshotTarget` 尺寸的内联图片。客户端会限制工具输出；文档给出的 Codex 配置把 `cua_run_code` 的预算提高到 25,000 token。客户端同样限制工具描述和服务器说明：Claude Code 2.1.309 对二者都只转发前 4,096 个字符并追加 `… [truncated]`；DSH 的 `dsh-mcp-client` 原样转发 20,000 个字符的描述。注册项的描述和约 500 个字符的服务器说明都在该预算之内；参考超出预算，因此作为工具结果传递。

#### KV Cache 影响

工具目录和说明对同一安装保持稳定。参考文本只随已安装的 CUA 包变化，并作为普通的工具结果进入对话。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- macOS 与原生 Windows Host 有提供方。其他 Host（包括 WSL）列出 `cua_get_api_reference` 与 `cua_reset`，二者都指出缺少提供方；调用 `cua_run_code` 以 `unknown tool` 失败。
- 在 Windows 上，[提供方的限制](../cua-windows/README.zh.md#known-limitations-and-deferred-work)经 MCP 同样适用：它不启动应用，不提供 `Always allow` 授权，npm 安装需要配置 `helperPath`。
- Elicitation 使用 2025 版 MCP 请求模型；协商到 2026-07-28 修订版的客户端在授权请求时收到错误，应改用 `DSH_CUA_CONSENT=allow`。
- 不暴露程序沙箱提权和原始 `cua` 工具；`DSH_PERMISSION_MODE` 选择程序进程启动时的文件沙箱，工作区是它的 `workspace-write` 根。
- `cua` API 参考只有在模型调用 `cua_get_api_reference` 时才到达模型。服务器观察不到既有连接上的新对话，也观察不到上下文压缩，因此由服务器说明和工具描述提出这一要求；不放行该工具的客户端，其模型只有执行规则可用。
- 服务器不限制结果文本的大小。程序 inspect 一个很大的值时会原样返回全部内容，上限是程序运行时 64 MiB 的输出限制，只有客户端自己的输出上限能保护其上下文。
- 注册项的描述仍带有 PTC 的沙箱提权说明（"A sandbox escalation approves this complete program …"）；按它请求提权的程序会在执行前被拒绝，并被告知 `DSH_PERMISSION_MODE` 决定沙箱。
- 提供方描述超过 4,096 个字符时，Claude Code 2.1.309 的模型只看到被截断的部分；投影不会缩短它。
- 根工具调用不是 Session 事件；接入 harness 的 transcript 才是调用与结果的记录。
- patch 显式列出该 profile 的依赖闭包；CUA 或 PTC 包新增服务注入时，提供方行无法激活并在 stderr 上报告，列表里没有 `cua_run_code`，直到 patch 补上该行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
