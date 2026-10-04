---
description: "预设作用域的提醒管理工具（schedule_create、schedule_list、schedule_update、schedule_delete），基于宿主 ctx.schedule 服务，供选择哪些 agent 可以维护持久提醒的部署使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-schedule

[English](README.md) | 中文

## 概述

使用 `dsh-tool-schedule`，可通过 `schedule_create`、`schedule_list`、`schedule_update` 与 `schedule_delete` 让 agent（智能体）创建、列出、编辑和删除宿主持久提醒。本包把四个工具注册进挂载它的 preset 或 Agent 作用域，因此由组合决定哪些 agent 获得这些工具；`minimal` 不获得。每次调用都作用于调用方 Agent 的 Session，并且只管理已存储的提醒——存储、调度与投递由宿主 `@deepseek-ai/dsh-schedule` 服务负责。失败时返回一个结构化错误码，而不是存储细节。

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

当某个 preset 的 agent 需要管理持久提醒时，把下面这一行加入该 preset 的插件列表。随产品发布的 Web `standard`、`cordis` 与 `ptc` preset 会挂载它；`minimal` 不会。

### 何时选用

当 preset 的 agent 需要在自己的 Session 中安排未来工作时选用它，并在同一进程内加载 `@deepseek-ai/dsh-schedule`：本包只是该服务面向模型的消费方。需要保持能力精简的 preset——随产品发布的例子是 `minimal`——会省略该行，其 agent 完全看不到提醒工具。

### 四个工具

- `schedule_create(prompt, title, <一个选择器>)` —— 创建一条提醒。需提供非空提示文本、不超过 120 个字符的标题，以及 `after_seconds`、`at`、`every_seconds`、`daily`、`weekly`、`cron` 中的恰好一个。返回规范提醒视图。
- `schedule_list()` —— 列出调用方 Session 的全部活动提醒及其 id、标题、UTC 目标、状态与投递模式。
- `schedule_update(id, <title|prompt|一个选择器>)` —— 原地替换名称、指令或时间，或它们的组合。未知或已结束的提醒返回 `updated: false` 及原因码；`after_seconds` 仅限创建时使用。
- `schedule_delete(id)` —— 删除一条保留的提醒，无论活动还是已结束。未知或已删除的 id 返回 `deleted: false`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-tool-schedule'
```

本包不声明任何 `Config` 字段。它注入 `ctx.tools`，并在作用域解析到宿主 `ctx.schedule` 服务后注册这四个工具，因此保持该服务关闭的组合不会挂载任何提醒工具。每次调用都作用于派发该调用的 Agent 的 Session。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

插件通过加载它的上下文注册四个 `defineTool` 定义，因此由 preset 挂载决定可见性，并由 Cordis effect 的所有权随挂载一并释放。执行时读取 `exec.agent` 作为 Session 绑定，并读取注入的 `ctx.schedule` 服务进行存储；委派深度守卫先于选择器与身份校验运行，二者均在服务调用之前完成，服务抛出的任何非 `ScheduleInputError` 失败都收敛为 `internal_error`，因此存储细节不会到达模型。模型内容为返回值的规范 JSON，而持久化、调度、Session 恢复与投递都由宿主服务负责。

### 源码映射

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：四个注册、选择器校验，以及 render/present 辅助函数 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Schedule 服务](../schedule/README.zh.md) —— 这些工具所管理的宿主任务存储、运行时与投递行为。
- [Schedule 分组映射](../README.zh.md) —— 本组内的同级包。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-schedule) —— 模型接收的确切四个 schema。
- [Schedule 子系统](../../../docs/subsystems/schedule.zh.md) —— `ctx.schedule` 的 Cordis 接线区域与存储类型。
- [Schedule 用户指南](../../../docs/user/guide/schedule.zh.md) —— 面向用户的提醒工作流。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### What the model sees

只要本包在调用方 Agent 的作用域内可见，模型就会收到生成的 [`schedule_create`、`schedule_list`、`schedule_update` 与 `schedule_delete` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-schedule)。

#### Token effect

凡是 preset 挂载了本包的 Agent，其每次请求都有固定的 schema 开销。省略该行的 preset 下的 Agent 不付出任何开销。

#### KV Cache effect

只要工具定义与可见性不变，前缀保持稳定。挂载、释放或作用域变化都可能使从首个变化 schema token 起的复用失效。

### 提醒结果

#### What the model sees

每次调用返回一个无损 JSON 文本块：`schedule_create` 返回提醒视图，`schedule_list` 返回视图数组，`schedule_delete` 返回 `{ id, deleted }`，`schedule_update` 返回提醒视图或 `{ id, updated: false, code }`。被拒绝的调用返回带有某个已发布错误码的 `{ code, message }`。

#### Token effect

结果会留在调用方 Session 的历史中直到压缩，并重复存储的提醒字段；较长的提醒列表在之后每次请求中都付出其全部渲染长度。

#### KV Cache effect

只追加；新可见内容跟在可复用的请求前缀之后，不会使既有 KV Cache 条目失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **没有宿主服务就没有工具** —— 在缺少 `ctx.schedule` 的组合中挂载本包会让插件保持挂起，四个工具都不会注册。
- **每次调用都需要调用方 Agent** —— 未携带 Agent 的派发返回 `internal_error`，而不会猜测某个 Session。
- **删除不会撤回已排队的消息** —— 宿主已经投递的提醒在 `schedule_delete` 之后仍留在 Session 收件箱中。
- **提醒时间由宿主负责** —— 这些工具不提供目标时间校正、时钟来源或投递重试；这些限制属于该服务。
- **每个工具都拒绝被委派的调用方** —— `schedule_create`、`schedule_list`、`schedule_update` 与 `schedule_delete` 都会在派发前读取调用方 Agent 的委派深度，当该深度大于零时返回 `{ code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }`。该守卫位于本包内，读取来自 `@deepseek-ai/dsh-subagent` 的 `delegationDepthOf`，即委派封顶本身执行的同一份记账，因此在任何挂载这些工具的 preset 下都成立。
- **preset 的委派行让这四个工具从子 agent 的 prompt 中消失** —— `standard`、`cordis` 与 `ptc` preset 在 `tool-subagent` 与 `tool-subagent-fork` 两行上都声明 `toolFilter.deny`，拒绝 `schedule_create`、`schedule_delete`、`schedule_list` 和 `schedule_update`。provider 会在子作用域内通过 `ctx.tools.restrict()` 应用该过滤，因此这四个工具会从被委派子 agent 的 prompt 中消失；在子链上继续委派会沿链求交同一限制。
- **被委派子 agent 拥有的 Session 不能设置提醒** —— 当 Session 的 Agent 委派深度大于零时，`ScheduleService.create` 会抛出 `ScheduleInputError`（code 为 `subagent_session`），`ScheduleService.update` 则返回非变更的 `subagent_session` 结果。委派深度正是委派封顶本身读取的同一份记账，持久化 session header 让它在冷恢复后仍然成立。这条规则在服务层而非这些工具里，因此其它进程内消费方（包括自动化任务页面）也会命中。`schedule_list` 与 `schedule_delete` 仍可服务该 Session，所以在这条规则之前存储的提醒仍可删除。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

None.

</details>
