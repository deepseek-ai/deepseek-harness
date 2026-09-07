# Agent Note: 聊天流展示 max-tokens 结束的轮次

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-max-tokens-turn-end-notice.md) | 中文

## Problem

agent loop 已把 `max-tokens` 记录为独立的 `turn/end` 原因，但没有任何用户表面消费它。Web 聊天流中只有 `reason.kind === 'error'` 会生成会话节点，unknown-surface 兜底又只接管 append-surface 事件，于是被提供方在输出上限处截断的轮次没有任何可见迹象：被截断的回答看起来和正常完成一样，用户无从得知运行为何停止（issue #1522）。

## Decision

新增 `turn-max-tokens` 会话节点 Definition，匹配 `reason.kind === 'max-tokens'` 的 `turn/end`，在该轮位置生成一条持久聊天行：warning 状态的 StateDot、本地化标题，以及说明已截断输出会保留、发送“继续”可在新一轮接着输出的指引。节点只从持久会话事件推导，因此刷新、恢复和历史回放会重建出完全一致的结果。提示不显示任何 token 数字：事件本身不携带数量，提示也不得伪造提供方未报告的预算数据。

渲染器与其他聊天行一样注册在按 kind 分发的 `conversation.chat.node` 槽位下，legacy chat-snapshot 投影也包含该节点。fixture 历史新增了一个 max-tokens 样本轮（72，图片轮和 todo 轮顺移为 73、74），并有一条 assembled keyless snapshot 钉住圆点状态、标题和指引文案，把 max-tokens 路由回错误样式或再次静默的回归都会改动 golden。

## Alternatives considered

**在 `turn-error` 上加一个 max-tokens 分支** — 否决：issue #1522 的验收要求 max-tokens 不得呈现为普通 provider error；共用节点会耦合两种呈现，且两种原因携带的数据不同（一个有错误负载，一个没有）。

**用 turn-tail 标记代替独立聊天行** — 否决：turn-tail 渲染的是完成轮次的收尾信息，其操作会在后续轮次折叠，而截断提示必须停留在被截断的那一轮，并且在历史中无需交互即可看到。

**在提示上放继续或重试按钮** — 暂缓：恢复输出的语义尚未确定（新开一轮还是同轮续写、旧输出保留规则），issue #1522 明确把它排除在范围外；指引文字已给出安全的下一步，不必先固定一个操作契约。

## Consequences

max-tokens 结束在实时流、刷新和回放中都可见、已本地化，并与错误和正常完成明确区分。fixture 重编号需要更新两处依赖 snapshot 的注释，之后钉 fixture 轮次号的改动要按新布局计数。Web 聊天流之外的表面（ACP 和 SDK 消费方）仍按各自的呈现映射该原因，本次不变。
