# Agent Note: 从 Markdown 文本识别消息 quote

Status: implemented

[English](2026-10-13-text-derived-message-quotes.md) | 中文

## 问题

纯 quote content 索引重复了 Markdown 文本中的信息，并要求 prompt、source、回显与队列协同携带元数据。同样可见的 blockquote 会因创建方式不同而获得不同的展示与直接输入行为。

## 决策

消息包含普通 Markdown 文本。共享 blockquote 匹配器识别连续的显式标记行，用于 UserText 展示。手写与输入框创建的 blockquote 在发送后具有相同行为。Quote 预览直接展示还原后的文本，不对正文再次运行 UserText 规则。Session-reference 与 skill 处理照常作用于引用文本；已识别的 Session 标签与周围引用文字保持相同样式。

[富文本 quote 功能](../feature/2026-08-26-web-rich-text-quotes.zh.md)保留原子草稿节点与语义恢复范围。本决策仅取代其持久 quote 索引区分。UserText 节点与识别范围仍是派生值。

## 考虑过的替代方案

**保留纯 quote 索引。** 索引保留手写与插入 quote 的区别，但发送后的消息无需这一区分，且要求每个生产方与渲染器协同处理元数据。

**移除原子草稿范围。** 纯文本无法恢复整节点编辑、撤销、Session 切换或发送失败恢复。草稿范围仍是浏览器拥有的编辑状态。

## 验证

匹配器测试覆盖原始偏移、显式行标记、空白摘录与字面的嵌套 quote。Composer 测试断言普通文本提交。已发布 Web 场景检查仅文本的持久化与刷新后的 quote 展示。

## 后果

消息无需 quote 字段或 content 索引。手写 blockquote 也显示为 quote，不改变直接输入处理。识别有意限定为显式引用行，不涵盖 Markdown 懒惰续行或代码围栏解析。来源导航仍需独立设计持久坐标。
