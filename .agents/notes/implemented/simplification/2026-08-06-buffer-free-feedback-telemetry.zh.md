# Agent Note: 无缓冲反馈遥测

Status: implemented

[English](2026-08-06-buffer-free-feedback-telemetry.md) | 中文

## 问题

仅反馈遥测必须只在记录反馈后上传会话日志前缀。若在触发前为每个已投影事件保留一份已深拷贝、已脱敏的记录，就会复制权威会话日志；对于长期运行但从不记录反馈的会话，这份副本会无限增长。

## 决策

遥测 coordinator 提供 `live` 与 `on-demand` capture。按需 capture 不注册 Session、flush 或 operational-event listener，也不保留 record 副本。`captureSession(session, throughSeq?)` 从同一对象 handoff cursor 之后读取规范 Session log，直至可选的包含式序号 boundary，按序 deep-copy 每个 event、运行当前 `session-telemetry/record` waterfall，并为每个 event 向 backend 交接一条 record，其中包括生命周期本地的每个带完整嵌入式 stream 的 `assistant/message` 或 `assistant/attempt`。新 Session 对象没有 WeakMap entry，因此逻辑 cursor 位于 `firstLiveSeq` 之前：全新对象为 `-1`，fork、resume 或迁移对象则为 constructor seed 的最后一个序号。

`FEEDBACK_ONLY` 以 `feedback/record` 事件的序列号调用该方法。`session/event` 监听器运行时，追加已经提交，因此回放包含该反馈事件，且无法包含后续后缀。以对象为键的 handoff 游标可区分后续回放，无需另一个待处理记录索引：同一对象上的重复反馈只释放后缀，而新的 resume 或迁移对象上的首次反馈只释放本生命周期边界及其后缀。

按需捕获只读取权威日志，因此不会发出 `agent-error` 或 `shutdown` 运维记录。脱敏在反馈时而非追加时求值。[反馈模式决策](../feature/2026-08-05-feedback-gated-session-telemetry.zh.md)规定公开的共享行为；本记录规定其无缓冲实现。

## 考虑过的替代方案

**保留捕获时的已脱敏记录。** 该方案会保留每个事件发生时观察到的确切脱敏策略与运维记录，但也会复制无上限的会话前缀。该模式承诺在反馈触发后上传会话日志，而非保留捕获时策略快照或反馈前运维遥测。

**保留会话事件引用或序列号。** 已否决，因为权威日志已同时提供顺序与身份。第二个索引可以省去载荷副本，但会增加生命周期状态，且无法实现任何必需行为。

**写入持久化的反馈前 spool。** 推迟到有部署要求反馈前的崩溃恢复时再实现。该方案会为一个预期在进程于反馈前退出时不上传任何内容的模式增加存储、清理与保密策略。

## 后果

没有反馈的会话不会消耗随事件数量增长的遥测自有内存；权威会话日志仍是反馈前的唯一副本。反馈处理会在后端非阻塞入队前同步执行深拷贝与脱敏，因此其开销随未释放的生命周期本地前缀增长，并包含该后缀中的每个嵌入式 Assistant stream。反馈前的脱敏策略变更会影响该次回放；反馈前发生崩溃时不会上传任何内容。每个新对象首次捕获时从 constructor boundary 开始；同一对象上的后续反馈只处理 handoff 游标之后的事件。接收端基于 `(session.id, session.format_version, event.seq)` 对重复的生命周期本地行去重。
