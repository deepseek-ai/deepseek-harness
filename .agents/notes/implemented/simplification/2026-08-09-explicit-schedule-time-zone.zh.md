# Agent Note: 显式 Schedule 时区边界

Status: implemented

[English](2026-08-09-explicit-schedule-time-zone.md) | 中文

## 问题

隐式本地 `at` 输入把浏览器事实变成了共享产品状态。在 Session 创建时捕获默认时区，需要增加新的 Session header、create／resume／fork 冲突规则、JSONL metadata、SQLite migration、client 创建 plumbing、Host 比较，以及与 time-context 标记耦合的 Schedule 逻辑。随后，旅行、并发 tab、缺失浏览器时区记录和旧 Session 都需要一套确认协议，仅仅为了判断省略字段是否安全。

大部分复杂度都位于 Schedule 之外。模型在调用工具前已经解释自然语言，因此持久 Session 默认值只是重复了一个假设，并没有强化绝对时间边界。

## 决策

浏览器时区是请求本地的来源数据。Web client 会为每条提示词采样 `Intl.DateTimeFormat().resolvedOptions().timeZone`。Host 接受可选的 `clientTimeZone`，在 RPC 边界校验并规范化 `UTC` 或 IANA Area/Location，再将其记录在确切的那条 `user-rpc` 消息上。无效值会使提示词准入被拒绝。非浏览器 client 可以省略它。

Time-context 从 open turn 中的原始 user-rpc 消息派生唯一、混合或缺失的浏览器事实。唯一时区会用于格式化时钟，并告诉模型把未明确限定时区的日期和时间解释为该时区。浏览器时区记录混合或缺失时，模型会被告知询问用户。配置或进程时区只作为显示 fallback，绝不会被呈现为用户权威。

Schedule 不接受隐式本地时区。`at` 要么是带显式偏移量且严格符合 RFC 3339 的字符串，要么是精确的 `{ date, time, time_zone }`。即使 time-context 刚向模型展示了浏览器时区，结构化形式仍要求自己的时区。Schedule 不导入 time-context、不检查 user message 来源、不读取 Session header，也不产生确认错误。它的 parser 会校验显式值、拒绝夏令时缺口、在重叠时选择第一个时点，并且只存储规范化后的 UTC `scheduledAt`。

不再保留 Session 时区字段、create／resume／fork 时区冲突、JSONL header 字段、SQLite column 或 migration、连接默认值，也不再保留 Schedule 专属的 Host／client 呈现。浏览器假设只会通过模型的显式工具参数跨入 Schedule。

## 已考虑的替代方案

**把第一个浏览器时区持久化为不可变的 Session 默认值。** 这会使后续本地输入具有确定性，却把归属扩散到 core 和 persistence；旅行与并发 tab 仍然需要不匹配处理。

**把最近的浏览器时区用作可变 Session 状态。** 这会减少确认提示，却允许一个 tab 悄然改变另一个 tab 的解释，并使回放依赖更新顺序。

**让 Schedule 检查最新的 time-context 消息。** prose snapshot（文本快照）是模型可见证据，而不是有类型的包 seam。消费它会使 Schedule 与 AgentLoop history 耦合，并针对原始 user message 来源重复校验。

**让 Host 向工具调用注入 `time_zone`。** Host 无法知道模型解释的是哪个自然语言表达式，也无法知道用户是否指定了另一个时区。重写模型参数会在错误的边界隐藏含义。

**要求模型对每个未限定时区的时间都询问用户。** 这样做是安全的，却会不必要地打断常见的浏览器本地场景。请求本地指令提供预期假设，而浏览器时区记录混合或缺失时仍会询问用户。

## 验证

Host 测试固定别名的规范化、可省略行为和进入 Agent（智能体）前的拒绝。client 测试固定每条提示词进行一次浏览器时区采样。Time-context 测试固定当前 turn 中唯一、混合与缺失情况的派生，以及精确模型策略。Schedule 测试固定必需的 `time_zone`、严格偏移量、日历校验、规范时区、缺口拒绝、重叠时选择第一个时点，以及不存在隐式上下文路径。组装 Web 场景把 Playwright 固定到 `Asia/Shanghai`，通过真实 composer 发送提示词，在模型请求中观察同一时区，验证显式本地工具调用，并对普通提醒响应执行 snapshot。

源代码审计会拒绝 `SessionHeader.timeZone`、persistence `time_zone` column、确认错误、Schedule 对 time-context 的导入，以及独立回执机制。

## 后果

- 无需持久 Session 时区子系统，浏览器本地自然语言也能工作。
- Schedule 具有一个显式且可独立测试的绝对时间边界。
- 旅行与并发 tab 只影响各自的提示词；浏览器时区记录混合的 turn 会询问用户，而不是改变共享状态。
- 非浏览器 client 仍然有效，但必须提供足够的自然语言上下文或显式工具参数。
- 模型仍可能产生解释错误；工具只保证显式日历值有效且具有确定性。
