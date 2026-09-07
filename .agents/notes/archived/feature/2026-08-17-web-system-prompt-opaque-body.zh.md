# Agent Note: System prompt expands into the opaque context body

Status: implemented
Archived: 2026-09-04

[English](2026-08-17-web-system-prompt-opaque-body.md) | 中文

## Problem

Chat 的 `系统提示词` 行和上下文注入共用 `DisclosureRow` 外壳，其展开内容区需要呈现请求的 system 字段。如果把该字段渲染成 Markdown——标题、强调、列表——读者看到的将是模型从未收到的排版文档。上下文注入已经用 141px 代码块滚动区和保留模型所见字节与换行的 `<pre>` 文本解决了同一件事，因此该行需要复用这一呈现，而不是再造一套。

## Decision

`SystemPromptRow` 展开后挂载与不透明上下文注入相同的内容区。它复用 `ContextInjectionRow.module.css` 的 Figma 10:2482 的 141px 滚动区，并把持久 `request/header` 的 system 字符串作为一块文本交给 `OpaqueBody`，因此展开后看到的是带真实换行的模型可见文本，以及相同的 20_000 字符显示上限。该行默认折叠，仍然没有流式路径。它不增加生产者标签、form 标记或 source 字段列表：system 字段是 header 上的一段拼接字符串，不是带 source 的 `user/message`。

## Alternatives considered

**在卡片式内容区里渲染结算后的 Markdown。** 外壳可以对齐，但 Markdown 会改写模型读到的内容。标题或加粗是另一份文档，不是请求里的字节。

**把拼接后的 system 字符串拆成 snapshot 分段。** 持久 header 只保存组装后的文本。客户端臆造分段边界会把日志未命名的正文归到某个子系统，恢复或外来 header 也无法重建这些分段。

**直接走 `ContextInjectionRow`。** 那一行面向带 source 的 user-role 消息：它标角色、显示生产者，并按 form 选内容区。system 字段是另一件持久事实，没有这些字段。

## Consequences

两处展开现在共用同一套内容区外壳和同一套文本展示，因此之后改 141px 滚动区或不透明显示上限会同时作用到两边。代价是较长的系统提示词在 141px 而不是 360px 内滚动，提示词里的 Markdown 标记会以字符形式可见。

## Testing

`packages/client/ui-chat/tests/system-prompt-row.client.spec.tsx` 会展开并折叠该行，并钉住不透明 `[data-context-text]` 字节，包括不得变成标题的 Markdown 标记。`apps/web/tests/replay-round-trip.e2e.ts` 仍会打开组装后的展开行，并从该内容区读出 persona 行。
