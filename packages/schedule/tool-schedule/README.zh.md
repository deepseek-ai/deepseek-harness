---
description: "预设作用域的定时任务工具（schedule_create、schedule_list、schedule_view、schedule_edit），基于宿主 ctx.schedule 服务，供选择哪些 agent 可以管理定时任务的部署使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-schedule

[English](README.md) | 中文

## 概述

使用 `dsh-tool-schedule`，可通过 `schedule_create`、`schedule_list`、`schedule_view` 与 `schedule_edit` 让 agent（智能体）创建、列出、查看、更新和删除宿主定时任务。定时任务在其重复规则的每个发生时点把指令投递到一个目标 Session。本包把四个工具注册进挂载它的 preset 或 Agent 作用域；`minimal` 不获得。任务属于宿主：这些工具按 id 读取和改变任意任务，只有投递目标指定 Session。存储、调度与投递由宿主 `@deepseek-ai/dsh-schedule` 服务负责。失败时返回一个结构化错误码。

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

当某个 preset 的 agent 需要管理定时任务时，把下面这一行加入该 preset 的插件列表。随产品发布的 Web `standard`、`cordis` 与 `ptc` preset 会挂载它；`minimal` 不会。

### 何时选用

当 preset 的 agent 需要安排未来工作时选用它，并在同一进程内加载 `@deepseek-ai/dsh-schedule`：本包只是该服务面向模型的消费方。需要保持能力精简的 preset——随产品发布的例子是 `minimal`——会省略该行，其 agent 完全看不到 Schedule 工具。

### 用户授权

共享的 `tool:schedule` system prompt 段落要求创建或修改任务时获得用户明确授权。用户此前为当前运行的定时任务明确授予的授权继续有效，例如在监控的 PR 合并后暂停该任务。

### 四个工具

- `schedule_create(title, prompt, rrule, target)` —— 创建一个任务，四项输入均为必填。`title` 不超过 120 个字符，使用用户的语言命名动作与对象；时间、状态和 id 保留在各自字段中。`prompt` 是每个发生时点投递的指令，`rrule` 是 [Schedule 所支持的 RFC 5545 子集](../../../docs/subsystems/schedule.zh.md#rrule-input)中的一行 `DTSTART` 与一行 `RRULE`。返回任务及其生成的 id。
- `schedule_list(active?, limit?, offset?)` —— 列出宿主全部任务中的一页，包括其他 Session 创建的任务。活动任务按下一个发生时点排在前面，暂停与已结束的任务随后，按最新时间在前。`active: true` 只保留活动任务，`active: false` 只保留暂停与已结束的任务；`limit` 取 1 到 500，默认 100。
- `schedule_view(id)` —— 按 id 读取一个任务。未知 id 返回 `{ id, code: 'schedule_not_found' }`。
- `schedule_edit(id, action, ...)` —— `update` 至少改变 `title`、`prompt`、`rrule`、`target` 与 `active` 中的一项；`active: false` 暂停任务，`active: true` 恢复任务。恢复需要未来发生时点；旧规则耗尽时须提供新的 `rrule`。带有 `expectedUpdatedAt` 时，如果任务在那次读取之后发生过改变，更新或删除返回 `schedule_conflict` 且不做任何改变。`delete` 不接受任何补丁字段，并移除任务及其已保存的投递。

`target` 选择接收每次投递的 Session：`this_session` 投递到调用方 Session，`new_once` 在首次投递时创建一个 Session 并在之后复用它，`new` 为每次投递创建一个 Session。编辑时省略该字段可保留目的地与设置。提供该字段会替换目的地；`new_once` 预留另一个 Session，两种新建目标都会保存编辑者的工作目录与组合后的 preset。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-tool-schedule'
```

本包不声明任何 `Config` 字段。它注入 `ctx.tools` 和 `ctx.systemPrompt`，并在作用域解析到宿主 `ctx.schedule` 服务后注册这四个工具及其共享指导，因此保持该服务关闭的组合不会挂载任何 Schedule 工具。每次调用都代表派发该调用的 Agent 执行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

插件在解析到 `ctx.schedule` 的作用域内注册四个 `defineTool` 定义与一个 `tool:schedule` system prompt 段落，因此由 preset 挂载决定可见性，并由 Cordis effect 的所有权随挂载一并释放。当请求作用域中的 `ctx.tools.get()` 既看不到 `schedule_create` 也看不到 `schedule_edit` 时，该段落为空；preset 过滤了这些工具的委派作用域也包括在内。此查询同时适用于 Native 与 PTC 呈现方式。执行时读取 `exec.agent` 作为执行操作的 Session。委派深度守卫先运行，`schedule_edit` 的参数校验随后运行，二者都在服务调用之前完成。当工具的输出 schema 声明了某个 `ScheduleInputError` 的错误码时，该错误保留其错误码；其他任何失败都变为 `internal_error`，因此存储细节不会到达模型。模型内容为返回值的规范 JSON，而持久化、调度、Session 恢复与投递都由宿主服务负责。

### 源码映射

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：四个工具、共享指导、输出 schema、目标解析，以及 render/present 辅助函数 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Schedule 服务](../schedule/README.zh.md) —— 这些工具所管理的宿主任务存储、运行时与投递行为。
- [Schedule 分组映射](../README.zh.md) —— 本组内的同级包。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-schedule) —— 模型接收的确切四个 schema。
- [Schedule 子系统](../../../docs/subsystems/schedule.zh.md) —— `ctx.schedule` 的 Cordis 接线区域与存储类型。
- [Schedule 用户指南](../../../docs/user/guide/schedule.zh.md) —— 面向用户的定时任务工作流。

-----

<a id="model-experience"></a>
## 模型体验

### 共享 system prompt

#### What the model sees

当 `schedule_create` 或 `schedule_edit` 在调用方 Agent 的作用域内可见时，模型收到一个 `tool:schedule` 段落。工具说明保留各自的操作指导，不再重复这条规则。`complete: true` 的 system prompt 覆盖会替换普通段落，本段落也包括在内。

##### 任务授权

```markdown
Only create or modify scheduled tasks at the user's explicit request; prior explicit user authorization for the running scheduled task remains valid.
```

#### Token effect

Native 和 PTC 模式下，每次组装 prompt 只加入一句固定文本。同时隐藏两个修改工具的作用域不承担本段落的开销。

#### KV Cache effect

段落文本与修改工具可见性不变时，前缀保持稳定。挂载、释放或过滤都可能使从该段落开始的复用失效。

### 工具 schema

#### What the model sees

只要本包在调用方 Agent 的作用域内可见，模型就会收到生成的 [`schedule_create`、`schedule_list`、`schedule_view` 与 `schedule_edit` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-schedule)。目录展示默认配置；当 `new` 投递的配置间隔超过一分钟时，`schedule_create` 的 `target` 描述会加上该间隔。

#### Token effect

凡是 preset 挂载了本包的 Agent，其每次请求都有固定的 schema 开销。省略该行的 preset 下的 Agent 不付出任何开销。

#### KV Cache effect

只要工具定义与可见性不变，前缀保持稳定。挂载、释放或作用域变化都可能使从首个变化 schema token 起的复用失效。

### 任务结果

#### What the model sees

每次调用返回一个规范 JSON 文本块。`schedule_create` 返回任务；`schedule_list` 返回 `{ items, shown, total, limit, offset }`；`schedule_view` 返回任务或 `{ id, code: 'schedule_not_found' }`；`schedule_edit` 返回更新的任务、`{ id, deleted: true }`、`{ id, code: 'schedule_not_found' }` 或 `{ id, code: 'schedule_conflict' }`。任务结果用 `kind` 区分七种时间类型，并保留权威时间字段。结果包含 `id`、`title`、`prompt`、`scheduledAt`、`scheduledAtLocal`、`target`、`status`，可选的 `updatedAt` 用于版本比较；可选的 `lastDelivery` 包含 `scheduledAt`、`deliveredAt` 与 `targetSessionId`。模型输入继续暴露 RRULE；拒绝调用返回带已声明输出错误码的 `{ code, message }`。

#### Token effect

结果会留在调用方 Session 的历史中直到压缩，并重复任务摘要；一页 `schedule_list` 结果最多包含 `limit` 个任务，在之后每次请求中都付出其全部渲染长度。

#### KV Cache effect

只追加；新可见内容跟在可复用的请求前缀之后，不会使既有 KV Cache 条目失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **没有宿主服务就没有工具** —— 在缺少 `ctx.schedule` 的组合中挂载本包会让插件保持挂起，四个工具都不会注册。
- **每次调用都需要调用方 Agent** —— 未携带 Agent 的派发返回 `internal_error`，而不会猜测某个 Session。
- **每个工具都能触及宿主的全部任务** —— `schedule_list` 返回其他 Session 创建的任务，`schedule_view` 与 `schedule_edit` 按 id 读取、改变和删除任意任务。授权说明约束模型行为；宿主不校验用户意图，也不增加按 Session 的归属检查。不应管理宿主任务的 agent 所用 preset 应省略这一行。
- **删除不会撤回已排队的消息** —— 宿主已经投递的消息在 `schedule_edit` 删除之后仍留在目标 Session 收件箱中。
- **任务时间由宿主负责** —— 这些工具不提供时钟来源、投递重试或执行结果；这些限制属于该服务。
- **每个工具都拒绝被委派的调用方** —— 四个工具都会在调用服务之前读取调用方 Agent 的委派深度，当该深度大于零时返回 `{ code: 'subagent_session', message: 'A delegated subagent cannot use scheduled tasks.' }`。该守卫位于本包内，读取来自 `@deepseek-ai/dsh-subagent` 的 `delegationDepthOf`，即委派封顶本身执行的同一份记账，因此在任何挂载这些工具的 preset 下都成立。
- **被委派的子 agent 仍能看到这四个工具** —— 子 agent 加入父方的 preset，因此其请求携带这四个 schema 及其 token 成本；阻止它管理任务的是上述拒绝，而不是省略 schema。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

None.

</details>
