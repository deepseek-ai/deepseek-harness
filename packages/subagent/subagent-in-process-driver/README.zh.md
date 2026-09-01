---
description: "共享进程内 subagent 运行驱动器，供维护者与后端作者理解或扩展 spawn 与 fork 的运行生命周期。"
kind: "package-library"
---

# @deepseek-ai/dsh-subagent-in-process-driver

[English](README.md) | 中文

## 概述

`dsh-subagent-in-process-driver` 是两个进程内 subagent 后端共用的运行驱动器：它通过宿主的 agent 工厂创建一个子 agent，应用按子 agent 的定制，把一项任务驱动到完成，并以单一完全停稳的 dispose（资源释放）路径返回子 agent 自身的最终输出。spawn 调用它时不传入会话初始内容；fork 调用它时传入父级已完成轮次的前缀。它是库而非独立功能：提供方后端调用 `startInProcessRun`，组合中没有任何东西配置它。阅读本页可理解两个进程内后端共享的运行生命周期。

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

你通过提供方后端而非组合到达本包：`dsh-subagent-spawn-in-process` 与 `dsh-subagent-fork-in-process` 各自调用 `startInProcessRun(request, options)` 并拥有其外围的一切。本页记录两者共享的生命周期，使你读懂一个后端的行为后即可推断另一个。

### 一次运行提供什么

一次调用启动并驱动一个一次性子 agent。调用兑现意味着子 agent 已发布到 `ctx.agents`，调用方拥有返回的运行；启动被拒绝时，未发布的创建已经完全停稳，因此不会有创建到一半的子 agent 存活。运行暴露子 agent 的 id 与在线 agent、一个 `result` promise，以及一个 `dispose()`——它会停止循环、移除 agent 与会话，并撤销作用域内的注册。

### 唯一输入

`InProcessRunOptions` 的形态为 `{ seed?: SessionEvent[] }`——fork 的已配平父级事件初始内容。spawn 省略该值；fork 提供已完成轮次前缀并记录其长度，使结果读取器不会把作为初始内容的父级消息误认为子 agent 输出。

### 子 agent 获得什么

子 agent 获得父级的工作目录/会话谱系，除非 `request.agentOptions` 覆盖，否则继承父级的提供方、模型、推理等级与输出 token 上限。它获得全新的扁平注册作用域：父级工具限制与权限不会被导入。一次运行会把父级显式的沙箱覆盖项与 `'never'` 审批钉定带入子 agent，并在子 agent 的初始轮次内追加一份按运行的描述符。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释驱动器的生命周期约定与结构化输出运行时；可观察行为已在[使用本包](#use-this-package)中说明。

### 启动约定

驱动器按以下顺序运行：

1. 校验父级深度与可选的绝对 `maxDepth`，然后把子级深度推导为父级深度加一，并持久化到子级会话 header。
2. 通过宿主 agent 工厂创建子 agent，并把调用方必需的信号传入创建事务。
3. 在该事务未发布的设置窗口内，安装请求的 persona、工具限制与结构化输出运行时。
4. 发布子 agent，保留返回的句柄，并驱动一项任务。
5. 从完整的自有运行中读取子 agent 自身的输出——最后一条非空 assistant 消息，若无则取其累积的 assistant 文本——以及最终持久化的轮次原因，并排除任何 fork 初始内容。

### 取消与所有权

必需的请求信号同时覆盖启动阶段与实时运行。发布前，创建事务会观察它、回滚并拒绝；驱动器在发布后再检查一次以消除交接竞态，然后安装最小化的实时运行监听器。兑现后，调用方拥有该运行：提供方插件卸载不会撤销它；`dispose()` 会移除中止监听器、记录取消，并委托给句柄经记忆化的完全停稳事务——后者停止循环、移除 agent 与会话，并撤销作用域内的注册。取消流程会接管所有尚未完成的进行中结果，并将其报告为 `aborted`；已经完成的轮次仍保持完成状态。

### 结构化输出

`attachStructuredRuntime(childCtx, schema)` 会在子 agent 作用域中安装完整约定：`structured_output` 工具按请求的 schema 校验并暂存模型值；位于末尾、first-party 顺序为 9900 的系统提示词段告诉子 agent 该工具调用就是终态答案；`tools/result` 观察器只在该次执行的权威最终工具结果成功后提交暂存值，包括 PTC mode 子分派外层的 `run_code` 结果；单调工具防护会在捕获后阻止后续调用。正常结束却始终未提交必需值的轮次会报告 `error`；驱动器不会重新提示。所有注册都附着于子 agent fiber，并随其一同消失。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 运行驱动器：创建、单轮驱动、结果读取、dispose |
| [`src/structured.ts`](src/structured.ts) | 结构化输出运行时：捕获工具、提示词段、防护、提交 |
| — | 不发布运行时不变式伴生入口；本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从共享 subagent 模型进入构建于本驱动器之上的后端，以及委派策略决策。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——启动请求、结果、提供方约定与进程内深度和初始内容。
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.zh.md)——构建于本驱动器之上的全新子级后端。
- [dsh-subagent-fork-in-process](../subagent-fork-in-process/README.zh.md)——构建于本驱动器之上的初始内容子级后端。
- [委派策略决策](../../../.agents/notes/implemented/feature/2026-07-25-subagent-policy-inheritance.zh.md)——父级沙箱与审批策略如何到达子 agent。

-----

<a id="model-experience"></a>
## 模型体验

### 子 agent 请求

#### 模型看到什么

共享驱动器把任务逐字作为子 agent 的用户消息发送；若有请求，还会在未发布子 agent 的全新作用域中遮蔽 persona，并限制全局工具 schema、查找、执行与 PTC mode SDK 绑定。父级限制不会被继承，独立的工具指导段仍会保留。spawn 不提供历史；fork 提供其已配平的初始内容。

#### Token 影响

子 agent 输入与父级隔离，并随子 agent 自身的步骤增长。persona 会改变重复提示词文本；过滤会改变 schema 或生成 SDK 的成本，但不影响独立注册的指导内容。

#### KV Cache 影响

与父级请求缓存相互独立。子 agent 后续历史仅追加，而 persona、工具过滤、生成 SDK、提供方或模型变化会建立不同的子 agent 前缀。

### 结构化输出系统提示词、schema 与结果

#### 模型看到什么

结构化运行会添加下方的结构化输出指令，并添加子 agent 作用域的 `structured_output` 定义，其参数使用请求的 schema，精确描述为 `Report your final structured result. Call this exactly once, when your answer is complete; the arguments must match this tool's parameter schema exactly.` 该仅运行时存在的定义不在已生成并随产品发布的[工具包索引](../../../docs/tool-catalog.zh.md#tool-package-map)中。其规范确认值是 `{ recorded: true }`，渲染为 `Structured output recorded.`；后续调用会变为 ``Error: structured output already recorded: the run is complete, so `<tool>` is not executed``。

##### 结构化输出指令

```markdown
When you have your final answer, you MUST report it by calling the `structured_output` tool with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only the tool call counts as your result.
```

#### Token 影响

固定指令与能力产生的 token 仅由该子 agent 承担。结果文本进入子 agent 历史，而只有捕获的值会成为父级结果。

#### KV Cache 影响

只要结构化输出指令与 schema 不变，子 agent 内部的前缀就保持稳定。更改 schema 或能力可能从该早期片段开始使子 agent 缓存失效；结果会分别追加到子 agent 与父级历史中。

### 父级启动错误（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，无效深度状态会精确变为 `Error: agent subagentDepth must be a non-negative safe integer`、`Error: subagent child depth exceeds the safe-integer range` 或 `Error: subagent depth <attempted> exceeds maxDepth <max>`。发布前取消的中止原因会通过注册表的 `Error: <message>` 包装传递。

#### Token 影响

启动成功时为零 token；只有失败的父级工具调用会保留这段文本。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 父级结果（间接）

#### 模型看到什么

驱动器只提取子 agent 自身最后的 assistant 输出或捕获的结构化值；作为初始内容的父级消息与子 agent 中间工作不会成为结果。

#### Token 影响

父级通过消费方接收一个依赖数据的结果；其他所有子 agent token 都留在子 agent 会话中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明进程内一次性运行不能做什么；它们是当前包约束。

- **运行不公开 `sendMessage`/`resume`**——进程内一次性运行不具备这些可选运行时能力。
- **结构化捕获只接受 `defineTool` schema 子集**——不支持的 JSON Schema 构造会在子 agent 创建前失败；需要更广 schema 词汇的提供方必须采用不同的运行时。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
