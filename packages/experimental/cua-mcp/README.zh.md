---
description: "通过 cua-mcp profile 以 stdio 向 Codex、Claude Code 等 MCP 客户端提供 Computer Use。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-cua-mcp

[English](README.md) | 中文

## 概述

这个实验性组合包独立组成 `cua-mcp` profile，即 Computer Use 的 MCP stdio 服务器。每个 DSH 安装都自带它；首次 `dsh --profile cua-mcp` 初始化组合包声明的 profile，并向一个 MCP 客户端提供 `cua_run_code` 与 `cua_reset`。该 profile 只由本组合包构成：不加载任何模型适配器、提示侧工具或遥测行。一个连接拥有一个 Agent，其程序在多次调用之间于内存中保留应用与窗口对象。应用与指针访问的授权可无人值守放行，或作为 elicitation 转发给客户端；模型归接入的 harness 所有。

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

组合包是 `dsh` 安装的运行时依赖，并通过 `dsh.bundle.profile` 声明 `cua-mcp` profile，因此首次 `dsh --profile cua-mcp` 就用这一个组合包层初始化 `$DSH_HOME/profiles/cua-mcp`；不涉及 pnpm、网络或任何 `dsh plugin` 步骤。源码 checkout 在 `pnpm run build` 之后通过 `pnpm dsh` 运行同样的命令。Python runtime wheel 自带同一份安装，训练 harness 直接把它的可执行程序用作 stdio 命令：

```python
from deepseek_harness_runtime import resolve_bundled_launch_args

command = [*resolve_bundled_launch_args(), "--profile", "cua-mcp"]  # the MCP stdio command; the first start initializes the profile
```

### 接入客户端

`dsh --profile cua-mcp` 就是 stdio 命令，`--help` 打印它自己的帮助。客户端配置项以绝对路径指向安装的 `dsh` 可执行程序，传入 `--profile cua-mcp`，在服务器应使用非默认 Harness home 时设置 `DSH_HOME`，并用 `DSH_CUA_CONSENT` 设置授权模式；源码检出在 `pnpm run build` 之后以 `node` 为命令、`<checkout>/apps/cli/lib/bin.js` 为首个参数。Codex 在 `~/.codex/config.toml` 中加入：

```toml
[mcp_servers.dsh_cua]
command = "/absolute/path/to/dsh"
args = ["--profile", "cua-mcp"]
env = { DSH_HOME = "/absolute/path/to/dsh-home", DSH_CUA_CONSENT = "elicit" }
startup_timeout_sec = 120
tool_timeout_sec = 600
enabled_tools = ["cua_run_code", "cua_reset"]
omit_tools_from = ["code_mode", "deferred"]

[mcp_servers.dsh_cua.tools.cua_run_code]
output_token_limit = 25000
```

`startup_timeout_sec = 120` 留给首次 helper 准备，`tool_timeout_sec = 600` 对齐默认程序上限，`enabled_tools` 配合 `omit_tools_from` 让两个工具直接暴露而不进入工具搜索，`output_token_limit` 把 `cua_run_code` 的输出预算提高到 25,000 token。Claude Code 以十分钟工具超时注册同一配置项：

```sh
claude mcp add-json dsh_cua '{"type":"stdio","command":"/absolute/path/to/dsh","args":["--profile","cua-mcp"],"env":{"DSH_HOME":"/absolute/path/to/dsh-home","DSH_CUA_CONSENT":"elicit"},"timeout":600000,"alwaysLoad":true}'
```

其他客户端在 `mcpServers` 下使用同样的 `command`、`args` 与 `env`。Codex 只有在 `approval_policy.granular.mcp_elicitations = true` 时才转发 elicitation。DSH 自己的 `dsh-mcp-client` 未声明 elicitation 能力，Claude Code 2.1 的 print 模式会拒绝 elicitation，因此经这两类客户端的无人值守运行需要 `DSH_CUA_CONSENT=allow`。

在 macOS 上，profile 首次启动时准备已签名的 Computer Use helper，并需要为其授予辅助功能与屏幕录制权限；[macOS 提供方](../cua-macos/README.zh.md)负责这部分设置。本 profile 没有权限页面，因此要在「系统设置 → 隐私与安全性」中添加 helper 应用来授予这两项权限：源码检出在 macOS 提供方包的 `native/.build/prepared/<arch>/<build>/` 目录下准备 `DSH Computer Use Dev.app`，其中 `current.json` 记录当前选中的构建；已安装的包附带 `DSH Computer Use.app`。两项权限都授予之前，`await cua.getCapabilities()` 会报告缺失的标志，应用操作会失败；桌面处于锁定状态时这些操作以 `SESSION_LOCKED` 失败。在其他 Host 上 profile 没有提供方也能启动，两个工具都返回指出缺少提供方的错误。

### 你会得到什么

`cua_run_code` 就是该 Agent 的 DSH 注册项以 MCP 工具的形式提供：每次 `tools/list` 都从工具注册表读取它的名称、描述和参数 schema，因此提供方的定义是唯一来源，`description` 按该定义必填，`timeoutMs` 限制单个程序。投影省略注册项中的沙箱提权字段 `sandbox_permissions` 与 `justification`，指定它们的调用在执行前被拒绝；其余参数原样交给 DSH 工具执行器，由它校验参数并回答未知名称，因此非法调用返回 DSH 的错误结果。程序作为 TypeScript REPL 语句在提供方保留的 Node 环境中对全局 `cua` 对象运行。结果以文本携带程序打印的行和最终表达式，随后把程序捕获的每张截图以内联图片附上，且图片正是程序观察到的那一版，因此文本中的像素坐标与图片一致。一个连接的首个结果以 `cua` API 参考开头；执行规则在工具描述里。同一连接的程序按到达顺序逐个运行；取消调用会取消其程序。

`cua_reset` 丢弃程序环境：变量、导入以及应用或窗口对象。应用授权、本机连接和应用本身保留；下一个程序在新进程中启动，其结果重复 API 参考。在声明冲突或环境不可用之后使用它。

连接的 Agent 在 stdio 传输打开之前创建，因此首次列表就带有它的注册项；客户端关闭 stdin 时销毁，进程随之退出。应用授权按该 Agent 遵循 [CUA 授权规则](../cua/README.zh.md)：`DSH_CUA_CONSENT=allow` 在无人值守下为本会话放行每个请求；默认的 `elicit` 把请求作为表单 elicitation 转发给客户端，答案即 CUA 的选项标签；被拒绝的表单为本会话记录一次拒绝，不支持 elicitation 的客户端会收到指明 `allow` 模式的错误。

-----

<a id="configuration"></a>
## 配置

在 profile 的 `cordis.patch.yml` 中配置 `cua-mcp` 行；组合包 patch 把 `DSH_CUA_CONSENT` 映射到它。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `consent` | `elicit` | `allow` 在无人值守下为本会话放行应用与指针授权；`elicit` 把每个请求转发给 MCP 客户端。 |

patch 还以 `screenshotTarget: { longEdge: 2048, maxBytes: 2097152 }` 挂载提供方，因为这里没有模型路由来选择请求图片；并以 `agentPreset: ptc` 搭配空的 `cua-mcp` preset，使连接的 Agent 只获得 `cua_run_code` 而没有其他面向模型的行。可在 profile patch 中按 id 覆盖这些行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[patch](cordis.patch.yml) 在空根上组成整个 profile：带 JSONL 持久化与投影的会话、附件、保存应用授权的存储、程序进程所依赖的子进程、沙箱、审批与文件系统 seam、带原生执行器的工具、系统提示、用户提问、不挂适配器的 llm hub、带 agent-loop 工厂的 Agent 注册表、带空默认 preset 的 preset 注册表、`computer-use` 注册表、在非 Darwin 上禁用的 macOS 提供方行，以及本前端。`dsh.bundle.profile` 声明 `cua-mcp` profile，app-boot 在首次启动时用这一个组合包初始化它。前端用 `parseCmdline` 解析调用，把 stdin EOF 绑定到启动器的有界关闭，并在启动器提交就绪后把官方 MCP 服务器连接到 stdio 传输。`cua-mcp` 是启动必需条目，前端无法激活时 profile 停止启动。

[`server.ts`](src/server.ts) 通过协议服务器的低层 `tools/list` 与 `tools/call` handler 提供两个工具：列表把该 Agent 的 `cua_run_code` 注册项按协议的工具类型校验后投影出来，与手写的 `cua_reset` 并列。连接的 Agent 挂载注册表的默认 preset 并记录启动目录。`cua_run_code` 调用在 `ctx.agents.withInitiator` 内带着 Agent 和请求 signal、不经模型步骤地通过 `ctx.tools.execute` 运行，因此 Session 日志只有嵌套的 `tool/ptc-dispatch` 事件而没有根 `tool/call`；[`projection.ts`](src/projection.ts) 渲染结果及其延后的截图上下文，并通过 `ctx.cuaPrograms.screenshotRequestTarget` 读取每张图片。`cua_reset` 调用 `ctx.cuaPrograms.reset`。[`consent.ts`](src/consent.ts) 是该 Agent 的 `user-questions/request` 应答者。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [共享 CUA 包](../cua/README.zh.md) — 对象 API、授权规则与 `cua_run_code`。
- [macOS 提供方](../cua-macos/README.zh.md) — helper 准备、权限与平台指引。
- [计算机操作](../../../docs/subsystems/computer-use.zh.md)与 [MCP](../../../docs/subsystems/mcp.zh.md) — 子系统参考。
- [profile 组合](../../boot/app-boot/README.zh.md) — 组合包层与 patch 生命周期。
- [决策记录](../../../.agents/notes/implemented/architecture/2026-11-09-computer-use-mcp-server.zh.md) — 服务器为何运行在 profile 内并为每个连接持有一个 Agent。

-----

<a id="model-experience"></a>
## 模型体验

### 外部 harness 的模型

#### 模型看到什么

接入 harness 的模型通过 `tools/list` 和 `initialize` 看到该 Agent 的 `cua_run_code` 定义、`cua_reset` 与服务器说明。一个连接的首个 `cua_run_code` 结果，以及 `cua_reset` 之后的首个结果，以提供方注册的 `cua` API 参考开头；之后的结果只携带程序输出与捕获的截图。该 profile 中不存在 DSH 模型请求。

#### Token 影响

工具描述携带注册项 2,200 个字符的执行规则；首个结果每个连接或每次重置增加 API 参考，使用当前 macOS 提供方时约 13,000 个字符，按仓库四字符/token 估算约 3,300 token。截图是提供方 `screenshotTarget` 尺寸的内联图片。客户端会限制工具输出；生成的 Codex 配置把 `cua_run_code` 的预算提高到 25,000 token。客户端同样限制工具描述：Claude Code 2.1.309 只转发 MCP 工具描述的前 4,096 个字符并追加 `… [truncated]`；DSH 的 `dsh-mcp-client` 原样转发 20,000 个字符的描述。注册项的描述在该预算之内；参考超出预算，因此随首个结果传递。

#### KV Cache 影响

工具目录和说明对同一安装保持稳定。首个结果的参考文本只随已安装的 CUA 包变化。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 只有 macOS Host 有提供方；Windows 提供方就位后在此挂载。其他 Host 只列出 `cua_reset`：调用 `cua_run_code` 以 `unknown tool` 失败，`cua_reset` 指出缺少提供方。
- Elicitation 使用 2025 版 MCP 请求模型；协商到 2026-07-28 修订版的客户端在授权请求时收到错误，应改用 `DSH_CUA_CONSENT=allow`。
- 不暴露程序沙箱提权和原始 `cua` 工具；`DSH_PERMISSION_MODE` 选择程序进程启动时的文件沙箱。
- 提供方描述超过 4,096 个字符时，Claude Code 2.1.309 的模型只看到被截断的部分；投影不会缩短它。
- 根工具调用不是 Session 事件；接入 harness 的 transcript 才是调用与结果的记录。
- patch 显式列出该 profile 的依赖闭包；CUA 或 PTC 包新增服务注入时，必需启动条目会大声失败，直到 patch 补上该行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
