---
kind: upgrade-guide
description: "自定义图片 Factory 和 Markdown 图片委托必须提供文件准备回调。"
---

# 为图片视图提供文件准备回调

[English](guide.md) | 中文

## 变更

已发布的 `conversation.images.content` Factory 现在要求 `fileDrag` 注入成员，`MarkdownDelegate.fileImages` 也要求相同回调。`ChatViewInjected` 同样新增 `fileDrag`。构造这些值的自定义注册必须更新才能通过编译。内置 Web 和 Desktop 组合提供 `@deepseek-ai/dsh-client-ui-file-drag`；自定义组合必须提供该服务及其反馈插槽。已有图片文案字段不变。

## 迁移

1. 在自定义客户端组合中加载 `@deepseek-ai/dsh-client-ui-file-drag`，同时提供 locale、插槽渲染器和声明 `shell.overlay` 的外壳。在每个消费插件的 `inject` 列表中声明 `fileDrag`。
2. 注册 `conversation.images.content`、组装 `ChatViewInjected` 或构造 `MarkdownDelegate.fileImages` 时，将 `ctx.fileDrag.actions` 作为 `fileDrag` 传入。回调负责准备 Blob 或 URL 内容及报告本地化失败；组件显式接收它们。可选的 `resourceAddress(path)` 提供 Session 资源引用，以便 Desktop 经授权后复用源文件。
3. 自定义输入框实现可通过自己的注入接口接收 `ctx.fileDrag.read`，以接受应用内令牌。`conversation.input.attachments` 插槽的公开 props 不变；只有内置附件实现要求该回调。内部投放仅在输入框范围接受，外部文件保留普通 `dataTransfer.files` 处理。
4. 重新构建自定义包，验证图片拖入输入框后的原始文件名和字节，并确认拖回源图不会增加附件。所有权和浏览器限制见[文件拖放插件](../../../../packages/client/ui-file-drag/README.zh.md)。
