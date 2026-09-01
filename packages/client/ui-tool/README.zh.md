---
description: "dsh Web 客户端的 Client 工具展示插件：整次调用树组合、keyed 按工具视图 slot 与内置原子工具卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-tool

[English](README.md) | 中文

## 概述

`dsh-client-ui-tool` 是 dsh Web 客户端的 Client 工具展示插件：它渲染对话中的每一次工具调用。`ui-conversation` 通过 `conversation.chat.node` 的匹配 key 分发每个已排序的 `tool-call` Conversation Node；本包渲染其中的 root 及其 Code Dispatch 子调用，并把每个原子调用通过 keyed slot `tool.call.toolview` 分发。没有注册的工具名称使用通用卡片。业务 UI 包只注册 wire 工具名称和原子视图——它们不配对会话事件、不重建 transcript，也不拥有 root/subcall 拓扑，因为运行时仍对 call/result 配对、生命周期与递归 `subCalls` 投影拥有最终决定权。

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

工具调用在对话中显示为卡片：一个根调用树带其嵌套子调用，每个原子调用由所属视图渲染。用户看到运行中、成功、失败与中断状态，这些状态只来自冻结的调用/结果切片，并可通过宿主回调打开文件或检查调用。

### 注册业务工具视图

拥有该视图的业务包将其 wire 工具名称注册进 `tool.call.toolview`：

```text
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({
    name: 'tool.call.toolview',
    key: '<wire tool name>',
  }, BusinessToolRow))
```

owner 载荷为 `ToolCallOwnerProps`：`callId`、`toolName`、冻结的 `block`、可选 `cwd` 与 `home`，以及普通的 `openFile`/`inspect` 回调。Code Dispatch block 保留事件的 `parentCallId`；root Session call 没有该字段，因此 descendant 无需另一项 placement 标志即可保持 generic 压平形态。路径摘要先相对 Session cwd 缩短，再把剩余的 POSIX Host home 写成 `~`；`filePath` 与 Host 打开仍使用作者给出的文件系统路径。注册项会收到常规 Session slot runtime share，但不会收到 React node 或 runtime service。

### 内置视图

本包拥有 generic fallback，以及 shell/pwsh、read、write/edit、running `str_replace_editor` `create`／`str_replace`、grep/glob、web、todo、question 与 Code Dispatch 的内置展示。结构化卡片直接从第一方原始 event 字段派生；Host `presentCall` 与 `presentResult` 值不会进入 Client。前台一次性 shell 结果使用 terminal 卡片。已完成的持久 shell 结果使用可展开的 generic 输入／输出卡片，因为 reset 与部分输出诊断不一定描述单个进程的退出状态；后台启动回执保持折叠。成功的问题行按稳定 id 配对调用中的问题与结果中的回答，展开后显示可读的问答行。已取消或已中断的问题行显示其裁决与原始问题，不虚构回答。不受支持、格式错误或含糊的输入回退为压平的工具输入／结果文本。`ui-skill` 展示了业务包自行拥有的 `skill` 注册项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包实现一条分派规则：原子工具视图按 wire 工具名称键控、由所属业务包注册；本包只渲染树与回退。

### 渲染约定

`ToolCallTree` 接收一个已经包含递归 `subCalls` 的 root `ToolCallBlock`、selection 状态、会话 `cwd`，以及用于打开文件和检查调用的 Host 回调。它递归遍历标准调用块，让 root 与任意深度的 child 经过同一条原子分发路径，不订阅独立的 parent-to-children map。每个 root 和 child 包装层都保留 `data-chat-anchor-key="call:<id>"` 与 `data-chat-call-id` DOM 约定，供分页和 selection 使用。

### 详情与卡片

本包通过 `ToolDetails` 填充 `conversation.details.tool`。行 renderer 与 Details renderer 分别为 terminal、read、diff、search 和 web 卡片复用同一个纯 card model。这些 model 校验原始调用参数、结果内容、失败状态、持久 metadata、Code Dispatch `parentCallId` 与 Session 路径事实。Generic row 保留原始 `argsRaw` 引用，只在展开期间格式化 input body；结构化卡片跳过 generic body 格式化。不受支持或格式错误的输入使用压平的工具结果文本。各类卡片的上限与 fallback 规则仍由对应的 [terminal](../../../.agents/notes/implemented/feature/2026-07-28-web-terminal-card.zh.md)、[diff](../../../.agents/notes/implemented/feature/2026-07-30-web-diff-card.zh.md)、[read](../../../.agents/notes/implemented/feature/2026-07-30-web-read-card-frontend.zh.md)、[search](../../../.agents/notes/implemented/feature/2026-07-30-web-search-card.zh.md)、[web](../../../.agents/notes/implemented/feature/2026-07-30-web-result-card-frontend.zh.md) 与 [question](../../../.agents/notes/implemented/feature/2026-07-29-ask-question-web-presentation.zh.md) 笔记负责。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖对话宿主、视图 slot 与卡片模型。

- [ui-conversation](../ui-conversation/README.zh.md)——把 `tool-call` 节点分派给本包的聊天界面。
- [ui-primitives](../ui-primitives/README.zh.md)——内置视图所拼装的输出卡片原子组件。
- [ui-skill](../ui-skill/README.zh.md)——`skill` 工具的业务自有注册。
- [Conversation 子系统](../../../docs/subsystems/conversation.zh.md)——业务自有功能如何注册 Conversation node。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——keyed slot 背后的组合模型。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端工具展示层，只渲染已记录的工具调用，不改变模型上下文。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义分派深度与视图归属；它们是当前包约束。

- **Host 不把 `run_code` 暴露为 PTC mode 程序 binding**：生产事件只产生一层分发；递归的运行时/UI 约定支持嵌套。
- **第一方工具视图集中在本包**：它们可以通过 keyed slot 独立迁移到各自所属的业务包。
- **工具文案复用 `ui-conversation` locale namespace**：工具标题、行 chrome 与无 Cordis 的 primitive label 使用该字典；presenter model 保留 locale key 或数据，而不是已渲染文案。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Tool composition 只存在于浏览器，不贡献事件或跨插件可变状态；slot 所有权由 ui-slots 校验。
