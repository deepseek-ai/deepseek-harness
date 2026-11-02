# Agent Note：Web composer 中的持久富文本 quote

Status: implemented

[English](2026-08-26-web-rich-text-quotes.md) | 中文

## 问题

所选 transcript 摘录需要原子编辑与可跨刷新恢复的草稿，不依赖来源消息的可用性。

## 决策

`ui-conversation` 在现有编辑器 runtime 中于 reference 节点旁拥有行内 `QuoteNode`。其剪贴板投影是规范 Markdown，检测投影则是一个原子字符。现有语义 `DraftSnapshot` 在 reference 旁持久化 quote 文本与剪贴板坐标范围；原始 Lexical JSON 与 runtime 节点身份不进入浏览器存储。Session 切换、Workspace 转移和发送失败恢复使用同一个 snapshot。Quote 控件接收仅用于 runtime 的 locale 标签。

`ui-chat` 接受已展示的用户内容（包括待接纳 steering 和本地发送回显）、或最终完成的 Assistant 文本与 reasoning 中的一个非空浏览器选区。流式及中断的 Assistant 输出、tool、注入上下文和 Markdown 控件被排除。选区提取遵循可见的行与 block 换行，通过当前 Session 的 input actions 插入。

文本交互属于共享基础能力与 Chat 拥有的 list Slot，quote 只注册手势接管与插入操作。本地绝对定位让操作处于内容坐标系；外部按下与 Escape 对所有使用方关闭同一个区域拥有的交互。关闭展示与清除选区是独立操作，因此插入失败时保留摘录。右键菜单使用方同步取消来源浏览器事件；渲染 Slot 无法事后取消事件。

[文本派生 blockquote 决策](../simplification/2026-10-13-text-derived-message-quotes.zh.md)拥有发送后的消息识别与展示。[UserText 计算器](../architecture/2026-10-10-user-text-json-nodes.zh.md)通过现有 matcher registry 渲染派生的 quote 节点。

Quote 显示紧凑的单行预览；截断的摘录通过共享行内 HoverCard 展示完整文本。文本不提供来源导航操作，只有可编辑草稿提供整节点删除。消息持久化只保留所选文本：不保留来源 Session、消息或选区坐标。

## 考虑过的替代方案

**持久化 Lexical JSON 或引入另一套草稿格式。** 编辑器序列化会成为产品存储义务，第二套草稿格式则会重复拥有恢复与转移逻辑。现有语义 snapshot 已携带 reference 范围，也可扩展到 quote。

**保留来源导航。** 可用性检查需要来源坐标、订阅、历史分页、焦点路由和失败状态。未来若添加导航功能，必须先定义其持久坐标与目标拥有的操作。

**存储 UserText 节点或 callback。** 文本节点是派生的展示，callback 是 runtime 状态；二者都可以独立于记录的输入和语义草稿变化。

## 验证

Composer 测试覆盖原子删除与撤销、语义存储往返、Markdown 序列化和发送失败恢复。UserText 测试覆盖文本识别、字面摘录展示、字面 reference 与凭据原文。无密钥 Web 场景通过已发布组合验证选区、截断预览、草稿切换与刷新、持久化和普通 Markdown 提交。

## 后果

草稿与 Session 保留足以支持原子编辑和 replay 的数据，不保留对来源历史的依赖。UserText 仍是展示投影；其 JSON 节点不会替代权威 content。浏览器本地存储按现有草稿策略保留未发送的所选文本。
