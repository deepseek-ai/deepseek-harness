---
kind: upgrade-guide
description: "渲染 Session Conversation 的 Client 插件需以 conversation 子要素 retain 该 Session。"
---

# 渲染 Session 时请求 `conversation` 子要素

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-api-session-controller/client` 中的 `sessions.retain()` 接受可选的 `facets` 记录。每个引用仍会保活 Session 的历史流，但 Conversation 组装现在只在某个引用保留了 `@deepseek-ai/dsh-client-ui-conversation` 声明的 `conversation` 子要素时才运行。原有调用签名仍可编译。若 Client 插件以自己的来源 retain Session、并在 `SessionProvider` 中渲染它，却未请求该子要素，它显示的是其他视图上次渲染该 Session 时的 Conversation 快照或空快照，quota 提示也不再出现。内置的主视图、右侧边栏 Session 视图和 subagent 侧栏聊天已经请求该子要素；仅为调用 Session 操作而 retain 的插件不受影响。

`retain()` 还接受 `connection`，默认 `true`；`false` 只保活 Session 对象及其本地状态（如输入框草稿），不保留事件连接和事件窗口。通过 `sessions.retainInfo(id)` 读取的 `SessionRetainInfo` 新增可选的 `retainedFacets` 与 `connectionCount` 计数，为零时字段不存在。

## 迁移

1. 找出每个把引用交给渲染 Conversation 内容的 `SessionProvider` 的 `sessions.retain(target, { source: ... })` 调用。
2. 为这些调用加上该子要素：

   ```ts ignore-check
   sessions.retain(target, { source: 'myPanel', facets: { conversation: true } })
   ```

3. `sessions.using()` 调用以及只调用 Session 操作的引用保持不变；只有在既不需要事件也不需要历史时才传 `connection: false`。
4. 确认迁移：在你的视图中打开一个主视图未显示的 Session，从中发送一条 prompt，确认回复会在你查看时出现；视图打开期间，`sessions.retainInfo(id).getSnapshot().retainedFacets?.conversation` 读到正数。
