# Agent Note: Client 工具展示所有权

Status: implemented

[English](2026-08-08-client-tool-presentation-ownership.md) | 中文

## 问题

Client 运行时已经按 `callId` 配对工具调用/结果事件，并能从 Code Dispatch 事件恢复 root/subcall 拓扑，但 Chat view 曾同时拥有工具在对话流中的放置、递归调用树编排、按工具名称分发、Generic fallback、card model 和第一方工具 renderer。`ui-conversation` 因此必须解释每个业务工具名称；只移动单个 React 组件不会改变这层所有权，移走原子 renderer 后 subcall 的展示也会无人负责。

工具展示需要一个独立所有者，同时不能建立与 Client slot 平行的第二套注册表，也不能让每个原子工具 renderer 自己理解 root/subcall 结构。

## 决策

工具是 Client UI 的一级展示概念，由 `@deepseek-ai/dsh-client-ui-tool` 统一拥有 root/subcall 编排、按 wire 工具名称的原子 renderer 分发、Generic fallback、card model 和 details output。业务插件只注册自己的原子工具 renderer，不修改 conversation 或会话。

Conversation 数据组装遵循后续的 [Conversation 业务节点决策](2026-08-09-client-conversation-node-assembly.zh.md)。`ui-conversation` 的工具 Definition 从会话事件配对 root call/result，把 Code Dispatch edge fold 成递归 `ToolCallBlock.subCalls`，并生成一个稳定的 `tool-call` Chat Node；这里的数据职责只处理官方工具 identity 和拓扑，不解释具体工具名称的展示。

[`ChatView`](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) 只按 Chat 快照的 `order` 放置通用 [`ChatNodeSeat`](../../../../packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx)。Seat 以 `node.kind` 分发 `'conversation.chat.node'`；[`ui-tool`](../../../../packages/client/ui-tool/src/client/apply.ts) 注册 `tool-call` entry，并由 [`ToolCallTree`](../../../../packages/client/ui-tool/src/client/tool/ToolCallTree.tsx) 递归遍历 root block。每一层 root 或 child 都通过同一个 keyed/session `'tool.call.toolview'` 子 slot 以 `entryKey: toolName` 分发，缺少注册时渲染 `GenericToolCard`。

业务工具插件接收一个标准 `ToolCallBlock`、identity、workspace cwd 和宿主动作，不读取会话、上下文或 Conversation assembler。skill（技能）仍是普通工具；它和其他业务工具使用同一 keyed slot 注册路径。

details panel 是第二个工具展示点，但不是调用树所有者。`ui-conversation` 定位 selected call，并通过 `'conversation.details.tool'` 委托 output body；`ui-tool` 复用 card model，插件缺席时 conversation fallback 保留 raw result text。

Generic row model 保留原始参数字符串 `bodyRaw`，不暴露预格式化 body。`ToolRow` 与 Bash fallback 只在展开后的 generic input section 可见时格式化该字符串；收起行会移除格式化文本，渲染结构化卡片的行则跳过 generic body 格式化。

## 运行时与渲染路径

```text
Session Event window
  -> Tool Definition -> tool-call Chat Node (recursive ToolCallBlock)
  -> ChatView -> ChatNodeSeat(entryKey = tool-call)
  -> ToolCallTree
       -> root/subCalls[] recursion
       -> tool.call.toolview(entryKey = toolName)
            |- registered atomic view
            `- GenericToolCard fallback
                 |- collapsed or structured card: retain argsRaw only
                 `- expanded generic input: format argsRaw
```

## 所有权边界

| 所有者 | 拥有 | 明确不拥有 |
|---|---|---|
| Client 运行时 Conversation engine | 上下文 identity、Location、历史回放、view Node 发布 | 工具事件含义、调用树、工具 renderer |
| `ui-conversation` 工具 Definition | call/result 配对、Code Dispatch 拓扑、running/settled/interrupted `ToolCallBlock`、Chat 排序 anchor | 工具名称分发、card model、递归 React 结构 |
| `ui-conversation` Chat view | keyed Node 顺序、scroll anchor、selection 与宿主动作 | 工具 lifecycle、subcall 组合、原子工具 renderer |
| `ui-tool` | root/subcall 递归渲染、原子 keyed dispatch、fallback、card model、展开时参数格式化与 details output | 会话事件 fold、Chat 排序 |
| 业务工具插件 | 一个或多个 wire 工具名称的原子 renderer | root/subcall 位置、生命周期配对、会话 projector |

## 验证

`ui-conversation` 测试固定工具 Definition 的 call/result 配对、Code Dispatch、interruption 和 running-to-settled keyed identity，不导入 `ui-tool` 的生产 renderer。`ui-tool` 测试挂载真实 conversation 宿主，固定 root/subcall 递归、keyed dispatch、Generic fallback、selection、details、具体工具 card 与只在展开时执行的 generic body 格式化。组装后的 Web 测试覆盖两个插件共同装载的路径。

## 考虑过的替代方案

**在每个 conversation view 下保留原子工具 slot。** 拒绝：每个 view 都要重复 root/subcall 编排，工具注册也会按 view 分裂。整个工具 renderer 占据 view 的一个业务 Node slot，原子分发由工具自己拥有。

**只移动工具 React 组件与 card model。** 拒绝：conversation 仍会按工具名称分发并递归 subcall，文件位置变化不产生所有权边界。

**为工具建立专属 projector/fold 注册表。** 拒绝：通用 Conversation assembler 已拥有上下文 identity、历史窗口和发布；第二个运行时注册表会制造生命周期的双重权威。

**让每个原子工具 renderer 递归自己的 subcall。** 拒绝：原子注册方只应理解一个工具调用，不应知道自己是 root 还是 child。递归结构统一由 `ToolCallTree` 处理。

**让 `ui-conversation` 直接导入 `ui-tool` 组件。** 拒绝：这会反转功能依赖并把工具展示变成必选能力。slot 保留独立装载、生命周期和 fallback。

**为兼容性在 row model 上保留预格式化 body。** 拒绝：每个折叠行都会保留第二份完整参数字符串，而且兼容字段会让后续消费方恢复 eager 格式化。model 只暴露 `bodyRaw`，使展开时格式化成为唯一 generic 路径。

## 后果

`ui-conversation` 不再依赖工具名称对应的业务展示，root 与 subcall 也不会漂移到不同分发路径。业务包可以独立拥有原子工具 renderer；`ui-tool` 缺席时，Conversation 数据组装仍然成立，Chat Node 使用通用 fallback，details 保留 raw result。

折叠的工具行只保留既有 `argsRaw` 引用，不创建 pretty-print 副本，也不执行对应的格式化调用。展开 generic input 时才为当前可见行完成这项工作，收起后派生文本可以被回收；重复展开以有界重算换取更低的常驻内存。

代价是 `ui-tool` 明确依赖 conversation 声明的业务 Node slot 和 locale namespace，并拥有一个工具专属子 slot。工具 Definition 暂时位于 `ui-conversation`，因为本次没有拆包；它以后可以沿 Conversation 注册表 seam 移动，而不会改变本记录规定的展示所有权。
