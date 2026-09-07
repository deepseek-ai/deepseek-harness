---
description: "通过 `/feedback` 命令记录自由文本会话反馈，供用户与维护者选择、组合或排查反馈采集。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-feedback

[English](README.md) | 中文

## 概述

`dsh-command-feedback` 让用户告诉 harness 他们对会话的看法：输入 `/feedback` 加一条评价，评价即被记录并得到确认。记录是即时的，绝不会启动模型工作，因此在对话的任何时刻都是安全的——模型既看不到这条评价，也不会被打断。确认文本会点名会话与匿名用户。命令随 Web 客户端交付，无需任何配置；无头模式、ACP（Agent Client Protocol）与 JSON-RPC 入口不提供斜杠命令，因此无法运行它。

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

用户可以直接在 Web 客户端中记录反馈：`/feedback` 命令随标准 `dsh` 基础组合交付，无需配置，可在任何对话中使用。自定义应用只需把命令注册表与本插件组合在一起，即可获得同样的命令。

### `/feedback` 命令

输入 `/feedback` 加你的评价并发送。成功时会以接收会话 id 与匿名用户 id 确认：

| 输入 | 结果 |
|---|---|
| `/feedback the diff view is unreadable` | 记录评价并以两行确认：`Feedback recorded for session {sessionId}` 和 `Anonymous user: {userId}.` |
| `/feedback` | 用法错误：`Feedback text is required. Usage: /feedback <text>`。仅含空白的输入视为空输入。 |

前后空白会被去除，但除此之外，评价会按输入原样保留：不进行截断、大小写折叠或命令解析——`/feedback /plan felt slow` 记录的就是这段字面文本。每次执行命令都会记录自己的条目；不会发生合并或替换。

### 从自己的 UI 记录反馈

反馈不一定来自斜杠命令：任何 UI、钩子或 host 集成都可以直接记录评价，享有同样的保证且无需模型轮次。想要斜杠命令的自定义应用，把命令注册表与本插件组合在一起即可：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-feedback
  name: '@deepseek-ai/dsh-command-feedback'
```

Web 客户端随附该命令。无头模式、ACP 自动化和 JSON-RPC 不提供斜杠命令，因此 `/feedback` 在那里不可用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

评价是会话日志中一个仅追加的事实，由事件而非产生它的命令拥有：反馈可能来自任何触发方式，因此事实绝不能依赖斜杠命令。命令自身的簿记不携带载荷，所以评价文本在日志中只存在于一个地方，且该事件绝不会浮出到模型。

### 评价如何被记录

生产方去除文本空白、拒绝空输入，并向会话日志写入一个事件；`/feedback` 处理器是该生产方的薄包装，不启动任何模型工作。写入是即时但未 flush 的：确认文本表示条目已到达日志，而不是已落盘。某个 harness home 首次接受的评价还会铸造确认文本所报告的匿名用户 id。精确的生产方约定与事件载荷见 [`src/index.ts`](src/index.ts)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`feedback/record` 事件声明、`recordFeedback` 生产方、`/feedback` 命令注册 |
| — | 不发布运行时不变式伴生入口；每个事件都是独立的仅追加事实。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们涵盖这条采集路径所依赖的命令注册表、持久化与身份事实。

- [dsh-commands](../../interaction/commands/README.zh.md)——发现全局命令并定义 `recordInput` 语义的注册表。
- [会话持久化子系统](../../../docs/subsystems/persistence.zh.md)——追加事件如何持久化、flush 屏障的含义。
- [匿名用户身份](../../identity/anonymous-user-id/README.zh.md)——确认文本报告的 id。
- [反馈包映射](../README.zh.md)——仅写入日志的采集与逐消息反馈并存的组。

-----

<a id="model-experience"></a>
## 模型体验

### 用户 `/feedback` 采集

#### 模型看到什么

无。斜杠输入、`feedback/record` 以及确认文本都不出现在模型请求中。反馈事件和注册表生命周期记录仅写入日志且不携带 `surfaceOp`，因此它们绝不会进入有序 surface、`deriveMessages()` 或系统提示词。在某个轮次中记录反馈不会改变该轮次剩余的请求。

#### Token 影响

无直接 token 影响。无论是已接受的条目还是用法错误，都不会在记录所在轮次或此后任何轮次增加模型 token。

#### KV Cache 影响

与模型请求路径无关。记录只追加到会话日志，不触碰已经可复用的请求前缀。本包贡献的任何内容都不会使缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 `/feedback` 何时不合适，或何时行为与用户预期不同。它们是当前包约束，不是任务积压。

- **没有反馈检索或管理 surface**——本包不为 `feedback/record` 提供检索、聚合、分类或面向模型的工具。
- **没有结构化字段**——一条条目就是一个自由文本字符串，没有类别、严重程度或关联事件链接，因此无法在不重读文本的情况下按主题过滤反馈。
- **不支持修改或撤回**——会话日志是仅追加的，本包也不新增 tombstone，因此错误的条目会一直保留在记录中，只能由后续条目取代。
- **没有显式持久化屏障**——确认文本紧随追加而非 flush，因此紧临崩溃前记录的条目可能与其他未 flush 的尾部一同丢失。需要该保证的消费方可自行等待 `ctx.sessions.flush(session)`。
- **新会话上没有可见的确认**——Web 转录只在会话激活后渲染命令行，因此在仍为空白的新会话上执行 `/feedback` 会记录事件但不会显示确认行。发送首条消息后再记录反馈即可正常渲染。
- **随附的产品入口中只有 Web 使用此命令**——无头模式、ACP 自动化和 JSON-RPC 不提供命令适配器，因此 `/feedback` 在那里不可用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。已交付的行为、限制与理由以上文与包代码为准。

- 确认文本句子由 [`tests/command-feedback.spec.ts`](tests/command-feedback.spec.ts) 固定；修改它们会改变用户可见文案。
- 结构化字段与检索 surface 仍是前两条限制背后的开放方向；当前约定没有为它们预留任何格式。

</details>
