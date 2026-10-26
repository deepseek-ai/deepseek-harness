# Agent Note: 手动继续生成

Status: implemented

[English](2026-10-26-manual-generation-continuation.md) | 中文

## 问题

模型请求失败后，用户需要发起下一轮。浏览器分页可能不含失败轮次的起点；流式输出也不能反复复制已加载历史。

## 决策

播放按钮通过现有 composer 提交本地化的普通用户文本，沿用准入、日志、失败草稿和遥测语义。不引入 resume RPC，不修改 AgentLoop 或 Session 事件格式。

固定大小的 Host 投影 `conversationContinuation` 从完整 Session 历史恢复。资格要求已准入的普通用户输入和失败尝试，不依赖浏览器的 500 条消息分页。

六类手动继续白名单独立于[自动重试策略](../../../../packages/llm/llm-retry/README.zh.md)。`next-step` 中待处理的[注入上下文](../architecture/2026-07-24-separate-context-injection-from-turn-execution.zh.md) 随新的唤醒消息进入请求；待提交的普通用户消息仍阻止重复提交。

## 考虑过的替代方案

**窗口扫描或 entries 缓存。** 每个 revision 都可能物化新窗口；缓存无法恢复尚未加载的事实。

**采用提供方的 retryableCodes。** 部署重试策略可能把认证等不适合的错误也变成界面动作。

**新增 resume RPC。** 普通提交已经拥有唤醒、准入、错误报告和历史。

## 影响

Host 激活需要 `sessionProjections`；自定义组合按[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.3/conversation-continuation-projection/guide.zh.md) 调整。固定大小的状态避免 Client 历史扫描，也无需第二套提交生命周期。

## 验证

测试覆盖检查点恢复、长轮次分页、注入上下文、拒绝与草稿保留，以及不读取 Client 事件窗口。已录制的 Web 场景验证失败后的继续流程。
