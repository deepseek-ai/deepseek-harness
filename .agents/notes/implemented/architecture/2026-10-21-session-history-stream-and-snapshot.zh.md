# Agent Note: Session 快照、纯订阅与 Web 聚合

Status: implemented

[English](2026-10-21-session-history-stream-and-snapshot.md) | 中文

## Problem

定点读取、事件订阅和 Web 会话开场具有不同的生命周期。把它们合并在同一个历史控制器中，会使被动观察执行不必要的读取，并让每个聚合各自维护获取数据的逻辑。先读后订阅还会产生需要再次读取来修复的缺口。接口需要相互独立的操作，使组合既不丢事件，也不重复资源所有权。

## Decision

`SessionController` 是唯一的 Session Remote Service。它持有普通的 `HistoryController`、`StateController` 和 `WebController` 实例，而不是额外的三个 Cordis Service 或 Remote namespace。实现分离六个操作：历史快照与观察、投影快照与观察、状态快照与观察。Follow 和 Wait 为调用方组合这些能力；已有的 `page` 入口转发到历史读取器。

### 读取与订阅

历史读取返回时间正序的记录、`hasMore` 和包含末项的游标。省略 `throughSeq` 时选择观察到的日志末尾；`beforeSeq` 只选择更早的记录，不改变读取点位。投影读取返回精确的有序值、需要迁移时无序号的缓存提示，或在 Session 不存在时返回 null。live 投影读取不访问持久化元信息。

`usingObservation({ sessionId, projection }, signal, callback?)` 获取已有的可释放 SessionObservation。有回调时租约借给回调直到其结束；无回调时由调用方释放。普通历史、状态及 Wait 输出读取不请求投影。Follow、精确投影读取和子会话历史 descriptor 校验请求投影。读取不会隐式激活 Agent。

`observeEvent` 和 `observeProjections` 安装监听而不获取 Observation。首个 `ready` 确认订阅生效，不代表快照游标、实体存在、父子关系有效或 Agent 就绪。历史从首个收到的事件建立连续性；投影更新替换单个键，多个更新可以共享序号。`observeState` 则从完整状态读取开始，并合并后续 Session 和 Agent 失效通知。

历史、历史观察和 Follow 接收 Address 请求；投影和状态操作接收 Session ID。所有内部读取器和监听器都使用 Session ID。History 和 Follow 在 Controller 层以开场 Observation 校验 Address，包括已有的子会话 descriptor 规则。纯历史观察不为实体校验获取读取。Gateway 资源授权与之独立：注册的 Session 解析器在访问判定前从请求提取目标 ID。

### Follow 顺序与所有权

Follow 先安装历史和可选 assistant 监听，再获取一份带投影的 Observation。它同步捕获 assistant 基线和绑定局部的到达序号，设置两种截断点，发布开场快照，然后消费共享输出队列。消费时丢弃序号不超过快照游标的历史通知，以及到达序号不超过截断点的 assistant 通知。后续通知保持顺序，无需第二次历史读取、后台合并任务，或由开场自身引入的尾部修复。

`session/created` 经同一历史缓冲提供构造期种子事件。适配器保留收到的 Session 及捕获的末尾位置，在消费时读取对应内存前缀，不获取另一份 Observation。每个绑定拥有自己的订阅；共享输出队列属于 Follow，而不是任一监听器。

只有调用方传入 `activate: true` 时 Follow 才激活；Web Client 显式传入该参数。后台提升在开场计算完成后、交付之前启动，不承诺 Agent 已就绪。普通提升复用已有 Agent controller，并接收单独 retain 的 Observation。两种 Follow 都在开场计算完成后、交付前释放开场 Observation；激活则继续使用单独 retain 的租约，因此冷 entry 的引用计数只剩那一份。子会话不走普通提升。

### 状态与 Wait

State 包含事件游标、active 与 running 标志、完整可读队列或 null，以及待输入种类。它不暴露 header 或内部 revision。Gateway 拥有未结算的 Remote 事件；State 采样独立元数据，将输入分类为 approval、question 或 other，不复制请求注册表。

Wait 判断完整状态，通过 `whenIdle` 确认活跃 Agent 已静止，并通过监听器局部 revision 和 Agent/Session 身份检查拒绝过时观察。Session 和 Agent 事件立即唤醒读取；等待期间每秒重查一次，检测没有产生上述事件的待输入请求。这避免新增 Gateway change 事件，代价是轮询和采样延迟，而非即时通知。`observeState` 不轮询，因此仅有 pending 变化时，需要另一项状态失效通知才会显示更新。

Wait 返回 idle、input-required 或 timeout，以及最后一次被接受的状态和有界 assistant 输出。输出仅包含 `(afterSeq, state.cursor]` 内从新到旧的 `assistant/message` 记录，只有存在另一条符合条件的记录时才报告截断。输出读取使用调用方的取消信号，不受已过期的等待截止信号控制。截止前没有任何状态通过校验的 wait 会失败，不构造虚假的状态。

## Alternatives considered

**先读历史，再订阅并修复缺口。** 先订阅后读取已经捕获开场期间的增量。第二次读取增加资源获取和重放责任，却不改善这个顺序。

**给纯订阅提供 Observation 或 ready 游标。** 这会混淆订阅就绪和独立选取的读取点位。需要两者的调用方先订阅并缓冲，再读取并丢弃已覆盖增量。

**为各实现 Controller 保留独立 Remote Service。** 这些类划分行为，而不是外部服务身份。一个 Session Service 拥有其组合、资源策略和 Remote 入口。

**让 Gateway 解释待输入状态或发送 Session status。** Gateway 只拥有 Remote 事件传输和未结算事件元数据。State 拥有分类；Wait 定期采样，避免仅为 Session 等待增加传输通知。

**用独立异步任务合并 assistant 与历史。** 调用方拥有的单个缓冲保留跨来源到达顺序，不引入额外任务取消或队列所有权。快照构造和各绑定缓冲仍保留不同生命周期。

## Consequences

标准读取和 Web 聚合共享同一 Observation 获取路径，纯订阅不读取数据。旧的合并 History controller 已删除；仍使用的分页、校验和 wire 辅助函数留在原路径。取消、消费者结束、开场读取失败和 Context 释放都会释放订阅及拥有的租约，而不取消 Agent 执行。

[Observation 决策](2026-08-25-session-observations-and-projection-owned-client-state.zh.md)仍拥有精确读取点位和投影派生规则。[历史与 Remote 传输决策](2026-08-18-session-history-and-event-transport.zh.md)继续拥有 Client 重连和传输生命周期。本决策细化 Session API 组合，而不取代上述更广泛的决策。

迁移后的历史、冷读取和传输测试覆盖新类，包括游标重叠、assistant 到达序号截断、序号缺口、子会话校验和释放。慢消费者仍可能积累队列通知；静默丢弃不是支持的恢复策略。这些读取以及 Follow 的后台激活选项均未实现独立的、确认完成后返回的激活接口。
