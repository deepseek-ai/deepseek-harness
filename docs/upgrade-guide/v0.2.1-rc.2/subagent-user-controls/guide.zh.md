---
kind: upgrade-guide
description: "子代理用户控制仅按目标 Session 寻址，重命名中断端点，并以目标 Session 权限替代 global 权限。"
---

# 子代理用户控制按目标 Session 寻址

[English](guide.md) | 中文

## 变更

浏览器和自定义 Remote 调用方发送子代理提示词时，不再提供 `parentSessionId` 或 `mode`。`subagents/interruptByParent(childSessionId, parentSessionId, mode)` 替换为 `subagents/interruptByUser(childSessionId)`。创建祖先、历史地址、完成通知接收者和持久化 Session 数据保持不变。

两个操作都将子会话声明为 `session` 访问资源。非 owner 策略必须授予该 Session 上对应操作的权限；`global` 绑定或父会话上的绑定不授予访问权。owner 行为保持不变。模型消息仍限于同一棵子代理树，模型中断仍仅允许祖先发起。

同进程 `SubagentInterruptAuthority` 的用户分支为 `{ kind: 'user' }`。已发布的 `@deepseek-ai/dsh-subagent/internal` 入口已删除，包括宿主 prompt 适配器和工具身份标记。远程授权由 Gateway 执行。

旧提示词载荷在 `request` 内多带字段时，可以在新 Host 上解码，但须满足新的访问规则。旧中断调用因端点已移除而失败。新调用方要求新 Host。自定义客户端和宿主应一起升级；内置 Web 客户端随 Host 一起交付。

## 迁移

1. 从子代理提示词请求中移除 `parentSessionId` 和 `mode`。保留 `childSessionId`、`requestId`、`delivery`、`content` 和可选的 `clientTimeZone`。
2. 将 `interruptByParent(childId, parentId, 'continuable')` 调用替换为 `interruptByUser(childId)`。
3. 更新非 owner 策略，在 `{ kind: 'session', id: childId }` 上授予 `subagents/prompt` 和／或 `subagents/interruptByUser` 权限。父会话到子会话的授权仍由策略显式决定。
4. 从 `{ kind: 'user' }` 中断授权中移除 `parentSessionId`。替换 `@deepseek-ai/dsh-subagent/internal` 的导入：经过认证的用户 prompt 使用 `subagents/prompt`；模型编写的消息使用 `ctx.subagents.sendMessage()`。不再提供允许任意来源的公开宿主 prompt 适配器。自定义工具通过工具描述和 `systemPrompt.context()` 提供说明，无需身份标记。历史地址和创建记录仍保留父级 id。
5. 验证获准操作目标的用户能够发送和中断，而仅获准操作父会话或 global 资源的用户在输入或取消被接纳前遭到拒绝。
