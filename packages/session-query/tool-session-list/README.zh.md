---
description: "通过可选的只读工具列出 Workspace 和 Session 元数据，支持分页以及缓存中的标题和活动时间。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-session-list

[English](README.md) | 中文

## 概述

无需恢复 agent（智能体）运行或读取冷会话的日志，即可发现工作区和会话。可以列出空工作区、查找某工作区中的会话，或列出已归档会话。结果包含标识符及轻量元数据，并限制每页条目数。当调用者可以查看整个已挂载运行时的元数据时，启用这些工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在预期调用者获取工具的作用域中挂载此可选插件。它没有配置字段，默认配置方案不包含它。

### 访问范围与组合

授予这些工具即授予读取已挂载运行时中全部 Workspace 和 Session 的权限。工具可用性就是访问控制；没有逐 agent 的 Workspace ACL，也不会隐式限制到调用者的工作目录。LiveShare 的工具允许列表不包含这些工具。

插件需要 `tools`、`sessions`、`sessionQuery`、`workspaceRegistry` 和 `sessionProjections`。投影缓存为冷会话提供元数据；没有缓存时，冷条目使用下文规定的元数据缺失值。在 headless 配置方案中，基础 bundle 已提供其他依赖；在配置方案补丁中添加 Workspace 注册表和此插件：

```yaml
- insert:
    - id: workspace-registry
      name: '@deepseek-ai/dsh-workspace'
    - id: tool-session-list
      name: '@deepseek-ai/dsh-tool-session-list'
```

如果组合已经挂载 `workspaceRegistry`，只添加工具条目。Workspace 初始化遵循[注册表现有的历史引导行为](../../workspace/workspace/README.zh.md)；列表调用不会创建或接入会话，也不会修改注册表记录。

### 列表行为

两个工具都直接返回数组。[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-list)定义参数。先过滤和排序，再分页；每次调用默认返回 20 条，最多接受 100 条，起始偏移为零。继续遍历时，将偏移增加已返回的条目数；空数组表示遍历结束。

`list_workspace` 保留注册表顺序，并包含没有会话的工作区。`list_session` 从不返回 subagent 会话。它默认包含未归档会话；没有指定 `workspace_id` 时，也包含不属于任何 Workspace 的会话。显式选择 Workspace 时使用已记录的成员关系，而非相同的工作目录。归档筛选匹配每个 Session 自身的 ID。

会话按 `updated_at` 降序排列，时间相同则按 Session ID 升序排列。活动时间取创建时间与最近人工提示词时间的较晚值；助手活动和标题变化不会推进它。标题来自实时投影或持久化投影元数据。标题不可用时为 `null`，活动元数据不可用时回退到创建时间。时间戳使用 ISO 8601 字符串。置顶顺序和侧边栏手动顺序不影响结果。

指定 `workspace_id` 时，调用从 Workspace 注册表索引读取成员 header，不做持久化 I/O，因此工作量随成员数增长。不指定 `workspace_id` 时，先枚举所有已存储和 live Session 的 header。随后的筛选、元数据读取和排序同步执行。调用不承诺在这段工作中及时处理新收到的取消请求，也不承诺所有 Session 共享同一个快照。

### 失败

无效分页参数或未知的 `workspace_id` 以 `ToolArgsError`（`INVALID_ARGS`）失败；使用 `list_workspace` 查找已注册的 ID。查询和存储故障使调用失败。取消不返回部分结果。这些失败不会修改会话或 Workspace 记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

选定 Workspace 时读取 `Workspace.getSessionHeaders()`；不指定范围时使用现有的仅 header 查询列表。两者都把 header 与投影元数据结合。实时条目通过 `ctx.sessionQuery.getListMetadata` 读取空白状态与提示词活动时间，与 Session API 读取同一个投影。标题投影仍由 `dsh-session-title` 拥有。冷条目读取投影缓存，不打开底层日志，缓存未命中时也一样。不需要 Session 控制器，也不会激活 agent。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 工具 schema、注册、JSON 结果渲染与通用工具卡片 |
| [`src/list.ts`](src/list.ts) | 分页、成员筛选以及实时或缓存元数据读取 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace 注册表](../../workspace/workspace/README.zh.md)——已记录的成员关系、注册表顺序与归档。
- [Session 查询](../session-query/README.zh.md)——全量 header 枚举与共享列表元数据读取函数。
- [Session 投影缓存](../../session/session-projection-cache/README.zh.md)——持久化元数据与缓存可用性。
- [Session 查询包映射](../README.zh.md)——相邻的检索能力。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema 与结果

#### 模型可见内容

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-list)拥有 `list_workspace` 和 `list_session` 的 schema。每个结果渲染为 JSON 数组。插件不增加独立的系统提示词段落。

#### Token 影响

可用工具的 schema 占用请求 token；每次调用增加其参数和返回的元数据。每页上限限制返回的条目数，标题和路径长度仍会影响结果大小。

#### KV Cache 影响

工具可用性不变时，schema 保持稳定。调用追加普通工具调用与结果历史，不替换之前的消息；启用或禁用工具会改变 schema 前缀。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

以下约束影响列表消费方。

- **冷元数据可能缺失或过期**——列表不会通过读取完整日志重建它。标题为 `null` 可能表示没有标题，也可能表示标题元数据不可用。
- **分页不是稳定快照**——并发的注册表或 Session 变化可能让条目在多次调用间移动。会话列表先读取全部候选项，再选取一页，因此每页大小不限制总工作量；不指定范围的调用随 Session 总数增长。
- **空白会话也会列出**——还没有 turn 的 Session（例如 Workspace 中未使用的新 Session）是普通结果；它的 `updated_at` 等于 `created_at`，标题通常为 `null`。
- **不指定范围的列表只有单测覆盖**——录制的 headless 回放中每次 `list_session` 调用都带 `workspace_id`，因此不指定 Workspace 的枚举只在单元测试中运行。
- **元数据访问覆盖整个运行时**——需要逐 agent Workspace 授权的调用者，必须先定义独立的访问策略，再为其启用这些工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
