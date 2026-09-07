---
description: "面向启动持久 harness agent 的用户与维护者，说明纯自动化 ACP stdio 应用 profile。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-acp-app`

[English](README.md) | 中文

## 概述

以 [`dsh-base`](../base/README.zh.md) 为基础的 automation-only ACP stdio 应用 `dsh` profile 组合包。它继承 base 默认禁用模块 HMR（热模块替换）的策略；其 patch 设置 coding agent（编程智能体）persona 与默认模型路由、挂载应用自有的零选项命令提供方，并且只在该提供方接受调用后启动 [`dsh-acp`](../../acp/acp/README.zh.md)。因此，`dsh --profile acp --help` 会写出 help 并退出，不会占用 stdin 或 stdout。

## 目录

- [使用本包](#use-this-package)
- [标准自动化工作流](#standard-automation-workflow)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启动提供方把 stdin EOF 绑定到启动器的有界成功关闭。ACP 连接关闭、SIGINT 与 SIGTERM 会在退出前排空 bridge 自有 agent 以及根 profile 树。Stdout 仅保留给换行分隔的 ACP JSON-RPC frame。ACP 不提供 title 表层，因此本组合包禁用模型生成的 session title；确定性的 fallback title 仍会持久化，但不发起辅助模型请求。继承的投影缓存会为 ACP 创建的会话写入检查点，供后续消费方使用；其持久性屏障会在发布缓存行前 flush 所覆盖的日志前缀，因此可能拆分原本会合并的 JSONL 行。部署方通过 profile 组合包与 patch 文件选择另一套完整组合，而不是使用另一个 app bin。

随附配置项使用 `deepseek-official` 与 `deepseek-v4-flash` 创建 session；后续 patch 可以替换该配置项的完整 config。base profile 负责适配器、工具、持久化、策略、settings 与 credentials；ACP client 为每个 session 提供工作区。

-----

<a id="standard-automation-workflow"></a>
## 标准自动化工作流

ACP v1 SDK 客户端先初始化 `dsh --profile acp`，再用绝对 `cwd` 与可选的标准 stdio／HTTP MCP 声明创建 session，选择公开的 `model` 或 `reasoning_effort`，在观察标准语义更新的同时提交提示词，最后调用 `session/close`。另一个进程可以针对同一个 profile 持久化根目录使用 `session/list` 与 `session/resume`；resume 会重新连接该请求提供的 MCP 声明，但不会重放历史。

完整的受支持方法矩阵、MCP 信任模型、更新映射与停止原因见 [`dsh-acp` 协议约定](../../acp/acp/README.zh.md#standard-acp-v1-surface)。该 profile 不增加私有方法、能力、`_meta`、环境变量或传输字段。免密钥控制面一致性测试通过公开 ACP SDK 驱动真实 profile。

<a id="model-experience"></a>
## 模型体验

### ACP coding-agent persona

#### 模型看到什么

profile 在第一方指导之前提供 `You are a coding agent powered by the {{model}} model.`，并在独立的 persona 后缀中提供 `Your working directory is {{cwd}}.`。ACP 配置项的路由与每个 `session/new` 的 cwd 会解析其中的占位符。

#### Token 影响

一段简短稳定的 persona，加上随数据变化的 base prompt section 与已选工具 schema。

#### KV Cache 影响

固定 profile、提供方、模型与工具集合下保持稳定。随附 ACP profile 只在启动时加载 patch，因此 profile 更改会在下一个进程生效。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

- **profile 可以省略 ACP bridge**：自定义 ACP 启动 profile 必须保留本组合包或另一个 `dsh-acp` 配置项；否则没有 peer 响应 client。
- **用户插件可能破坏 stdout 纯净性**：profile 与单次启动 patch 属于受信任的应用组合。随附组合包不会向 stdout 写入非协议内容，但无法约束任意插入的插件。
- **配置更改需要重启**：随附 `acp` profile 使用 `patchReload: startup`，确保一条 stdio 连接不会观察到 bridge 或 Agent 依赖被替换。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。该 bundle 只增加进程传输与启动 latch；帧纯度、help 排除和关闭行为由源码及构建产物的 stdio 测试负责。
