# Agent Note: Web todo 展示——快照副作用通道 + 两个渲染面

Status: implemented
Archived: 2026-09-04

[English](2026-07-23-web-todo-display.md) | 中文

## 问题

`todo_write` 把 `todo/write` 的整份列表快照追加进会话日志；TUI 渲染一块常驻的 plan 面板（自动化专用的 ACP（Agent Client Protocol）桥接刻意不做 todo 呈现）。Web 客户端把这个事件整个丢弃了：host mux 流本已转发每一个会话事件，但 `todo/write` 不是 surface 类型（它从不 fold 进 `ConversationSnapshot.nodes`），也没有任何副作用分支累积它——浏览器既无消费点，也无展示面。

## 决策

把 `todo/write` 当作会话副作用消费，而非 surface 节点，并在两个面上渲染它，这两个面正对应 TUI 已经绘制的那套划分。

### 副作用通道，与窗口回放收敛

`applyEventSideEffects` 新增一个 `todo/write` 分支（整份列表，后写覆盖先写），并在 `turn/start` 清空（[按轮次界定的计划生命周期](2026-07-28-todo-plan-clears-on-next-turn.zh.md)）。`rebuildDerivedFromWindow` 从空计划扫过窗口，仅当窗口从未判定计划（无 `todo/write` 且无 `turn/start`）时恢复尾页种子；否则以窗口内写入／`turn/start` 折叠为准。`installWindow` 的每个调用方都是尾页请求（`doOpen`、其补洞重拉、`repairGap`；`loadOlder` 只往前拼接、不再播种），而 host 对尾页请求要么带上投影、要么在没有当前有效的计划时省略——因此字段缺失就是权威的空列表，直接照此赋值。这个区分在回滚场景上要紧：若 host 在持久化实时写入前崩溃，log 里就是空的，此时保留旧值会让已回滚的计划永远留在屏幕上。`ConversationSnapshot.todos` 是读取面。这遵循事件自身的约定（「仅存在于日志中的 UI 状态；绝不纳入派生历史」）：把每次写入作为对话节点呈现，会让已被取代的列表看起来仍然有效。

### TodoPanel：持久化列表作为一条常驻横条

面板经 `conversation.input.dock` slot 挂载（普通注册者插件 `todoDockEntry` 使用 `ctx.slots.inject`，不依赖 `ConversationController`，`order: 0` 排在队列条上方），空列表时隐藏，可折叠为标题加以 `·` 连接的各状态计数的表头（本地化，形如 `1 已完成 · 2 进行中 · 1 待处理`，计数为零的段落省略；折叠态不再附带进行中条目正文）。状态图标为 figma todo 套件（绿色勾选环／蓝色渐隐环／虚线未开始环），卡片使用 tip 表面（`--dsw-specific-tip`、14px 圆角、`width: calc(100% - 88px)`／`max-width: 776px` 居中；InputBar 顶部 6px 内边距是到输入卡的间距）。它经 dock entry 收到的标准件 `useProjection` hook 读取 host 计算的 `todos` 投影——无 store、无 service、无 ctx。内部组件保持 props 完备且框架无关；dock 适配件只是一行包装。

### TodoRow：经 keyed toolview slot 的逐调用行

专用的 `todo_write` 对话行是一个普通注册者插件（`todoToolview`，由 `apply` 挂载），经 `ctx.slots.inject` 注册进 keyed 的 `tool.call.toolview` slot，遵循与 bash 样例相同的声明生命周期，但属产品级注册。摘要由调用 args 推导（`N/M done · first active item`，其余活跃项的 `+<n>` 计数放在 `ToolRow` 的不收缩 `summarySuffix` 位里）；无法解析的 args 回退到通用行摘要；点击会以原始 args 打开 details 列。todo 不新增任何 `ToolEventView`——呈现归客户端所有，常驻列表从会话事件渲染，而非工具卡。

## 考虑过的替代方案

- **把 todo 写入作为 surface 条目折叠进 `nodes`**——回放的窗口会渲染每一份已被取代的列表；该事件被刻意设计成非 surface 类型。
- **面板硬编码进 `ConversationRoot`**——input-dock slot 出现之前的原始落点；dock 是本架构给「composer 上方常开横条」安排的位置，硬编码绕开了 slot 注册表的 disposal 与定序。
- **面板放进 details 列**——details slot 单占用且由选中驱动，生命周期不同于一条常开横条。
- **host 计算的视图（一个 todo `ToolEventView`）**——呈现属于客户端；协议已在事件载荷里携带整份快照。

## 后果

回放正确性由一条代码路径掌管：未来对窗口重建的任何改动都会自然保持 todos 一致；fx-alpha 第 71 轮的 fixture（测试前置数据）加上 `packages/client/ui-conversation/tests/todo-panel.client.spec.tsx` 固定整条链（行摘要与状态、dock 面板内容、折叠往返）。`todos` 是 `ConversationSnapshot` 的必填字段，所以 spec 里脚本化的 fake 必须带上它。自动化专用的 ACP 桥接刻意不做 todo 呈现；Web 各面渲染同一个事件，只新增一个协议字段，不新增事件类型。这个由 host 提供的字段正是冷加载重建的依据：history 尾页附带 `todos`——全量 log 上当前有效的计划（其后没有更晚 `turn/start` 的最近一次 `todo/write`），独立于分页窗口计算（与 view 配对同一种 backscan 姿势）——因此重开会话时若计划仍然有效且最后一次写入落在窗口之前，计划也照常恢复；该值跨往前翻页保留，之后的任何写入照常覆盖，更晚的 `turn/start` 会清空，而尾页响应不带投影时复位为空。
