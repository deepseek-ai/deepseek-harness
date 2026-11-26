# Agent Note: 侧栏对话把来源记录为 `parentSession`

Status: implemented

[English](2026-11-26-side-conversation-source.md) | 中文

## 问题

侧栏对话是在来源旁边打开的普通 fork；要列出一个来源的侧栏对话，需要持久的来源关系。[独立 fork 决策](2026-10-23-independent-session-forks.zh.md)让普通 fork 不再持久记录来源 id，因此没有任何持久字段把侧栏对话和分出它的对话联系起来。唯一的持久关系字段 `SessionHeader.parentSession` 只为 subagent 写入，而有三个消费者把它的存在当作委派的证据：auto-review 给与 `parentSession` 匹配的发送者授予直接父级指令权威，IM 沿 `parentSession` 解析子会话的宿主 chat 与授权，会话日志导出把每个 `parentSession` 后代都打包为 subagent 日志。

## 决策

`origin: 'side'` 的 fork 在 Host header 上把来源记录为 `parentSession`，在 Client 占位行上记录为 `parentSessionId`；普通 fork 仍然不记录。`parentSession` 表示创建本会话的那个 Session；它是哪一种子会话只由 `origin` 决定。

- `origin: 'subagent'` 是委派的唯一分类依据。[auto-review](../../../../packages/experimental/auto-review/src/index.ts) 只对 subagent 的委派父级授予直接父级指令权威，[IM](../../../../packages/experimental/im/src/sessions.ts) 解析宿主 chat 时只经过 subagent 的创建者，[会话日志导出](../../../../packages/session-query/session-log-export/src/archive.ts)只把 subagent 打包为后代日志；侧栏对话以及在独立 fork 决策之前保留了来源 id 的普通 fork 都不享有这两者。其余读取 `parentSession` 的地方要么本来就按 `origin` 分类，要么只把它当关系使用：lineage 追溯、session query 工具的 parent 列和 telemetry 的 `session.parent_id` 都包含侧栏对话。
- 左侧栏像沿 subagent 创建者那样沿侧栏来源解析当前查看会话所在的行，因此在主视图打开的侧栏对话会高亮其来源；侧栏对话本身的行保持平铺且不列出。

## 曾考虑的替代方案

**单独的 `sourceSession` header 字段。** 只增不改，对所有现有读取方都安全，但它是第二个关系字段，多一个持久化 header 成员、一个 Client 摘要字段，以及各自的目录与迁移确认。上述三个消费者无论如何都需要检查 `origin`，因为创建者是侧栏对话的 subagent 本来就会经过一个侧栏对话。

**为每个普通 fork 记录来源。** 技术上没有障碍：历史普通 fork 带有 `parentSession`，已发布的 reader 对继承的投递确认要求有 parent，这个字段只会扩大兼容性。但它推翻了"普通分支是独立对话"的产品选择，而当前没有消费者需要它；侧栏对话是唯一需要这层关系的子会话。

## 影响

- 只看 `parentSession` 的读取方会把侧栏对话当作被委派的工作。分类读 `origin`；`parentSession` 是关系。
- 在记录来源之前创建的侧栏对话没有 `parentSession`。是否列出它们不在本决策范围内。

## 测试

[`session-fork.host.spec.ts`](../../../../packages/api/session-controller/tests/session-fork.host.spec.ts) 以及 Client manager 与 service 的测试覆盖记录的来源和占位行；auto-review、IM、会话日志导出和 Workspace tree 的测试覆盖各消费者的 `origin` 规则。
