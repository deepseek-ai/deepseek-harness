---
description: "面向用户的权限预设：供选择、配置或排查把沙箱模式与审批策略捆绑在一起的 Permissions 选择器的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-permission-presets

[English](README.md) | 中文

## 概述

提供具名权限模式，同时设置沙箱与审批，但各执行服务仍保留自己的值。配置预设提供未来会话默认值；显式加载的 Auto review integration 可以增加一个仅限当前会话的选项。客户端从进程目录读取可选项，从 Session 投影读取当前选择。不匹配任何预设的旋钮组合显示为 `custom`，用户可以离开该状态，但不能选择它。本包拥有选择与默认值；沙箱、审批和 Auto integration 拥有执行行为。

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

当部署希望向用户提供一个 Permissions 选择器、而非分离的沙箱与审批控件时，选择此服务。它捆绑旋钮；执行与审批各自保留自己的取值，因此以后移除本包，最后一次取值依然生效。

### 配置预设

插件配置定义预设表与新会话的默认值。每个预设名称把一个沙箱模式与一个审批策略捆绑为一组；`name` 与 `description` 是可选的客户端呈现。保留名称 `custom` 与 `auto` 不能出现在该表中。

```yaml
- name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: workspace-write
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `presets` | `workspace-write`、`danger-full-access` | 预设名称 → 沙箱／审批捆绑的表 |
| `defaultPreset` | 推断 | 固定到新会话的预设；组合默认值不匹配任何预设时必填 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-permission-presets)是每个受支持字段及其 JSDoc 的穷尽式真源。`custom` 保留给推导出的非预设状态，`auto` 则保留给 Auto review integration。挂载需要具有约束能力的 bash 执行器（会报告 `sandboxMode` 的执行器）与审批服务。

### 切换预设

切换到 Auto 时，服务先同步执行其准入检查；每次预设切换随后只改变实际值不同的旋钮，再次选择当前已生效的预设不会产生任何变化。当前值解析顺序为：仍匹配的最近一次记录选择（已记录的 Auto 选择在 `never` 审批策略下也匹配），其次是配置表中的第一个匹配项，否则为 `custom`。用户通过 `/permission` 命令切换：不带参数调用时报告当前预设与所有可用条目，带预设参数时切换过去。

### 用户看到什么

客户端从进程级目录渲染可选条目：先按表顺序列出配置预设，再在 Auto integration 存活时列出 Auto。客户端把这份快照与 Session 当前值合并；不匹配的 `custom` 值可以标记当前控件，但绝不会成为可选目录行。Auto 的身份与旋钮组合（Full access 沙箱加 `ask` 审批策略）固定在本服务内部；已记录的 Auto 选择也匹配委派子会话固定的 `never` 策略。shipped 客户端的 locale 字典拥有 Auto 的 label 与 description，而配置预设保留 Host 提供的展示信息。调用方不能通过通用 contribution API 发布其他预设；他们可以从 `custom` 切换出去，但不能通过此服务选中或持久化一个具名 custom 预设。

### 会话默认值

`permission` 设置命名空间为未来会话持有 `defaultPreset`，且只接受配置预设。创建会话时读取它，将其应用于沙箱模式与审批策略，并把应用的预设记录为一次 `permission/preset` 选择。之后的设置变更绝不会改变现有会话。恢复的 seed（包括由 `session/end-seed` 明确标记的空 seed）会保留其有效权限，并只接收缺失的持久事实，而不会接收最新用户默认值；持久化的 `auto` 身份在发布前必须存在 live Auto 注册并通过准入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察行为已在[使用本包](#use-this-package)中说明；本节解释写入路径、进程级目录、由投影支持的当前值与可选命令。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `PermissionPresetService`：配置表、固定 Auto 注册、写入路径、设置命名空间、会话固定、子功能 |
| [`src/types.ts`](src/types.ts) | 进程级目录、目录变化事件与 `permissions` 当前选择类型 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：校验配置预设名称；Auto 恢复在发布前另行检查 |

### 写入路径

`set()` 解析预设，并在适用时同步执行 Auto 准入检查。切换仅在有效预设变化时追加 `permission/preset`，再通过各自的权威 setter——`dsh-sandbox-policy` 的 `setSandboxMode` 与 `dsh-user-approval` 的 `setApprovalPolicy`——写入每个变化的旋钮。因此，两个预设共享同一组取值时，选择事件仍会保留用户意图。Auto 与 Full access 之间切换时，记录新的身份与变化的审批策略。净变化为零的选择不追加任何内容。

### 读取侧与 `custom`

`current(session)` 读取必需的 `permissions` 投影；该单元在组合默认值（`ctx.shell.sandboxMode` 与审批配置）之上折叠三个全量值旋钮事件。host 状态还会保留 `session/end-seed` 是否已经出现，使会话固定无需重扫日志即可区分显式为空的恢复 seed 与真正的新会话。仍匹配的最近选择在共享捆绑时胜出，已记录的 Auto 选择在 `never` 审批策略下也匹配；否则配置表中的第一个匹配项胜出；否则返回推导出的 `CUSTOM_PRESET`。投影 key 缺失时会显式失败。

`optionOf(name)` 返回配置条目、存活的 Auto 条目或仅供显示的 `custom` 条目。只有名称不匹配这三者时才抛错；已撤回的 Auto 条目不可用。

### 会话固定与空白复用

挂载时会固定所有存活与未来的会话：真正全新的会话获得配置默认预设与两个旋钮事实，而 seed 会话或部分初始化的会话保留其有效旋钮值，只补充缺失的持久事实。投影自有的 seed 标记让该判断与旋钮值共用同一份增量状态。存储的 `auto` 身份在 Auto integration 缺失或拒绝准入时无法发布；服务既不会改写它，也不会静默推导为 Full access。

### 目录、投影与可选命令

该服务要求 `ctx.sessionProjections`，并注册一个只含 `currentValue` 的 `permissions` 投影。进程级 `catalog()` Remote 返回一份完整的可选快照。注册或移除 Auto 会发出无 payload 的 `permission-presets/catalog-changed` 通知，因此客户端先订阅再重新读取目录；该过程不会追加 Session 事件、发布 Session 投影帧或改变 Session 序列。`/permission` 命令仅在组合了 `ctx.commands` 注册表时注册。派生当前预设或固定初始选择的调用会在投影 key 缺失时显式失败。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从预设词汇逐步进入执行旋钮与设计依据。

- [权限预设子系统参考](../../../docs/subsystems/permission-presets.zh.md)——预设表、进程级目录、当前选择与 `ctx.permissionPresets` Cordis API。
- [沙箱切换设计 Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)——沙箱模式与审批策略如何组合与切换。
- [审批子系统参考](../../../docs/subsystems/approval.zh.md)——此服务捆绑的审批策略旋钮。
- [交互组映射](../README.zh.md)——相邻的命令、审批与问答包。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-user-approval` 和 `dsh-tool-bash`：二者渲染由此服务的旋钮事件所选择的审批策略提示词、切换通知与经沙箱执行的工具结果；`permission/preset` 本身只写入日志。

#### KV Cache 影响

不会直接使缓存失效；具名消费方拥有所有请求前缀变更。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明预设服务不提供什么。它们是当前包约束，不是权限系统对比。

- **只组合两个机制级旋钮**：预设选择沙箱模式和审批策略；固定 Auto integration 可以增加准入行为，但 agent（智能体）／profile 选择不属于 `PresetSpec`。
- **`custom` 只能推导得出**：调用方可以从不匹配的旋钮组合切换出去，但无法通过此服务选中或持久化一个名为 custom 的预设。
- **配置预设表在插件生命周期内固定**：只有固定的 Auto contribution 可以在不重新加载本服务的情况下改变实时进程目录。
- **Auto 不能成为默认值**：它只在 integration effect 存活期间存在，并且有意不进入 `permission` 设置 schema。
- **配置的默认值必须指向已配置预设**——移除被引用预设时，必须在同一次 Config 编辑中修改 `defaultPreset`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
