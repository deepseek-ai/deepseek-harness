# Agent Note: PTC mode 的 chat 渲染——子调用作为父行之下的原生行

Status: implemented
Archived: 2026-09-04

[English](2026-07-26-ptc-chat-subcall-rows.md) | 中文

> 范围：Web chat 视图如何渲染一个 `run_code` 轮次，即 PTC mode UI 栈的客户端侧部分，构建在[宿主侧基础](2026-07-26-ptc-dispatch-ui-foundation.zh.md)之上（携带完整内容的 `tool/code-dispatch`、必填的 `description` 参数）。本篇所依托的 slot 模型归 [toolview 溶解](../architecture/2026-07-23-toolview-dissolution.zh.md)所有。

## 问题

启用 PTC mode 后，chat 视图过去只显示一条不透明的 `run_code` 行：摘要就是原始程序文本，子调用则处处不可见。已敲定的产品要求恰恰相反：每个子调用都必须与原生工具调用渲染得*完全一致*——同样的行组件、同样的自定义注册、同样的详情面板——同时 transcript（文本记录）仍须如实反映模型只发起了一次调用这一事实。

## 决策

**子调用是在 surface 流之外递归附着到父级的标准工具调用块，经由与原生行相同的 keyed slot 渲染，并始终显示在父级之下。**

- **数据层**：运行时的 `ToolCallTree` 把窗口内的 `tool/code-dispatch-start` 与 `tool/code-dispatch` 事件折入私有的逐父级索引，再把运行中和已结算的子级投影到递归的 `ToolCallBlock.subCalls` 上。实时会话投影与 `projectConversationHistory` 共享这一折叠过程；逐父级的写时复制数组和路径复制投影让无关根节点与兄弟节点保持引用稳定。子调用永不进入 `nodes`——surface 流始终精确等于模型可见的轮次结构。这些事件在 wire 消费方边界作结构性收窄，该边界也会拒绝成环的父子关系（dsh-tools 的宿主类型无法进入客户端程序，因为宿主端与客户端两侧的 `Context` 声明合并会冲突）。
- **渲染层**：`ChatView` 通过整体工具 seat `'conversation.chat.tool'` 传递每个父调用及其递归子调用。ui-tool 的 `ToolCallTree` 先渲染 parent，再渲染 `[data-subcalls]` 嵌套；每个原子调用都通过同一个 `'tool.call.toolview'` keyed slot，以工具名称作为 `entryKey`，并共用 `GenericToolCard` fallback。一个 keyed 注册因此无需变化即可同时接管任意后代与顶层调用。运行中的 parent（`runningCalls`）在同一个递归块中接收已累积的 dispatch，使 child 行在运行期间实时流入。
- **`run_code` 的呈现**：新增一种 `code` 行变体（分类器映射 `run_code → code`、标题 `Code`、图标 `IconCodeOutline16`），以模型撰写的 `description` 作摘要，展开后显示程序本身（在 markdown 代码块的填充底色上以等宽字体呈现），而非参数的 JSON 封装。
- **详情面板**：`materialFor` 递归搜索 `nodes` 与 `runningCalls`，因此被选中的后代 callId 会经由与已完结的原生调用完全相同的渲染路径，解析出完整参数与完整输出。

## 曾考虑的替代方案

**把子调用平铺进 surface 流（折入 `nodes`）。** 否决：这会歪曲 transcript——模型只发起了一次调用；嵌套在父行之下既保住代码↔调用的关联，也让折叠过程的模型可见顺序不变式原封不动。

**隐藏子调用，展开父行后才显示。** 由产品决策否决：子调用正是一个 PTC mode 轮次的核心内容；把它们藏起来，等于重新制造出本功能所要消除的那种不透明。父行的展开开关只用于显示程序本身。

**专用的子调用行组件。** 否决：本功能的全部要义就在于与原生行保持同一性；一个平行组件必然漂移。嵌套包装层（缩进 + 左侧边线）是子调用唯一的专属视觉装饰。

## 后果

自定义 toolview 注册无需额外改动即可适用于子调用——而且是刻意为之：不存在按注册粒度的退出机制，唯一的出路是组件自行读取自身上下文，而当前没有任何消费方需要这么做。选中高亮经由同一条 `selectedCallId` 通道到达嵌套行（分组归属会搜索整棵树）。trajectory/waterfall 现在依据分发计时事件对（[实时并行分发](2026-07-26-ptc-live-parallel-dispatch.zh.md)）绘制子调用 span；缺少计时，waterfall 上的 span 就是在撒谎。fixture（测试前置数据）的轮次 64（`?fixture`），加上 `ptc-round` 浏览器 e2e（录制的真实轮次、无密钥回放），共同锁定整个界面；jsdom 与运行时测试套件则锁定 slot 分发、错误状态、递归详情解析、历史投影与引用稳定的路径复制。
