---
description: "面向交互式组合的按需 /compact 命令：它做什么、你会看到什么，以及如何挂载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-compact

[English](README.md) | 中文

## 概述

`dsh-command-compact` 为聊天 UI 添加 `/compact` 命令：输入它，对话就会按需压缩——即使尚未触发自动压力，较早历史也会被替换为一条摘要。该命令适用于任何压缩后端，且不消耗模型轮次；完成后你会看到压缩了多少历史项以及估算节省的 token 数。当 agent 正在轮次中或压缩已在运行时，它会告诉你压缩暂不可用。运行期间你发送的提示词会保持排队，并在压缩结束后才开始。

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

当对话已经很长、想立即压缩时，在聊天 UI 中输入 `/compact`。随附 `dsh` 基础配置把该命令挂载在默认后端旁，因此它通常已经可用。

### 使用命令

| 输入 | 结果 |
|---|---|
| `/compact` | 即使未达到自动压力，也压缩一段有效、平衡的较早范围，然后报告被替换的历史项数量与估算 token 数。 |
| `/compact`，但没有可压缩历史 | `No compactable history yet.`——不会有任何改变。 |
| `/compact <anything>` | `Usage: /compact (no arguments)`——该命令不接受参数。 |

### 你会看到什么

命令会把每个预期失败转换为可直接展示的稳定消息；左列的情形产生右列的消息。

| 情形 | 你看到的消息 |
|---|---|
| 压缩已在运行，或 agent 正在轮次中 | `Compaction is unavailable because this process has an active compaction, or the agent is not idle.` |
| 压缩过程中历史发生了变化 | `The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.` |
| 无法产生有用的摘要 | `Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.` |
| 压缩未干净地完成 | `Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.` |
| 会话无法保存 | `Compaction finished, but the session could not be saved.` |

取消命令会停止等待：后端完成必需的清理，命令以 `Compaction cancelled.` 结算，UI 停止等待。除这些预期情形外的失败会以错误形式呈现，而不会被静默转换。

### 组合命令

挂载命令注册表、一个压缩后端与本插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
```

随附 `dsh` 基础配置把它挂载在默认后端旁，Web 客户端提供命令适配器。未组合命令适配器的自动化接口只保留自动压缩。

### 对话会发生什么

命令成功时，所选较早范围会被替换为一条摘要，近期历史不受影响；命令会报告压缩的项目数与估算 token 数。压缩运行期间你提交的提示词会被接受，并只在压缩结束后才开始——不会被丢失或重排。命令生命周期记录在会话日志中，但绝不进入模型历史。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该命令建立在三项承诺之上：

- **与后端无关的控制。** 处理器只依赖 `compactNow(agent, signal)`，因此可与任何 `CompactionEngine` 实现协作。调用该命令的 agent（智能体）就是操作的确切目标，发起分发的 UI 会通过 seam 转发取消信号。
- **命令生命周期不进入模型历史。** `command/run` 与 `command/done` 都是仅日志事件；`sourceEventSeq` 将成功结果与 `compaction/summary` 事件关联，不依赖文本或行相邻关系。
- **安静地销毁。** 生命周期 effect 会先注销 `/compact`，再等待已开始处理器结算，因此已中止命令的闭合与 flush 工作在根级销毁完成前安定下来。

### 生命周期与关联

每次完成的调用都会记录执行器所属的仅日志事件对 `command/run` / `command/done`；两者都不进入模型历史。成功时，`command/done.sourceEventSeq` 会指明该事务的 `compaction/summary` 事件，让呈现层无须解析结果文本或假定两行相邻，即可将命令生命周期归并到对应检查点中。busy 结果有意限定在进程范围内：活动的未匹配标记会阻塞，而早于最新 `session/end-seed` 的标记已陈旧，不会阻塞。插件会跟踪每个真实处理器 promise，并在排空已开始处理器之前注销 `/compact`，因此根级 teardown 不会越过已中止命令的闭合或 flush 边界。压缩运行期间提交的提示词仍会按 agent 的普通 FIFO 获得接纳，并且只在压缩的显式持久性检查点和接纳预留释放后启动；空闲注入的上下文可以位于 `compaction/start` 与 `compaction/end` 之间，并在检查点之后保持可见。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`/compact` 注册、参数拒绝、错误码映射、生命周期排空 |
| — | 不发布运行时不变式伴生入口；压缩 seam 与命令注册表拥有持久约定。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从命令逐步进入 seam、随附后端与设计决策。

- [压缩 seam](../compaction/README.zh.md)——本命令触发的压缩约定。
- [压缩基础后端](../compaction-basic/README.zh.md)——自动与按需压缩的随附后端。
- [命令包](../../interaction/commands/README.zh.md)——聊天命令背后的注册表与分发约定。
- [压缩子系统参考](../../../docs/subsystems/compaction.zh.md)——压缩词汇、结果与服务行为。
- [排队手动压缩 Agent Note](../../../.agents/notes/implemented/feature/2026-07-30-queued-manual-compaction.zh.md)——按需压缩如何与运行中的轮次串行化。

-----

<a id="model-experience"></a>
## 模型体验

### 人类 `/compact` 控制

#### 模型看到的内容

斜杠输入与直接结果绝不会进入模型请求。已获接纳的压缩会另外在独立的 `compaction/* { turn: null }` 标记对内，用后端的 user 角色检查点替换一段较早范围。

#### Token 影响

命令生命周期不会增加模型 token。成功压缩会用一份带框架的摘要替换所选范围，从而减少后续请求；摘要生成本身需要一次辅助请求。

#### KV Cache 影响

命令发现与簿记不会影响缓存。已获接纳的 surface 替换会从第一个被遮蔽的历史 token 起使复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该命令何时不合适；它们是当前包约束。

- **仅限空闲状态**——当轮次或已获接纳的唤醒提示词拥有优先权时，`/compact` 会报告压缩暂不可用；命令本身不会排队。
- **不接受范围或策略参数**——无参数形式使各命令适配器的行为保持稳定。显式范围仍由编程接口 `compactRegion()` 处理。
- **仅限命令适配器**——没有 `ctx.commands` 的接口无法调用该命令，只能依赖自动压力压缩。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性；已交付行为以上文、包代码与所链接的 Agent Note 为准。

- **命令排队，尚未决定**——轮次拥有优先权时提交的 `/compact` 会报告 `busy`；将请求排队而非拒绝仍是开放方向。
- **范围与策略参数，尚未决定**——无参数形式的稳定性是有意的；增加参数需要在每个命令适配器间共享语法。

</details>
