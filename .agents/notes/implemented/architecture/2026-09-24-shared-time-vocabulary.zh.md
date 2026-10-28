# Agent Note: 面向墙钟选择器的共享时间词汇

Status: implemented

[English](2026-09-24-shared-time-vocabulary.md) | 中文

## Problem

`dsh-util-time` 此前只承担一项职责、面向一种调用方：`canonicalClientTimeZone` 在协议边界校验调用方所报时区并回答 `undefined`，由 `dsh-api-session-controller` 与 `dsh-subagent` 映射成各自的域错误。同一套词汇的其余部分被另外两个消费方各自私下养大。Schedule 在 `packages/schedule/schedule/src/domain.ts` 里持有严格的 RFC 3339 时刻解析器、本地日历解析器、四位年份边界与规范格式化、本地墙钟解析，以及自己的 IANA 时区规范化实现——它抛 `ScheduleInputError` 而不是回答结果。`dsh-time-context` 在 `packages/context/time-context/src/request-zone.ts` 里持有第二份 IANA 时区剖面，配有自己的正则与自己的 `Intl.DateTimeFormat` 规范化，用来执行更严格的策略：一轮请求只能报出另一个进程会解析回同一标识的时区。因此 IANA 剖面与那一步 `Intl` 规范化合计存在三份，该剖面的任何变更都要逐份改、逐份验；而下一个需要墙钟选择器的消费方没有共享入口可用。

## Decision

`dsh-util-time` 拥有各边界所接收的时间词汇。解析器位于 `packages/util/time/src/instant.ts`，时间段类型位于 `src/duration.ts`，`src/index.ts` 转出两者，并保留 `canonicalClientTimeZone` 作为既有协议边界消费的 `string | undefined` 包装。

本库回答带判别值的结果，不持有失败词汇。`parseOffsetInstant`、`fourDigitYearEpoch`、`parseLocalCalendar` 与 `canonicalizeTimeZone` 回答 `accepted` 分支，或回答携带稳定原因的 `rejected` 分支（`not_rfc3339`、`out_of_range`、`not_a_calendar_date`、`invalid_numeric_offset`、`malformed`、`blank`、`padded`、`not_area_location`、`unsupported`、`not_canonical_shape`）。每个调用方把原因映射成自己的错误码与诊断文案，因此本库从不撰写面向模型的文本。`formatFourDigitYearInstant` 返回规范时刻文本，越界时返回 `undefined`；`isFourDigitYearInstant` 回答某个纪元是否可表示；`resolveLocalInstant` 回答纪元毫秒，对落在前向跳变缺口内的墙钟值回答 `undefined`。两个严格解析器的原因词汇彼此对称：同一条件在两者中都叫 `out_of_range`，所以年份 0 被 `parseOffsetInstant` 与 `parseLocalCalendar` 同样拒绝；而 `resolveLocalInstant` 接受真实 `Temporal` 日期携带的任何年份，因为它的调用方需要在 UTC 边界推导本地日期。`LocalCalendarTime.year` 记录了这一分工。

Schedule 消费它，并保留全部域内决策。`canonicalizeTimeZone`、`decodeInstant`、`parseAtInput` 与 `futureInstant` 仍是 Schedule 的入口，保留既有错误码与诊断文案；它们现在调用共享解析器并映射其原因。Schedule 仍拥有持久记录结构、折叠与状态转移权威、抗注入的框架文本，以及全部重复规则运算：cron 引擎、每日与每周日期遍历、最近到期搜索，以及 Schedule 特有的决策时刻边界。

`dsh-time-context` 同样消费它，并保留自己更严格的策略。`deriveBrowserTimeZoneContext` 通过 `canonicalizeTimeZone` 读取每条 user-rpc 时区，并拒绝规范答案与所报值不同的别名，因此请求边界仍然要求另一个进程能解析回同一名称。三条拒绝与它们的文案归 time-context 所有；共享入口只回答规范名称或一个原因；被拒绝的结果中只有 `unsupported` 会携带本库捕获到的平台错误，使该拒绝在两个消费方都保留其 `cause`。

`Duration` 以单一毫秒计数保存一段时间；它做成类而不是 branded number，是因为 TypeScript 的算术会抹掉 brand：两个不同品牌的数字相加得到的是无品牌的 `number`，所以 brand 挡不住秒与毫秒的混用，而实例可以。单位选毫秒，是因为本仓库的每个生产者与消费者本来就用它（`Date.now()`、`SessionEvent.time`、Session 日志、客户端），也因为 double 能精确表示 `Date` 全范围内的每一个毫秒，这个单位不消耗任何精度。实例被冻结，不覆盖任何强制转换钩子，且时间段受可精确表示的毫秒范围约束——这正是拆分精确的前提。公开面就是 `fromMilliseconds` 与整数量拆解 `decompose()`，即已迁移消费方所调用的两个入口。

最后一份规范时刻剖面副本也一并迁移。`packages/session/session-format-v0-to-v1/src/payload-validation.ts` 原本用自己的一段正则与往返比对校验持久记录里的调度时刻；共享的 `fourDigitYearEpoch` 拥有同一剖面，因此该迁移改为询问它，并保留自己的错误类型与文案。由于这个迁移要读取已发布的日志，其接受集是兼容性承诺：`packages/session/session-format-v0-to-v1/tests/validation.spec.ts` 接受四位年份两端，并拒绝只靠正则会放进来的每种拼写（`0000`、`2026-02-30`、四位小数、数字偏移、首尾空白）。

受维护的 `@js-temporal/polyfill` 0.5.1 在成为 `dsh-schedule` 运行时依赖之外，也成为 `dsh-util-time` 的运行时依赖。本地解析继续使用它，因此缺口与重叠仍由宿主 IANA 数据决定，也没有调用方需要自己实现偏移采样。`util/time` 自身的描述与 README 去掉了 `zero-dependency` 这一说法，因为它容易被误读：该组的约定禁止的是 harness 依赖（以便任何组都能依赖 util），并不禁止外部包；因此 `packages/README.md` 与 `AGENTS.md` 里的 `util/` 一行保留该说法，而 `packages/util/README.md` 与本包自己的描述写明它加载了什么。

可观察行为不变。每个被接受的输入解析出相同的纪元值，每个被拒绝的输入抛出相同的 `ScheduleInputError` 或 `ScheduleLogError` 错误码与相同的消息，存储的 `scheduledAt` 剖面不变，因此没有持久记录或录制快照需要重录。Schedule 的测试断言错误码以及少量无关的消息子串，因此本次在 `packages/schedule/schedule/tests/domain.spec.ts` 新增的断言是唯一固定这三条本地日历消息的地方。`packages/util/time/tests/instant.spec.ts` 直接覆盖新增入口，包含逐文件 100% 覆盖。

## Alternatives considered

**把共享模块保持为 Schedule 私有。** 在 `domain.ts` 旁抽出一个 Schedule 私有的 `time` 模块可以缩小它，而不触碰已发布包、其 lockfile 条目、README 或依赖集合。之所以否决，是因为本次要消除的重复是重复的**剖面**，不是重复的行数：时区正则、`Intl` 规范化步骤与时刻剖面仍会存在两份，下一个接收墙钟选择器的边界仍会复制出第三份。

**让本库自带错误类型。** 一个携带原因的 `TimeInputError` 可以让调用方直接重抛而不做映射，缩短每个调用点。之所以否决，是因为 `util/time` 既有契约规定每个边界拥有自己的拒绝词汇，而 Schedule 的消息会通过工具结果的 `{ code, message }` 与客户端的消息卡片到达模型；共享错误类会把一个调用方的措辞带进另一个调用方的界面。

**让本库回答 `undefined` 而不是原因。** 这正是 `canonicalClientTimeZone` 已有的形态，也是改动更小的做法。之所以否决，是因为 Schedule 必须区分格式错误的时刻、日历上不存在的日期与越界时钟字段，才能保留既有诊断；`canonicalizeTimeZone` 也必须区分名称本身不合法与本地无法解析。把二者压成一个假值，会迫使 Schedule 用自己的正则重新推导这层区分，从而恢复重复。

**给毫秒计数加 brand，而不是造类。** 本仓库已有用于不透明标识的 `Branded<number>`，branded 计数也比类更小。之所以否决，是因为 brand 撑不过真正要紧的那步运算：TypeScript 接受 `brandedA + brandedB` 并回答无品牌的 `number`，于是把时间段加到纪元上的调用方会静默丢掉单位，而这正是该类型要防的错误。类会把这种相加变成类型错误，也让整数量拆解只有一个归宿。

**用纳秒保存时间段。** `Temporal` 内部以 `bigint` 携带纳秒，所以纳秒时间段是可表示的。之所以否决，理由与边界保持毫秒相同：计数必须变成 `bigint`，而 `number` 算术、`Date` 与 `JSON.stringify` 都不接受它，于是每个消费方与每条持久记录都要多一次字符串或二进制转换。若改用 `number` 表示纳秒，在当前离线纪元量级上它会被量化到约 256 ns，那是同一个名字下的另一个值。

**同时为其他消费方加入格式化与 DST 运算。** 目前没有消费方需要本库提供面向模型的格式化或偏移运算：`dsh-time-context` 自己拥有格式化器与时区策略文本。现在加入只会给本库一个没有消费方证据的公开操作集合，违背"每项抽象都绑定当前所有者与需求"的包规则。

## Consequences

时间剖面现在只有一个归宿。时刻剖面或时区剖面的变更只做一次、只覆盖一次，新边界导入它而不是复制它。Schedule 的 `domain.ts` 去掉了为时刻、日历日期、本地时间与时区剖面命名的五段正则、`Intl` 规范化与手写日历换算。它仍然导入本库的两个边界常量用于其 UTC 边界日期运算，并把每处可表示性守卫委托给 `isFourDigitYearInstant`，因此范围本身只有一个所有者。

代价是更宽的已发布接口与更重的依赖图：`dsh-util-time` 增加了对 `@js-temporal/polyfill` 的运行时依赖，因此只导入 `canonicalClientTimeZone` 的消费方也会加载该模块。本库也不再是纯"只做校验与规范化"的包——其 README 与包描述必须说明这一点，其"已知限制"一节现在也记录了它。Schedule 在每个入口保留一层薄映射。本地日历与时刻映射函数以 `never` 默认分支穷尽 switch 本库的封闭原因联合，因此新增原因会让这两个调用点构建失败，而不是静默走兜底分支。时区映射函数则只对 `not_canonical_shape` 分支——当前 IANA 数据不会产生该原因，因此它由 `v8 ignore` 守护而不是 `never` 默认分支——并把 `blank`、`padded`、`not_area_location` 与 `unsupported` 合并成一条诊断。因此日后给 `TimeZoneRejection` 新增原因时会通过编译并静默套用那条通用文案。

值类型只发布消费方会调用的部分，因此这个时间段只暴露 `dsh-time-context` 用到的构造入口与拆解，其余不发布。某个换算、某个算术运算或 `zero` 恒等元都随第一个需要它的调用方落地；`dsh-schedule` 与 DeepSeek 文件存储里以秒为单位的字段就是将来会要求第二个单位换算的那些跨度，而类已经携带的范围约束与冻结正是让这次添加保持很小的原因。包 README 把这些尚未迁移的边界记为已知限制。

耗时读数的拆分上收到库、措辞留在一侧：`dsh-time-context` 仍然决定回退的时钟读数钳到零、以及那行紧凑文本怎么写，而 `Duration.decompose()` 回答整数量。这次替换对每个有限样本都逐字不变，用一份覆盖八千多个输入（含负数、小数与一年以上的值）的差分测得。该测量不是提交进仓库的测试：消费方自己那套测试固定了它渲染出的读数（`1d 1h 1m 1s`、`1m 1s`、`4m 2s`，以及被钳到零的那次）。有两个样本会变：`NaN` 原本渲染出 `NaNs`、`+Infinity` 原本渲染出 `Infinityd NaNs`，现在两者都由时间段构造函数抛出，于是非有限的读数在产生它的地方失败，而不是渲染出一段文本。`-Infinity` 样本不变，因为消费方在构造时间段之前已把它钳到零。

本次未触及、仍归 time-context 的两项：`packages/context/time-context/src/timestamp.ts` 中的 ISO 形状时间戳渲染（那是该包的持久读数字格式），以及其插件内的耗时措辞。浏览器客户端也保留自己的本地化日期渲染与用于展示的偏移读取——它们服务的目的（读者的区域设置）与边界值不同；统一它们意味着先决定共享库是否也要拥有展示格式化，以及届时由谁拥有持久读数字格式。有五处时间代码各自保留实现，原因各不相同。`packages/experimental/tool-session-query/src/input.ts` 解析的剖面比共享入口更宽——秒可省略、小数位不限、并保留下毫秒数字以便精确比较两个时刻——因此换成共享解析器会收窄它接受的输入，而把那条剖面搬进本库是另一项独立的设计。`dsh-schedule` 里的 `Date.parse(record.scheduledAt)` 读的是写入路径已经校验过的值，换成带判别值的解码会在每个读取点新增一个实际不可能发生的拒绝分支，并改变损坏记录的报告方式。`everySeconds`、`afterSeconds` 与 `refreshMarginSeconds` 三处乘法旁边都紧跟一条抛本包自有错误的校验，因此把它们改走会抛自身错误类型的构造函数，会改变调用方看到的失败。客户端上报的 UTC 偏移由 `packages/client/ui-settings-account/src/client/client-metadata.ts` 自行计算而不共享：客户端 bundle 只允许对列入 inline-safe 的包做跨插件值导入，`dsh-util-time` 不在其中，而且它在模块顶层静态导入 `Temporal` polyfill，内联它等于把该 polyfill 打进浏览器；Desktop 的宿主侧则用共享库计算同一个偏移，那里没有这条限制。`dsh-workspace` 用平台的 `toISOString` 写记录时间戳，对每个可表示的纪元那已是规范渲染：共享写入器会拒绝的扩展年份与小数截断两种情形，从 `Date.now()` 与 `SessionHeader` 的纪元出发都不可达，因此在那边采用共享格式化器只会增加一个模块与一条依赖，却不会改变任何字节。
