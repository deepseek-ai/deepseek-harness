# Agent Note: 实时 assistant 流帧与 Session log 保持分离

Status: implemented
Archived: 2026-09-04

[English](2026-08-31-live-assistant-stream-frames.md) | 中文

## 问题

v2 Session log 通过一个 `assistant/message` 或 `assistant/attempt` settlement 保留完整紧凑带时间 stream，因此 replay、冷读、遥测与请求重建都能观察同一份持久历史。实时消费方还需要在请求运行时逐帧呈现。把瞬态呈现 update 当作另一种持久事件，会恢复 token 粒度事件基数，并让只属于进程生命周期的事实跨重启保留。

## 决定

`dsh-agent-loop` 为每次模型 attempt 发出作用域内的 `agent/assistant-stream` frame。`start`、`chunk` 和 `end` 带有在单个 Agent lifecycle 内唯一的 branded `LlmAttemptId`；每个 frame 都会推进一次该 lifecycle 本地 revision。start frame 给出该 attempt 的 turn 与 step，chunk index 从零开始密集递增，chunk 时间戳会被紧凑 stream 复用，`end.index` 等于下一个 chunk 位置。loop 会先取得 stream 并执行最终取消检查，再发出 `start`；这些步骤失败时不发出任何 frame。每个已开始 attempt 都会发出一个终态 end：loop 会在 committed end 命名事件与 seq 前追加最终 `assistant/message` 或 `assistant/attempt`，而 assembly 或 settlement failure 会发出不命名持久目标的 abandoned end。已认证 Session-follow 接受显式 Web opt-in，以缓存的活跃 attempt 紧凑 baseline 打开，并在一个 FIFO 中携带持久事件和无 cursor frame。每个 follower 会随 opening baseline 捕获本地到达序号，并丢弃该 cut 及之前的 buffered frame；replacement Agent 的 frame revision 可以从一重新开始，因此 revision 不定义 opening cut。活跃 opening 之后到达的 settlement 只有在其 seq 晚于 `startedAfterSeq` 且 Turn 与 Step 匹配时才属于该 attempt；它会保持暂存，直到匹配的 end index、type 与 seq 到达，而同一 Turn 和 Step 中更早的 retry 仍保持可见。已知 attempt 的 revision、密集 index 或 settlement 缺口会重新打开 follow 并替换 baseline；unknown-attempt frame 回退到持久 settlement。TypeScript 和 Python SDK 协议不公开这些 frame。持久 settlement 仍是 replay 与模型历史的真源；其表示由 [v2 stream 决策](2026-09-01-v2-embedded-assistant-streams.zh.md)负责。

## 曾考虑的替代方案

- **只保留 live stream**：不采用，因为冷读、replay、遥测、usage 记账与失败 attempt 诊断需要持久嵌入式 stream。
- **把每个 live frame 作为独立事件持久化**：不采用，因为进程本地 attempt id、revision 与重连呈现不会跨重启保留或影响模型重建；一个 settlement 拥有持久 stream。
- **用未加品牌的请求字符串作为尝试键**：不采用，因为消费方需要一个不透明身份，不能把它与 provider request ID 或持久 Session ID 混淆。
- **让 UI Chat 订阅第二个实时 source**：不采用，因为 Session 对象拥有 stream 对账，UI Conversation 是唯一的 event-source 订阅方；第二个 source 会使结算顺序依赖 target。

## 影响

Web client 可以在 attempt settlement 前渲染内存 chunk，同时保留一份持久 v2 历史。进程重启后没有活跃 Assistant frame；重连只能恢复当前进程持有的 baseline，冷 replay 则展开持久 settlement。无 cursor 通知绝不推进 journal cursor，在持久缺口修复期间观察到的通知会等待 replacement page。该 page 不携带 Assistant baseline，因此 Client 会清空瞬态 attempt，并让 held notification 重新打开 follow 一次，以取得配对的 page 与 baseline。frame 声明保持 agent 作用域，因此监听器只观察所属 Agent，除非它显式全局注册。
