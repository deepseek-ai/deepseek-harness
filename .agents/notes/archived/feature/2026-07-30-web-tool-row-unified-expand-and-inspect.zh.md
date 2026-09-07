# Agent Note: Web 工具行统一展开交互与 trajectory Inspect

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-web-tool-row-unified-expand-and-inspect.md) | 中文

## 问题

聊天视图的工具行交互已经分裂成多种方言：ToolRow 通过前导图标切换展开、且仅限有 args body 的调用，bash 示例有自己的一套展开方式，todo / ask-question 行只能展开原始 args，单文件工具完全不可展开，而调用的 OUTPUT 只能通过详情面板查看。失败的 bash 命令（exit≠0 但结算为 `isError:false`）在折叠行上没有任何失败信号。此外聊天行没有跳转到 trajectory 记录的入口，且 chat → trajectory → chat 切换会丢失阅读位置（标签环会卸载非活跃视图）。

## 决定

**所有可展开工具行共享同一交互——整行即开关（点击 / Enter / 空格），图标 hover 时渐变为 chevron 预览——以及同一展开体：带 IN/OUT 侧栏标签的卡片，各分区独立滚动上限；hover 显示的 Inspect 胶囊通过 store 的一次性交接跳到该调用的 trajectory 记录；聊天视图用内存态的按会话 Map 在视图切换间保留语义阅读位置。**

- `toolRowModel` 在 args 之外同时派生结果材料：`output`（`resultText` 拍平逻辑从 DetailsPanel 移入 contract）和 `errorSummary`（失败首行，作为折叠摘要并以错误色显示）。有 body、output 或 terminal 材料的行即可展开；行本身是开关（`role="button"`、`aria-expanded`），文件路径摘要通过 `stopPropagation` 保持独立链接。
- 展开卡片（figma 1249:35657）是 IN/OUT 分区列：每个分区是独立滚动区（max-height 150px），侧栏标签 sticky 固定，l2 分割线横贯整卡宽度。Think 的推理文本和 run_code 的 CodeBlock 保持非卡片体；上下文注入复用此行并以无标签的 `plainBody` 卡片展开。
- `terminalFailed` 读取已结算 terminal 卡片的退出状态，让 BashRow 和 GenericToolCard 把失败命令显示为行的红色状态点——这是折叠行唯一的失败信号，因为调用本身结算为 `isError:false`。
- TerminalBlock 的横幅并入同一阅读模型：与卡片共用同一表面（不再用 banner token），与正文之间是 l2 细线，命令列上限 150px 内部滚动，复制/状态控件 sticky 且顶对齐第一行提示符。
- Inspect：`ToolCallOwnerProps.inspect`（无调用身份的行不提供）在展开体左下角的正常布局流中渲染胶囊，hover 到工具调用的任意位置时显示。点击将 `{ callId }` 写入 chat store 的一次性 `inspect` 字段并切换到 trajectory 视图；TrajectoryTable 找到记录、打开其摘要，并通过清空字段确认。
- 滚动保留：每次非贴底滚动时，聊天视图把 `{ anchorKey, anchorTop, scrollTop }` 保存到 apply 作用域的按会话 Map，并以 `chatScroll` 暴露；重挂载时先用 `scrollTop` 到达近似窗口，再按稳定 node／call 锚点的矩形差值校正，因此宽度重排后仍把同一阅读行保持在原位。包括「回到底部」在内的每条贴底路径都会在切换 tab 或会话前同步清除该项。Map 仍刻意不持久化——新页面加载保持打开即贴底的默认行为。

## 曾考虑的替代方案

**保留前导图标开关和各注册方自有的展开方式。** 否决：三个表面已经分化；注册方姿态（bash 示例本地复刻 CSS）意味着除非交互约定本身统一且足够小——整行开关加 hover 预览——否则漂移会永久存在。

**通过 URL 或 trajectory 视图 prop 传递 Inspect。** 否决：视图环经由 slot 注册表渲染，两个视图没有可携带 prop 的共同父级；chat store 本就跨越该边界，一次性字段让交接具备回放安全性（字段出现之前的持久化快照以 `?? null` 复水）。

**持久化聊天滚动偏移。** 否决：把几天前的偏移恢复到已经增长的会话里读起来像 bug；内存 Map 把记忆精确限定在会丢位置的视图切换场景。

**从详情面板的材料为每行单独取展开 OUTPUT。** 不必要：已结算结果节点本就在快照的冻结调用切片上，contract 层的 `resultText` 拍平让行和面板共用一份派生。

## 后果

ui-tool 内置视图都能就地检查输入与输出，详情面板和 trajectory 仍是深查界面。共享 `ToolRow` 交互是 ui-tool 内部实现；外部原子视图接收 `ToolCallViewProps`，可以通过自己的 chrome 暴露其中的 `inspect` 回调。bash 视图保留独立 CSS，因此未来交互变化仍需显式同步。`--dsw-font-markdown-code-block-small`（12/18）是手工补充的 token，待设计平台导出后替换。web-cordis 的 `distIndex` 修复（纯拼接而非 URL.pathname）解除了含空格 cwd 下预览无法启动的问题。
