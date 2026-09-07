# Agent Note: Tool-row file-open failures stay visible

Status: implemented
Archived: 2026-09-04

[English](2026-08-18-tool-row-file-open-failure.md) | 中文

## 问题

工具行路径点击已经通过聊天视图注入的 `openFile` 调用 `session/openWorkspacePath`。inject 吞掉了每一次 Host 或操作系统拒绝，因此缺少桌面打开器、远程或非回环载体、或 Host 无法交接的路径，都会让该行看起来像成功。读者看不到原因，也无法再试一次。

[用系统应用打开文件的决策](../feature/2026-07-28-tool-call-file-open-in-os.zh.md) 仍然拥有链接手势和 Host 交接。本 Agent Note 只拥有拒绝路径。

## 决策

inject 返回 `workspaces.openPath` 的 promise。聊天视图包装该打开器：拒绝时打开页面内 Modal，展示抛出的文本（文本为空时用未知打开回退文案），并提供对同一路径的重试；取消、Escape、关闭控件和点击遮罩会关掉对话框。关闭之后才落到的结果会被忽略，因此已取消的进行中拒绝不能再次打开对话框。

对话框位于 chat 视图（拥有 Host 调用），而不是每个工具行。产物文件标签和收尾消息中的提及已经共用该打开器，因此走同一包装。产物文件的文件夹操作打开 `.`，该拒绝使用文件夹标题和未知打开回退文案。

Host 消息按抛出内容展示。聊天视图的 `openFile` adapter 会在 Remote 错误前加上 `path open failed: ` 前缀；对话框不拆掉该前缀。

## 考虑过的替代方案

- **按行内联错误。** Host 调用由会话拥有，多个入口共用一个打开器；行内横幅会在每个点击目标旁重复同一拒绝。
- **没有重试的 toast。** 产品要求同时给出原因和重试入口。工作区文件夹采纳对话框已经把这两者配对。
- **写入 chat store 并跨 remount 保留。** 打开失败是瞬时视图状态。chat store 会在视图 remount 后存活，于是残留对话框会在无法有效重试原手势的页签切换之后回来。

## 后果

从读者一侧看，静默的 Host 拒绝不再等同于成功。无头或远程部署点击路径时，能看到桌面交接为何没有发生。视图多持有一个请求世代计数器，使关闭与重试在竞态下仍然安全。

## 测试

包测试覆盖 inject 拒绝、对话框文案（Error、非 Error、空文本、工作区文件夹）、同一路径重试、取消，以及关闭之后才落到的结果。`apps/web/tests/seeded-history.e2e.ts` 在冷恢复的 read 行上把 `session/openWorkspacePath` stub 为失败，用 `file-open-failure.expected.md` 钉住组装后的对话框，并断言英文原因以及对同一 payload 的第二次调用。
