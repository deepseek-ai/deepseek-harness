---
kind: upgrade-guide
description: 重新打开已保存的计划预览，并把自定义文档正文迁移到共享内容渲染。
---

# 共享侧栏内容预览

[English](guide.md) | 中文

## 变更

计划和待审批内容改用共享 `content` 标签，不再使用独立的 `plan` 或 `plan-review` 标签类型。升级后，旧布局中这两类标签显示不可用。新标签接收的正文是临时内容，刷新浏览器后会过期。

自定义文档正文使用 `sidebar.right.document.body` Factory，输入区分 `resourceAddress` 与控制相对文件解析的可选 `baseAddress`。压缩标记保留 `summaryEventSeq`，移除内联的 `summary` 正文。预览通过稳定的会话资源地址读取摘要，刷新浏览器后会自动恢复。

## 迁移

1. 关闭旧布局中不可用的计划标签，并从计划或审批卡片重新打开。需要预览的组合应加载 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`；它的可选服务缺席时，计划打开按钮保持禁用。
2. 调用 `ctx.sidebarRight.openContent({ mediaType: 'text/markdown', text }, { title, key })` 打开正文。方法直接打开侧栏，`destination: 'float'` 使用浮窗。刷新浏览器后请重新打开预览。
3. 通过 `sidebar.right.document.body` 挂载自定义渲染器，提供 `rendererId` 和 `useTabInfo`。工作区文件传入 `baseAddress: resourceAddress`，没有文件基址的正文省略它。
4. 将压缩标记上非空的 `summaryEventSeq` 传给压缩预览服务以显示记录的摘要。
