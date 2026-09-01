---
description: "worker-thread 工作流引擎：在宿主事件循环之外执行由模型编写的编排脚本，供选择或配置执行隔离的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-worker-thread

[English](README.md) | 中文

## 概述

`dsh-workflow-worker-thread` 以每次运行一个 Node worker thread 的方式实现工作流引擎：编排脚本在一个全新 worker 内执行，其 `agent()` 调用通过带类型的宿主／worker 协议触达宿主 subagent。同步脚本循环不会阻塞 harness 事件循环，忽略取消的脚本可以连同其 worker 一起终止。这种隔离只是 containment（隔离），不是安全边界——由模型编写的脚本与模型已有的 bash 访问具有相同的信任前提，逃逸 `node:vm` 上下文即可重新取得 worker 的进程权限。挂载本引擎即为 `ctx.workflowEngine` 提供具体实现；与 `dsh-tool-workflow` 一起加载的组合会把 `workflow` 工具交给模型。

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

当组合需要工作流能力时挂载本引擎：每个编排脚本都在独立 worker thread 中、宿主事件循环之外运行，已发布组合中的 `workflow` 与 `ralph` 工具都在其上执行。不要把它当作真正不可信脚本的沙箱——恶意代码需要独立进程或容器引擎。

### 最小配置

加载本引擎即注册 `ctx.workflowEngine`；在其上添加 `dsh-tool-workflow` 会把 `workflow` 工具交给模型。每个配置字段都是可选的：

```yaml
- name: '@deepseek-ai/dsh-workflow-worker-thread'
- name: '@deepseek-ai/dsh-tool-workflow'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `spawn` | `agent()` 调用使用的宿主侧 subagent 提供方。 |
| `maxConcurrentAgents` | `0` | 并发 `agent()` 上限；`0` 会根据可用 CPU 并行度解析。 |
| `maxTotalAgents` | `1000` | 一次运行最多启动的 `agent()` 调用总数——失控循环的后备闸。 |
| `maxItemsPerCall` | `4096` | 一次 `parallel()` 或 `pipeline()` 调用接受的条目数。 |
| `syncTimeoutMs` | `5000` | 脚本最初同步片段的 VM 超时时间，单位为毫秒。 |
| `disposeGraceMs` | `5000` | 强制结算与终止 worker 前的期限；同时约束 `dispose()`。 |

负责该引擎的消费方可以为一次运行设置 `WorkflowStartRequest.subagentProvider` 与 `WorkflowStartRequest.maxTotalAgents`——这是引擎级策略，不是脚本钩子；普通 `workflow` 工具两者都不设置，单次运行的子 agent 总数上限可以降低、但绝不能提高已配置的上限。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-workflow-worker-thread)是每个受支持字段的穷尽式真源。

### 运行会得到什么

运行启动后，脚本正文在 worker 中以顶层 `await` 执行，并可使用钩子 `agent()`、`parallel()`、`pipeline()`、`phase()` 与 `log()`；`meta` 与 `args` 以普通 JSON 数据到达，绝不作为代码求值。每次 `agent()` 调用都会在配置的提供方下启动一个宿主侧 subagent，并以运行的父级作为每个子 agent 的父级。运行以脚本的最终 JSON 值结算；普通子 agent 失败会把 `agent()` 兑现为 `null`，由脚本处理。

格式错误的 meta 块、无法解析的正文、不可用的提供方路由或高于上限的单次运行上限，都会在 worker 存在之前被同步拒绝，调用方因此看到违规清单并可以修正调用。执行期间，钩子误用与超出上限会用致命工作流错误终止脚本。取消是有界的：忽略取消的脚本会在 `disposeGraceMs` 后被强制以 cancelled 结算，其 worker 被终止。

### 信任预期

脚本的 CPU 工作与同步自旋不会占用宿主事件循环，`worker.terminate()` 为 dispose（资源释放）提供真实的最终停止手段，worker 以清理后的环境启动——只注入平台临时路径以及（源码模式下）`TSX_TSCONFIG_PATH`——因此环境凭据不会通过 `process.env` 跨越边界。宿主／worker 消息使用结构化克隆数据，并在脚本边界执行普通 JSON 校验。

以上都不是安全边界：有意不注入 timer、文件系统 API 或 Node 全局变量，但逃逸代码仍可以 worker 的进程权限触达 Node。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释引擎的隔离设计与运行机制；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

每次运行一个 worker thread，让行为异常的脚本无法拖垮宿主，并使强制终止成为可能：脚本在 worker 内可逃逸的 `node:vm` 上下文中运行，`agent()` 调用通过带类型的宿主／worker 协议回到 `ctx.subagents`。vm 上下文塑造脚本的 API 表面；它不是安全沙箱。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、前置校验、`start()` 接线 |
| [`src/host.ts`](src/host.ts) | 一次运行的宿主侧：worker 启动、子 agent 编排、结算、dispose |
| [`src/worker.ts`](src/worker.ts) | worker 入口：脚本执行、钩子实现、值物化 |
| [`src/runtime.ts`](src/runtime.ts) | 脚本运行时：钩子契约、`parallel()` 与 `pipeline()` 组合器 |
| [`src/realm.ts`](src/realm.ts) | 跨 realm 物化：普通 JSON 的接受与拒绝规则 |
| [`src/protocol.ts`](src/protocol.ts) | 带类型的宿主／worker 消息协议 |
| [`src/meta.ts`](src/meta.ts) | `meta` 形状校验与规范化 |
| [`src/session.ts`](src/session.ts) | 子 agent 运行在跨入 worker 前的投影与快照 |
| — | 不发布运行时不变式伴生入口；worker 测试覆盖该边界。 |

### 运行顺序

`start()` 在创建 worker 或发布 `workflow/start` 之前校验 meta 块、解析正文、解析提供方路由并解析单次运行的子 agent 总数上限。ready/go 握手可以避免启动信号取消与 worker 启动发生竞态、导致脚本最初的同步片段被执行；源代码模式通过 data URL bootstrap 安装 TypeScript 转换，构建模式则传入同级 `lib/worker.cjs` 包。

每次 `agent()` 调用，worker 都会发送 `child-start`；宿主通过 subagent seam 启动提供方（请求的覆盖值，或配置的提供方），把子 agent 归属于运行的父级，并回报启动成功或启动错误。提供方选择应用于该运行的每个子 agent，对脚本不可见。提供方启动与已发布子 agent 分开跟踪，因此当取消、worker 死亡或正常结算关闭接纳时，待处理启动会被共享信号中止。

### 值边界

离开脚本的值会经过 realm 物化；该过程接受普通无损 JSON 数据，拒绝特殊原型、函数、symbol、循环、稀疏数组、非有限数与嵌套 `undefined`。子 agent 结果在从宿主跨入 worker 之前先投影并快照——这是真正近似进程的序列化边界，刻意区别于同进程工作流事件以不可变方式借用的值。

### 取消与 dispose

`cancel()` 记录第一个原因、通知 worker 取消、中止所有待处理与已发布子 agent 共享的唯一信号，并启动 `disposeGraceMs` 定时器；worker 钩子随后在下次 await 时抛出 `CANCELLED`。如果运行到期限仍未结算，宿主会将其以 cancelled 兑现、为悬空的子 agent 生命周期事件配对，并终止 worker。

`dispose()` 是幂等的：它取消运行、立即启动宿主驱动的 dispose、在同一宽限期内等待结果与子 agent 完全停稳、无条件终止 worker，并执行最后一次幸存项扫描。每个子 agent 的 dispose 都会记忆化，使 worker RPC、宿主取消、死亡清理与公开 dispose 都汇入同一操作。

### 结果与事件保证

在宿主的认领点，终态结果遵循先到者胜：已接受的外部取消会覆盖后到的非取消 worker 结果，先认领的结果或 worker 死亡不能被可重入清理回调改写。worker 错误、消息失败或提前退出会在清理前关闭消息接纳，然后以 `error` 兑现；除非取消已接管该运行。

宿主维护已转发子 agent 启动的台账；优雅退出的 worker 提供对应的结束事件，死亡或强制终止则把缺失的结束事件合成为已取消——每个已转发的 `workflow/agent-start` 都会且只会配对一次。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当引擎级契约不够用时阅读以下页面。它们从 seam 契约逐步进入面向模型的消费方与设计决策。

- [工作流子系统](../../../docs/subsystems/workflow.zh.md)——本引擎实现的 seam 契约。
- [工作流 seam](../workflow/README.zh.md)——`ctx.workflowEngine` 背后的运行与结果词汇。
- [workflow 工具](../tool-workflow/README.zh.md)——在本引擎上运行脚本的模型侧消费方。
- [组地图](../README.zh.md)——工作流能力家族及其包。
- [动态工作流 Agent Note](../../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.zh.md)——seam 设计及其决策。

-----

<a id="model-experience"></a>
## 模型体验

### 子 agent 请求

#### 模型看到什么

脚本每次调用 `agent()`，都会把提示词原样发送给 subagent 提供方，并附带可选模型或结构化输出 schema。每个子 agent 看到该提供方自己的上下文；phase 与 log 叙述只留在观察器事件中。

#### Token 影响

可能需要为许多独立子 agent 上下文支付 token，数量受 `maxConcurrentAgents`、`maxTotalAgents` 与 `maxItemsPerCall` 限制；这些上下文绝不会直接加入父级历史。

#### KV Cache 影响

与父级请求缓存及同级子 agent 相互独立。每个子 agent 只能在其自身提供方、模型、提示词与 schema 下复用逐字节相同的前缀；其后续历史仅追加增长。

### 父级工具结果（间接）

#### 模型看到什么

通过 [`dsh-tool-workflow`](../tool-workflow/README.zh.md)，成功结果只会在该消费方的包装层中公开实体化的最终 JSON 值与子 agent 数量。本引擎提供稳定错误，包括 `workflow script does not parse: <error>`、`invalid meta: <violations>`、`agent() requires a non-empty prompt string`、`agent() could not start a child: <error>` 与 `child agent run failed: <error>`，以及其精确的 `parallel()`、`pipeline()`、`phase()`、选项、schema 与 JSON 边界校验消息。中间子 agent 输出可供脚本使用，但不提供给父模型。

#### Token 影响

本引擎不会直接向父级添加 token。最终结果大小由工具消费方限制，并保留到压缩（compaction）为止。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本引擎何时不合适，或何时需要特别的运维注意。它们是当前约束，不是任务积压。

- **worker 与 vm 不是安全边界**——模型编写的代码可以逃逸 `node:vm` 并取得 worker 的进程权限；不可信代码部署需要独立进程或容器引擎。
- **每次运行都要支付一个 worker thread**——没有池、预热运行时或跨运行脚本缓存。
- **不注入默认可用的定时器、文件系统或网络，但逃逸代码仍可触达 Node**——缺失的全局变量属于可移植性 API，而非隔离措施。
- **终止只能报告宿主观察到的启动**——`agentsStarted` 不包括因并发限制仍在 worker 侧排队、且在强制终止后无法得知的调用。
- **跨 realm 错误在脚本内无法通过 `instanceof Error`**——工作流作者必须根据 `name` 与 `code` 等稳定字段分支。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：实测产物与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码与相关 Agent Note 为准。

开放方向：用池化或预热运行时与跨运行脚本缓存来避免每次运行一个 worker；在同一 seam 背后为不可信脚本提供真正的进程或容器引擎。构建产物 `./worker` 入口以 CommonJS 包形式发布，因为 pkg 的虚拟文件系统（VFS）钩子要求 CommonJS；源代码模式通过 data URL bootstrap 安装 tsx 转换。

</details>
