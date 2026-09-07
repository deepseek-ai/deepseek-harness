# Agent Note: Python SDK 递归会话通知

Status: implemented
Archived: 2026-09-04

[English](2026-07-24-recursive-python-sdk-session-notifications.md) | 中文

## 问题

Python SDK 过去通过将每条通知的 payload 与根会话 ID 直接比较来过滤轮次通知。直接子 agent 的生命周期通知因 parent ID 指向根会话而能够通过，但孙级生命周期通知与所有后代 `session.event` 都会被拒绝。JSON-RPC 服务器仍会发出这些通知，因此它们会堆积在底层全局队列中，而高层消费者会丢失嵌套轨迹的关系与结束状态。

## 决策

`HarnessClient` 会在分发通知前，记录每条有效 `subagent.started` 所包含的 child-to-parent（子到父）关系。后续的 `subagent.finished` 会依据自身不可变的 parent ID 路由，但不会改写当前祖先关系，因此旧 run 即使在其 child ID 已被复用后才结束，也无法覆盖替代它的新会话。其他会话通知会沿客户端生命周期内保存的祖先关系图回溯自身 session ID，判断它们是否属于请求的根会话。该关系图会跨连续订阅保留，因此某个后代即使在一次 `Session.run()` 结束后仍然存续，在后续轮次中发出通知时仍能正确归属；客户端启动新的运行时进程时会重置关系图。

`Session.run()` 通过 `TurnResult.notifications` 与 `on_notification` 提供已发现会话树的完整通知流。只有 `sessionId` 等于请求根会话的 `session.event` 才会进入 `TurnResult.events` 或参与最终回复重建。因此调用方能够观察后代事件，同时子会话回复不会覆盖根会话回复。

## 考虑过的替代方案

**在每条 JSON-RPC 通知中加入根会话 ID。** 服务器已经提供精确的直接父子关系；在线路协议中重复传递祖先关系，会迫使每个生产者承担客户端订阅状态的职责。

**把 subagent 限制为一层。** 部署可以设置 `maxDepth: 1`，但让 SDK 依赖该策略，会对合法的递归组合产生静默误报。

**只订阅后代生命周期通知。** 这可以修复关系与结束状态的上报，但后代会话事件仍会堆积在全局队列中，回调看到的会话树也不完整。

**在 JSON-RPC 线路上公开并索引每个 subagent run ID。** 当客户端必须关联同一 child 的两个并发结果时，精确 run 身份很有价值；但会话树路由已经拥有权威 start 关系和每条终止通知中不可变的 parent。没有必要为这一归属决策扩展协议。

## 后果

高层消费方会按协议传输顺序收到嵌套生命周期与会话通知，同时根轮次结果保持原有回复语义。客户端会为每个已观察到的子会话保留一条当前父关系，直到运行时重启；祖先回溯能够安全处理环，无关会话通知仍可从全局队列获取。无密钥 Python 测试覆盖两层委派、根回复隔离、会话树通知不堆积、跨订阅复用祖先关系，以及旧 run 乱序结束的复用 child ID。
