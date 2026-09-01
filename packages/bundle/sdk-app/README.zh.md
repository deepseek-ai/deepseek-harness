---
description: "面向启动 JSON-RPC harness 运行时的用户与维护者，说明 SDK stdio 应用 profile。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-sdk-app`

[English](README.md) | 中文

## 概述

以 [`dsh-base`](../base/README.zh.md) 为基础的 SDK stdio 应用 `dsh` profile 组合包。它继承 base 默认禁用模块 HMR（热模块替换）的策略；其 patch 设置 coding agent（编程智能体）persona、挂载应用自有的零选项命令提供方，并且只在该提供方接受调用后启动 [`dsh-sdk-jsonrpc-server`](../../sdk/server/README.zh.md)。因此，`dsh --profile sdk --help` 会写出 help 并退出，不会占用 stdin 或 stdout。独立的 [`sdk-minimal`](../sdk-minimal/README.zh.md) bundle 复用同一个启动提供方，并提供自己的 profile 名称。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启动提供方把 stdin EOF 接到启动器的有界成功关闭流程。SDK 协议 `shutdown`、SIGINT 与 SIGTERM 继续使用各自所属的 server 或启动器路径；dispose（资源释放）会排空根 profile 配置树与持久化。stdout 专用于按换行分隔的 JSON-RPC 帧。SDK 不提供 title 表层，因此本组合包禁用模型生成的 session title；确定性的 fallback title 仍会持久化，但不发起辅助模型请求。继承的投影缓存会为 SDK 创建的会话写入检查点，供后续消费方使用；其持久性屏障会在发布缓存行前 flush 所覆盖的日志前缀，因此可能拆分原本会合并的 JSONL 行。部署通过 profile 组合包与 patch 文件选择另一套完整组合，而不是使用另一个应用 bin。

| 配置 | 默认值 | 行为 |
|---|---|---|
| `profile` | `sdk` | 命令帮助中显示的 profile 名称；挂载此提供方的 bundle 会设置自己的随附 profile 名称。 |

`DSH_MAX_TOKENS_AS_SUCCESS` 保留 SDK 部署映射：未设置或 JSON `true` 把 token 达限的 subagent 完成报告为已接受，JSON `false` 则报告为错误。模型提供方／模型与工作区 cwd 通过 SDK 初始化请求传入；base profile 拥有适配器、工具、持久化、策略、settings 与 credentials。

-----

<a id="model-experience"></a>
## 模型体验

### SDK coding agent persona

#### 模型看到什么

profile 会在 base 工具与上下文贡献之前提供 `You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`。确切的 SDK 初始化路由与会话 cwd 会解析其中的占位符。

#### Token 影响

一段简短稳定的 persona，加上随数据变化的 base 提示词段落与所选工具 schema。

#### KV Cache 影响

对固定 profile、提供方、模型与工具清单保持稳定。由于随附 SDK profile 使用仅启动时 patch，profile 变化会在下一个进程生效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **profile 可以省略 SDK server**：TypeScript client 选择的自定义 profile 必须保留本组合包或另一个 `dsh-sdk-jsonrpc-server` 配置项；没有 peer 响应时，client 初始化会失败。
- **用户插件可以破坏 stdout 纯净性**：profile 与逐次启动 patch 属于受信任应用组合。随附组合包不会向 stdout 写入非协议内容，但无法约束任意插入插件。
- **配置变化需要重启**：随附 `sdk` profile 使用 `patchReload: startup`，因此一个 stdio 连接不会观察到 server 或 Agent 依赖被替换。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。该 bundle 只增加进程传输与启动 latch；帧纯度、help 排除和关闭行为由源码及构建产物的 stdio 测试负责。
