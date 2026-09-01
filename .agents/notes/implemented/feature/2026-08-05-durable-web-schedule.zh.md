# Agent Note: 持久、仅限 Session 内的提醒

Status: implemented

[English](2026-08-05-durable-web-schedule.md) | 中文

## 问题

在对话中创建的提醒必须始终归属于确切的那个 Session，并且跨进程重启存活。进程本地 timer 或 inbox 项无法提供这种持久性，而全局 scheduler 或私有数据库又会引入第二套身份、持久化和生命周期系统。

繁忙的 Agent（智能体）、长等待、墙钟变化、cold Session、fork、持久化失败、绝对日历输入和资源释放，使简单 timeout 无法满足要求。设计必须区分持久记录与可丢弃的 live wait，阻止 fork 继承父 Session 的活动提醒，并避免把 Schedule 专属的呈现或时区状态扩散到无关组件。

## 决策

[Schedule 指南](../../../../docs/user/guide/schedule.zh.md)使用显式加载 `@deepseek-ai/dsh-time-context` 与 `@deepseek-ai/dsh-schedule`，并启用 Web bundle 中默认 disabled 的 `ui-schedule` row 的 overlay。默认 Web 启动图不会激活 Schedule。Schedule 只观察插件加载后发布的根 Agent，并在该 Agent scope 中安装三个工具和一个可丢弃 owner。cold history 读取、已发布的根、child Agent 与其他 host 都不会激活 runtime。

用户可见边界是 `session-local`：原 Session 只有在 live 时才会准时运行提醒，cold 期间不发送任何外部通知；该 Session 再次 live 后才会处理 overdue 提醒。到期工作会等待 Agent 完全 idle，再通过 `followup()` 进入普通的下一轮队列；它绝不会中途引导当前轮次，也没有独立 Web 回执（[对话式交付](../simplification/2026-08-09-conversational-schedule-delivery.zh.md)）。

| 场景 | 持久事实 | live 行为 | 用户可见结果 |
| --- | --- | --- | --- |
| 创建与管理 | 原 Session 中的 `schedule/change` create／delete | Agent-scoped 工具在读取前、变更后执行 checkpoint | 稳定 id、UTC 目标、状态与 `session-local` 说明 |
| 到期时繁忙 | 活动 create 仍在 fold 中 | owner 等待 idle maintenance，排入一个 follow-up，再追加 dispatch | 后续一个普通对话轮次 |
| 多条 Every 记录逾期 | 每条活动记录都保留最早一个尚未接受且与锚点对齐的目标 | 一次决策选择每条记录的最新发生时点，并将其推进到当前时刻之后 | 一个普通 follow-up，其中每条记录各有一个发生时点 |
| 进程停止或 Session cold | 活动 create 仍在 persistence 中 | 不存在 timer 或后台扫描；resume 重建 owner | 未来目标继续等待；overdue 目标会被尝试 |
| fork | 父 event 留在继承前缀 | child fold 从 `seedLength` 开始 | 父工作不会在 child 中变为活动状态 |

### Session 日志权威与工具

版本 1 `schedule/change` stream 是唯一持久的 Schedule 权威。create 记录拥有一个 Session 内不复用的品牌 id、trim 后的提示词、规则判别字段和 UTC 目标。delete 与一次性 dispatch 是终结转换。Every dispatch 会存储 id 与决策时点，使 fold 将该记录直接推进到错过的发生时点之后。严格 decoder 与纯 fold 会拒绝未知版本、额外字段、重复使用的 id、形状不匹配的 dispatch，以及针对非活动记录的转换。普通 Session 折叠完整 stream；fork 只折叠 `SessionHeader.seedLength` 位置及其后的 event。

`ctx.sessionProjections` 存在时，Schedule 会注册一个复用同一 transition 的严格单元，并发布完整的活动 `ScheduleRecord[]`；共享的 [projection state 决策](../architecture/2026-08-19-session-projection-state-and-client-views.zh.md)拥有其初始化与 restore 约定。损坏的持久输入会使既有读取路径失败，而不会产生部分数组。浏览器安全的记录词汇通过纯类型子路径 `@deepseek-ai/dsh-schedule/client` 暴露。

当前规则 union 接受非空提示词和恰好一个 selector。`after_seconds` 是正的安全整数 delay，其记录为 `{ id, kind: 'after', prompt, afterSeconds, scheduledAt }`。`at` 可以是带 `Z` 或数值偏移量且严格符合 RFC 3339 的值，也可以是带显式时区的结构化 `{ date, time, time_zone }`；其记录为 `{ id, kind: 'at', prompt, scheduledAt }`。`every_seconds` 是不小于 300 的安全整数，其 `{ id, kind: 'every', prompt, everySeconds, scheduledAt }` 记录始终与从创建时刻加一个间隔开始的序列对齐。一次性 dispatch 只存储 id；Every dispatch 存储 `id + acceptedAt`。工具值派生 `scheduled` 或 `overdue`，并包含 `deliveryMode: 'session-local'`。

一个 Agent-scoped FIFO 会将管理事务与 live owner 的到期事务从 preflight 到 post-append barrier 全程串行化。每项工具读取都会先等待 `ctx.sessions.flush(session)`。create 会尽可能在进入 FIFO 前拒绝输入形状错误，随后执行 preflight、分配 id、追加记录并再次 checkpoint。delete 会在进入 FIFO 前验证 id，在判断其是否活动前执行 preflight，并且只在追加后再次 checkpoint。list 与 not-found delete 绝不会根据未经确认的 live 后缀作答。barrier 失败会返回 `persistence_uncertain`，而不是猜测 eager write 是否已经提交。

每次成功的管理 preflight 也会要求 live owner 重新计算。因此，如果先前的 post-append 被拒绝，后续 list 可以确认保留的 create 并将其 arm，而无需私有的 persistence 重试 timer。

### 显式绝对时间边界

自然语言解释与 Schedule 解析被有意分开（[时区简化](../simplification/2026-08-09-explicit-schedule-time-zone.zh.md)）。每条浏览器提示词只在其对应的持久 user message 上携带由 Host 校验过的 IANA 时区。Time-context 会告诉模型，把未明确限定时区的日期和时间解释为该时区。Schedule 既不导入该插件，也不存储 Session 时区：模型必须把其解释结果转换为带偏移量的 RFC 3339 值，或带显式 `time_zone` 的本地对象。

Schedule 会校验精确的日历形状、偏移量、时区名称，以及一个严格位于未来、年份为四位数的时点。落在夏令时缺口内的本地时间会被拒绝；遇到重叠时会选择第一次出现的较早时点。创建成功后只存储规范化后的 UTC `scheduledAt`，不会存储原始偏移量、本地字段或时区。

### 有界固定速率语义

Every 是固定时长间隔，而不是日历规则。第一个目标是创建时刻加上一个间隔。作出到期决策时，整数除法会选出不晚于所采样墙钟的最新序列点，以及其后的第一个序列点。选中的发生时点只呈现一次，记录会直接推进到未来目标，因此 cold Session 绝不会积累回放任务，延迟执行的模型工作也绝不会使该序列漂移。

所有不同的逾期 Every 记录都会参与同一个批次，每条记录各自提供一个最新发生时点，并共享同一个 `acceptedAt`。系统不存在跨记录的冷却、门控、配额或保留的批次时间戳。至少 5 分钟的限制约束了唤醒与模型请求频率。如果下一个序列点会超出四位年份存储范围，dispatch 会终结该记录。

日历表达式与 Cron 表达式被有意排除（[有界周期性简化](../simplification/2026-08-09-bounded-fixed-rate-schedule.zh.md)）；支持这些表达式需要增加时区敏感的日历语言、求值器依赖、校验范围和 tzdata 回放策略，而这些都与固定速率提醒无关。

### Live 交付生命周期

Agent-scoped owner 从持久 fold 派生最早目标。超长目标使用有界 timer 分段，每次 wake 都会重新读取墙钟，因此回拨不会提前触发，前跳则会形成 overdue。已到期的一次性提醒优先，每次准入一条；否则，所有逾期 Every 记录会按目标时间和创建顺序进入同一个批次。如果 Agent 已被某个轮次或另一项 maintenance task 占用，`runMaintenance()` 会拒绝此次认领；这些记录保持活动，并由一次 `whenIdle()` wait 触发另一次尝试。被拒绝的 preflight 或被收容的 framing／入队失败同样会使其保持活动，但不会启动私有重试 timer。

获得准入的路径会刷新所有 pending persistence 并认领真正的 idle phase。它会重新折叠确切的 Session 后缀、采样 decision clock、用经过 JSON 转义的值构造固定提醒 framing、同步排入一个 `followup()`，并在释放 maintenance 前追加 dispatch。一次性提醒会追加只含 id 的终结 dispatch。固定速率批次会为每条参与记录追加一个 `id + acceptedAt` 转换。触发唤醒的 input 会保持 parked，直到 maintenance 释放，因此在 dispatch 进入日志前，消息不会被认领；随后 owner 会为 dispatch 执行 checkpoint。

dispatch 记录的是队列准入，而不是模型完成或用户收到提醒。framing 构造或同步入队失败不会追加 dispatch。append 失败会使该 owner fault，因为消息可能已经入队。Agent 或插件 dispose 会取消 timer、停止新工作、撤销工具注册，并等待进行中的工作，且不会删除持久记录。follow-up 获得准入后、持久 dispatch 前发生崩溃，可能使提醒在恢复后重复；本设计不作 exactly-once 承诺。

### 只读 Web 目录

Schedule overlay 会把默认禁用的 [`dsh-client-ui-schedule`](../../../../packages/client/ui-schedule/README.zh.md) client 与 Host 服务一同启用。完整活动 projection 也会交给 [`dsh-client-ui-workspace`](../../../../packages/client/ui-workspace/README.zh.md)。本 Note 拥有这条 opt-in 只读呈现边界：该 projection 表示当前活动状态，而非 dispatch 或交付回执，因此普通 Assistant 轮次仍是交付呈现。目录是挂到 `document.body` 的 fixed portal；空间足够时左边缘跟随触发按钮，靠近视口右侧时向左避让并保留 16px 边距。`useAnchoredPosition` 拥有测量以及 resize、捕获阶段 scroll、面板 resize 与清理行为；Schedule 提供触发器与 portal ref、bottom 放置、5px 间距和既有内外 dismissal 边界，不增加通用 popover 抽象。

## 已考虑的替代方案

**使用 `ctx.jobs`。** Task 拥有进程本地工作、结果和通知，而不是 Session 日志状态和对话 follow-up。

**把提醒存入私有数据库或全局 scheduler。** 这样可以运行 cold Session，却需要第二套身份映射、启动扫描、ownership lease、崩溃协议和通知策略。

**持久化 Session 时区并推断本地 `at`。** 这会让一个解释默认值扩散到 Session core、Host create／fork、持久化格式、client 和不匹配恢复中。请求本地的模型指导与显式工具边界消除了这种耦合。

**保留独立的持久 Web 回执。** dispatch 是内部队列事实，而不是用户的提醒。渲染普通 assistant 回答既避免了第二种交付含义，也从 Host 与 client 层移除了 Schedule 代码。

**增加通用周期规则引擎。** 固定时长间隔只需要锚点运算。共享的周期抽象、全局准入门控和日历求值器会扩大回放与运行时状态，却不能服务于保留的产品行为。

**在 `followup()` 前认领 dispatch，或增加 exactly-once fencing。** claim-first 会在入队失败时静默丢失提醒。跨进程 exactly-once 需要 lease、outbox、acknowledgement 与下游幂等边界，超出了此 Session-local 范围。

**接管既有根或注册全局工具。** 晚接管会让插件加载顺序激活不可见的 timer，并把工具暴露到受支持的根组合之外。

## 验证

包测试以逐文件 100% coverage 固定严格回放、一次性与 Every 状态转换、创建锚点运算、只追赶最新一次、多记录批处理、fork 后缀、id 复用、偏移量与本地日历 profile、IANA 校验、夏令时缺口与重叠、时间边界、timer 分段、墙钟变化、overdue 准入、固定 framing、入队与 append 失败、barrier 恢复、projection 注册与恢复、注册 rollback 和完全停稳的 dispose。属性测试会在不同间隔与跳过跨度下比较 Every 计算与回放。production JSONL restart 测试证明一条 overdue 提醒会经过真实 Agent 生命周期 dispatch，并且再次 restart 后不会重复 dispatch。聚焦 client suite 拥有目录与侧边栏行为，包括 body portal、空间充足时的左对齐、portal 内指针处理、外部 dismissal、Escape、live empty 与 timer 清理。共享 primitive suite 拥有定位 hook 的 resize、捕获阶段 scroll、面板 resize 与清理生命周期。无密钥组装 Web 场景保留普通 After／At／Every 交付证据，再由一个 900×900 Schedule 目录 smoke 覆盖 overlay 可达性、fixed portal 定位、右侧钳制、宽度与 overflow、普通／搜索闹钟、窄屏暗色布局、浅色主题浏览器截图与一次 live empty 更新。

## 后果

- 提醒状态通过普通 Session persistence 跨重启存活，无需新数据库或公开 service。
- cold Session 不工作、不发送外部通知；重新打开后可能交付 overdue 工作。
- 无需持久 Session 时区状态或从 Schedule 到 time-context 的依赖，绝对时间输入仍然具有确定性。
- 用户看到普通对话输出；dispatch 绝不会夸大模型成功或 acknowledgement。
- 显式启用 Schedule 的 Web 用户可以查看完整活动集合，并在普通行或搜索结果中辨认 cache 已知的活动 Session，而不会引入第二份持久状态、runtime 信号或第二种交付含义。
- 每个 live 根只增加从 fold 派生的 timer、可选 idle wait 与一个 in-flight operation。
- 固定速率周期性受到至少 5 分钟、只追赶最新一次，以及每条逾期记录只在一个批次中贡献一个发生时点的约束；日历周期性仍在此产品边界之外。
