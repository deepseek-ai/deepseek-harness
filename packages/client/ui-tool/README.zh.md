---
description: "dsh Web 客户端的 Client 工具展示插件：完整调用树的组合、按工具名称键控的视图 slot，以及内置原子工具卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-tool

[English](README.md) | 中文

## 概述

`dsh-client-ui-tool` 是 dsh Web 客户端的 Client 工具展示插件：它渲染对话中的每一次工具调用。`ui-conversation` 通过 `conversation.chat.node` 的匹配 key 分发每个已排序的 `tool-call` Conversation Node；本包渲染其中的 root 及其 PTC dispatch 子调用，并把每个原子调用通过 keyed slot `tool.call.toolview` 分发。没有注册的工具名称使用通用卡片。业务 UI 包只注册 wire 工具名称和原子视图——它们不配对会话事件、不重建 transcript（文本记录），也不拥有 root/subcall 拓扑，因为运行时仍对 call/result 配对、生命周期与递归 `subCalls` 投影拥有最终决定权。

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

工具调用在对话中显示为卡片：一个根调用树带其嵌套子调用，每个原子调用由所属视图渲染。所有生命周期状态都保留工具的普通业务图标；失败与中断仍通过冻结调用／结果状态、无障碍状态文本和失败摘要明确表达。用户可通过宿主回调打开文件或检查调用。折叠的 `web_fetch` 行把其 http(s) URL 显示为链接，在新浏览器标签页中打开。

共享工具行和 Bash 行的失败、停止摘要在悬停时仍保留错误色和警告色；只有不处于这两种状态的摘要会在悬停时加深。

派发前，模型已给出名称的调用显示为不可展开的一行，使用工具自己的图标与标题。通用行显示为`工具调用 · <工具名>`。准备阶段不提供完整参数、文件链接、结果或依赖参数的交互。write/edit 的摘要显示「正在准备内容 NKB」；N 为 `Math.ceil(raw.length / 1024)`，是原始参数字符串长度的整数近似值，不是文件字节数。`tool/call` 才启用既有调用展示；参数块结束本身不代表开始执行。

### 注册业务工具视图

拥有该视图的业务包将其 wire 工具名称注册进 `tool.call.toolview`：

```text
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({
    name: 'tool.call.toolview',
    key: '<wire tool name>',
  }, BusinessToolRow))
```

owner 载荷为 `ToolCallOwnerProps`：`callId`、`toolName`、`phase` 判别字段及对应阶段的冻结 `block`、可选 `cwd` 与 `home`、会话授权的 `loadImage` loader（供结果携带持久图像的视图使用），以及普通的 `openFile`/`inspect` 回调。PTC dispatch 块保留事件的 `parentCallId`；根会话调用没有该字段，因此后代调用都走同一条按 key 分发路径：已注册视图的调用（如 `read_image`）也会在嵌套处渲染对应卡片，未注册的后代调用则保持通用压平形式。路径摘要先相对会话 cwd 缩短，再把剩余的 POSIX Host home 写成 `~`；`filePath` 与 Host 打开仍使用作者给出的文件系统路径。注册项会收到常规的会话 slot 运行时共享数据，但不会收到 React 节点或运行时服务。

### 内置视图

每个注册视图都接收[工具 slot 类型](src/client/contract/slots.ts)声明的显式 `preparing`、`start` 和 `result` props。通用行在三个阶段使用同一个 `ToolRow`。行模型统一选择标题，并组合通用工具名前缀与已有参数摘要，不按生命周期阶段改变前缀；专用标题不附带英文名。准备阶段的共享参数解析入口直接返回无调用，不解析部分 JSON。write/edit 将准备态和派发后阶段拆成两个组件，只有准备态组件调用 `useToolCallArgumentsPartial`，start 与 result 共用派发后组件。Bash、Skill、Cordis 等自定义 renderer 分别处理准备态，其依赖参数的组件接收 `StartedToolCallViewProps`。

本包拥有 generic fallback，以及 shell/pwsh、read、read_image、write/edit、运行中的 `str_replace_editor` `create`／`str_replace`、grep/glob、web、todo、question 与 PTC dispatch 的内置展示。结构化卡片直接从第一方原始 event 字段派生；Host `presentCall` 与 `presentResult` 值不会进入 Client。运行中与已完成的前台标准 `bash`/`pwsh` 和 `terminal_send` 调用，无论位于根还是 PTC dispatch 子调用中，都在通过相同的参数、结果和错误检查后使用 terminal 卡片。持久 `bash`/`pwsh` 调用仅在运行中使用 terminal 卡片。以已识别的 spill 策略提示结尾的 shell 输出，在 shell 行中使用可展开的 generic 输出，在 Details 中使用 generic 输出；位置被改变或被省略的退出标记无法证明成功。已完成的持久 shell 结果保持 generic 展示，因为 reset 与部分输出诊断不一定描述单个进程的退出状态；根调用的持久 shell 结果可展开，后台启动回执则保持折叠。带有 `AUTO_REVIEW_DENIED` 的原生或 PTC dispatch 失败会在折叠行显示 Auto review 裁决，展开时显示一行归一化后的“未执行”原因；原因缺失或只有空白时使用本地化 fallback 文案。成功的问题行按稳定 id 配对调用中的问题与结果中的回答，展开后显示可读的问答行。已取消或已中断的问题行显示其裁决与原始问题，不虚构回答。不受支持、格式错误或含糊的输入回退为压平的工具输入／结果文本。`ui-skill` 展示了业务包自行拥有的 `skill` 注册项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包实现一条分派规则：原子工具视图按 wire 工具名称键控、由所属业务包注册；本包只渲染树与回退。

### 渲染约定

`ToolCallTree` 接收一个 Tool 节点、会话 `cwd` 和导航回调。每个分支接收稳定的 block，并缓存显式阶段 props，因此一个子调用变化不会重渲染未变化的兄弟分支。它通过 `tool.call.toolview` 按工具名分发。已派发的根调用保留递归 `subCalls`，准备阶段没有子调用。每个根调用和子调用包装层都保留 `data-chat-anchor-key="call:<id>"` 与 `data-chat-call-id` DOM 约定，供分页和选择使用。Tool 节点在三个阶段保持同一个 callId。

Tool 所有者属性将 Chat 注入的稳定 `useDisclosure` 钩子传给根调用及嵌套调用。工具行在拥有展开正文的位置调用它，中间 renderer 不订阅。每次调用拥有独立展开状态，外层轮次收起时重置该状态，不替换 React 身份；展示模式切换保留该状态。


slot 注入的 `useToolCallArgumentsPartial` 钩子按需订阅所属 Step 的 `assistant-step` 来源，并选取当前 callId 的原始参数前缀。来源或调用不存在时返回空字符串。同一步骤中的其他调用可能触发快照检查，但选中的字符串未变时不会刷新使用方。不调用钩子的工具不新增订阅，已派发的调用不再提供参数前缀来源。

### 卡片


每张卡片都直接在调用树中查看；选中调用后不会再显示第二个全高视图。行 renderer 为 terminal、read、diff、search 和 web 卡片各复用同一个纯 card model，image 卡片的图库经由工具自有 `tool.call.images` slot 渲染。这些 model 校验原始调用参数、结果内容、失败状态、持久 metadata、PTC dispatch 的 `parentCallId` 与会话路径信息。不受支持或格式错误的输入使用压平的工具结果文本。文件路径摘要经属主的 `openFile` 打开文件，chat 视图把它路由到右侧 Sidebar 的文本预览；`inspect` 打开轨迹视图；该视图不可用时不提供此回调，卡片随之隐藏 Inspect。terminal、diff、read、search 与 web 卡片的上限与 fallback 规则仍由 [ui-primitives README](../ui-primitives/README.zh.md) 负责；image 卡片的 fallback 规则由本包内的 card model 自行承载。

Chat diff 卡片在折叠前保留九行，足以容纳文件标题、一对删除与新增行及两侧各三行上下文。工具行显示原语提供的精确或粗粒度替换统计；展开卡片包含差异正文，不显示底部统计。

Auto 拒绝优先于按工具名选择的专门视图。其通用行保留调用身份、省略原始参数，并且只在显示时归一化存储的理由：去除首尾空白，把行分隔符折叠为空格，结果为空时使用本地化通用理由。Session 与 SDK 错误详情保留原始理由。

记录结果的工具详情覆盖目标和定时任务工具、Cordis 检查、workflow 与 Ralph 报告、Session 事件／搜索／轨迹查询、Agent 与 teammate 控制、后台作业、持久终端以及 LSP 导航。展开内容读取成功的记录结果，为失败或不支持的数据保留通用输入／输出，并保留 Inspect。日期包含查看者的时区，状态反映调用结果而非当前会话状态。Session 轨迹保留后代的缩进。LSP 结果通过 Host 回调打开文件系统路径，其他 URI 则显示为文本。浏览器适配器消费已记录的 producer 文本与 JSON；Host service 对象和 presenter 回调不会进入 Client。[紧凑工具详情](../../../.agents/notes/implemented/architecture/2026-09-10-compact-tool-details.zh.md)记录了呈现取舍。

展开后的状态圆点和文字使用静态语义色。操作回执和任务输出的标题保持中性色，展开时省略标题中的状态。中断回执仅确认已发出中断请求。

terminal model 使用浏览器安全入口 `@deepseek-ai/dsh-spill-policy/notice` 的 `hasSpillNotice`，而非独立的 UI 匹配规则。[spill-policy README](../../spill/spill-policy/README.zh.md#shared-notice-ownership) 负责提示文本的格式化与识别。该检查保守地选择通用输出；匹配的文本无法证明其来源，回放也不改变已记录的结果字节。
</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖对话宿主、视图 slot 与卡片模型。

- [ui-conversation](../ui-conversation/README.zh.md)——把 `tool-call` 节点分派给本包的聊天界面。
- [ui-primitives](../ui-primitives/README.zh.md)——内置视图所拼装的输出卡片原子组件。
- [ui-skill](../ui-skill/README.zh.md)——`skill` 工具的业务自有注册。
- [Auto review](../../experimental/auto-review/README.zh.md)——结构化拒绝身份与用户可见原因的 owner。
- [Conversation 子系统](../../../docs/subsystems/conversation.zh.md)——业务自有功能如何注册 Conversation node。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——keyed slot 背后的组合模型。

-----

<a id="model-experience"></a>
## 模型体验

无。该包渲染流式工具身份与已记录调用，不改变模型上下文。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义分派深度与视图归属；它们是当前包约束。

- **Host 不把 `run_code` 暴露为 PTC mode 程序 binding**：生产事件只产生一层分发；递归的运行时/UI 约定支持嵌套。
- **第一方工具视图集中在本包**：它们可以通过 keyed slot 独立迁移到各自所属的业务包。
- **Web 工具链接总是打开新标签页**：折叠的 `web_fetch` URL 与展开的 web 卡片链接不遵循 `ui-chat` 的链接打开方式设置，因为工具视图没有外部链接回调。
- **工具文案复用 `ui-conversation` locale namespace**：工具标题、行 chrome 与无 Cordis 的 primitive label 使用该字典；展示转换器模型保留 locale key 或数据，而不是已渲染文案。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。工具组合只存在于浏览器，不贡献事件或跨插件可变状态；slot 所有权由 ui-slots 校验。
