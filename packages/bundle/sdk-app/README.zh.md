---
description: "面向启动 JSON-RPC harness 运行时的用户与维护者，说明 SDK stdio 应用 profile。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-sdk-app`

[English](README.md) | 中文

## 概述

以 [`dsh-base`](../base/README.zh.md) 为基础的 SDK stdio 应用 `dsh` profile 组合包。它继承 base 默认禁用模块 HMR（热模块替换）的策略；其 patch 挂载应用自有的零选项命令提供方，并且只在该提供方接受调用后启动 [`dsh-sdk-jsonrpc-server`](../../sdk/server/README.zh.md)。因此，`dsh --profile sdk --help` 会写出 help 并退出，不会占用 stdin 或 stdout。独立的 [`sdk-minimal`](../sdk-minimal/README.zh.md) bundle 复用同一个启动提供方，并提供自己的 profile 名称。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`sdk` profile 包含原生桌面工具和模型上下文。默认使用原生工具执行。需要 PTC 时，通过 `--patch` 或 TypeScript、Python SDK 的 `patches` 选项传入[执行器 overlay](../../../apps/cli/config/examples/ptc.yml)。`DSH_TOOLS_MODE` 不生效。

启动提供方把 stdin EOF 接到启动器的有界成功关闭流程。SDK 协议 `shutdown`、SIGINT 与 SIGTERM 继续使用各自所属的 server 或启动器路径；dispose（资源释放）会排空根 profile 配置树与持久化。stdout 专用于按换行分隔的 JSON-RPC 帧。SDK 不提供 title 表层，因此本组合包禁用模型生成的会话标题；确定性的 fallback title 仍会持久化，但不发起辅助模型请求。继承的投影缓存会为 SDK 创建的会话写入检查点，供后续消费方使用；其持久性屏障会在发布缓存行前 flush 所覆盖的日志前缀，因此可能拆分原本会合并的 JSONL 行。部署通过 profile 组合包与 patch 文件选择另一套完整组合，而不是使用另一个应用 bin。

| 配置 | 默认值 | 行为 |
|---|---|---|
| `profile` | `sdk` | 命令帮助中显示的 profile 名称；挂载此提供方的 bundle 会设置自己的随附 profile 名称。 |

`DSH_MAX_TOKENS_AS_SUCCESS` 保留 SDK 部署映射：未设置或 JSON `true` 把 token 达限的 subagent 完成报告为已接受，JSON `false` 则报告为错误。模型提供方／模型与工作区 cwd 通过 SDK 初始化请求传入；base profile 拥有适配器、工具、持久化、策略、settings 与 credentials。

SDK 使用 base 默认提供的 `read`、`write` 和 `edit`。要添加 `str_replace_editor`，请使用 [base 配置指南](../base/README.zh.md#use-this-package)中的显式插入 patch。独立的 `sdk-minimal` profile 自行决定其工具选择。

模型可以在 native 和 PTC 模式下使用 [`plugin_manager`](../../boot/plugin-manager/README.zh.md)。每个操作（包括列举）都要求完整权限或本次调用的批准。默认 workspace-write/ask 策略需要客户端审批应答方：启用 `approvalRequests`，并通过 `harness.client.onRequest()` 处理 `approval/request`，或在组合中提供审批器。没有应答方时，操作因 unavailable 被拒绝。Python 安装/移除包时，先显式调用 `download_primary_runtime()` 准备 Node 和 pnpm，再启动运行时；打包启动器会将它们提供给插件管理，无需系统 pnpm。未选择载荷时，包操作仍要求 `PATH` 中有 `pnpm`，或显式配置 `plugin-manager.pnpmCommand`。可运行的接入方式见[交互审批示例](../../../python/sdk/examples/manage_plugins.py)。保存的 profile 变更返回 `restart-required` 和 `no-hmr`；当前运行时及其会话保留原有工具，直到调用方关闭并重新启动运行时。通过 profile patch 设置 `tool-plugin-manager.disabled: true` 可隐藏此工具。独立的 `sdk-minimal` profile 不包含它。

Python 运行时向本 profile 提供显式下载的创作资源和 Office sidecar。`DSH_PRIMARY_RUNTIME` 覆盖创作载荷；空值禁用其查询。Office skills 可独立使用任一种资源。Profile patch 可独立于 `workspace-dependencies` 禁用 `skill-office` 或替换其 `assetRoot`；同名文件系统 skills 优先。下载与配置见[运行时包](../../../python/sdk-runtime/README.zh.md)。

-----

<a id="model-experience"></a>
## 模型体验

### SDK 模型上下文

#### 模型看到什么

profile 继承 base 系统提示词，包括 `You are an AI agent powered by DeepSeek Harness.` 身份说明，并添加与 Web 和 headless profile 相同、按当前模型插值的 coding persona。每个 Session 通过 [`dsh-working-directory`](../../session/working-directory/README.zh.md) 提供的必需 user-role 上下文接收当前目录。默认文件工具 schema 包含 `read`、`write` 和 `edit`，不包含 `str_replace_editor`。模型还会收到 `present`、`ask_user_question`、`plugin_manager`、定时任务工具、共用文件引用说明和时间上下文。子 agent 不能使用定时任务工具。[`time-context`](../../context/time-context/README.zh.md) 配置项接受回退时区。Skills 使用上述配置的资源。

#### Token 影响

此 profile 添加一句 coding persona、所挂载的工具定义与说明，以及记录在日志中的运行时上下文和时间消息。 即使操作无法获批，`plugin_manager` 的描述和参数 schema 仍增加输入 token；不使用插件管理的嵌入方可禁用该条目。

#### KV Cache 影响

启用 `plugin_manager` 会改变早期 SDK 版本的工具 schema 前缀。对固定 profile、提供方、模型与工具清单，静态前缀保持稳定。运行时值追加到已记录的 user 上下文中。由于随附 SDK profile 使用仅启动时 patch，profile 变化会在下一个进程生效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有图形客户端**：文件卡片、本地文件打开和浏览器状态需要嵌入客户端；SDK 不启动 Web server。
- **用户时区未知**：SDK 协议不携带用户时区，因此时间上下文显示 `Browser time zone for this request: unavailable.`。进程或容器的时区可能与用户时区不同。`time-context.timeZone` 配置只控制回退时间戳的显示格式，不能据此确定用户时区。自动检测和 SDK 时区传参暂缓支持。
- **提问需要回答方**：在 TypeScript 中配置 `onUserQuestion`、在 Python 中配置 `on_user_question`，或提供原生 `user-questions/request` handler；否则 `ask_user_question` 返回 `NO_PROVIDER`。
- **定时任务依赖运行时生命周期**：投递需要运行中的进程及其持久化 Session 存储。
- **profile 可能省略 SDK server**：TypeScript client 选择的自定义 profile 必须保留本组合包或另一个 `dsh-sdk-jsonrpc-server` 配置项；没有 peer 响应时，client 初始化会失败。
- **用户插件可以破坏 stdout 纯净性**：profile 与逐次启动 patch 属于受信任应用组合。随附组合包不会向 stdout 写入非协议内容，但无法约束任意插入插件。
- **插件变更共享 profile** — 保存的变更影响 `<DSH_HOME>/profiles/sdk`，以及使用同一 home 的其他嵌入方的下次启动；独立组合应使用不同的 `dshHome` 目录。Python 启动器使用所选下载运行时中的 Node/pnpm；没有该载荷或外部 pnpm 时，包操作会失败。
- **配置变化需要重启**：`sdk-app` 组合包在 YAML 中禁用 HMR，因此一个 stdio 连接不会观察到 server 或 agent 依赖被替换。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

[SDK/Desktop 工具比较](../../../apps/cli/tests/profiles/sdk/desktop-tools.expected.e2e.ts) 在 `test:expected` 中无需 API 凭据运行，并纳入 PR 必需的 consumer 作业。检查覆盖关闭 Team 的 standard/PTC 主会话；Team 对齐暂由 #7172 跟踪。构建后运行 `CI=true pnpm run test:expected apps/cli/tests/profiles/sdk/desktop-tools.expected.e2e.ts`。在相邻的 `tool-parity.ts` 中维护精确、带理由的差异；差异消除后，对应例外会使检查失败。已有 SDK 会话快照和安装后运行时 smoke 分别检查模型输出和打包结果。

</details>
