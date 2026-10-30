---
description: "为拥有时间行为的调用方提供严格时刻与时区解析、毫秒跨度及有界 Cron/RRULE 重复计算。"
kind: "package-library"
---

# dsh-util-time

[English](README.md) | 中文

## 概述

为时刻、时区、耗时和重复规则边界提供共享时间词汇。严格解析器返回接受值或拒绝原因；`resolveLocalInstant` 使用维护中的 Temporal 缺口与重叠行为。`Duration` 保存毫秒跨度。`Cron` 和 `RRule` 解析不同表达式类型，并从显式决策时刻计算有界发生时点。库不拥有任务状态、投递策略、领域错误或面向模型的文案。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

它是**库，不是服务也不是插件**：无 `ctx`、不注册任何东西、不持有状态。

在接收时区或墙钟选择器的那个边界上调用它，让值在进入任何持久物之前先过一遍。`dsh-api-session-controller` 与 `dsh-subagent` 通过 `canonicalClientTimeZone` 接收调用方所报时区；`dsh-time-context` 通过 `canonicalizeTimeZone` 接收某一轮请求所报时区，并拒绝别名而不是把它改写；`dsh-schedule` 通过严格解析器读取绝对选择器与墙钟选择器，通过 `resolveLocalInstant` 解析本地目标，并使用共享的 `Cron` / `RRule` 重复规则值；`dsh-session-format-v0-to-v1` 通过 `fourDigitYearEpoch` 校验持久记录里的调度时刻，同时保留它自己的已发布日志错误。`dsh-time-context` 通过 `Duration` 读取其耗时读数，并保留它注入那一行的措辞。Schedule 保留记录类型、相对间隔、每日/每周策略和投递限制。库可用于宿主和浏览器代码，无需 Cordis 服务。


### 入口

```ts
import { Duration, canonicalClientTimeZone, fourDigitYearEpoch, parseLocalCalendar, resolveLocalInstant } from '@deepseek-ai/dsh-util-time'

const zone = canonicalClientTimeZone('US/Eastern')            // 'America/New_York' or undefined
const stored = fourDigitYearEpoch('2026-03-08T02:30:00.000Z') // { kind: 'accepted', epoch } or a rejection reason
const local = parseLocalCalendar('2026-03-08', '02:30:00')    // { kind: 'accepted', time } or a rejection reason

if (local.kind === 'accepted') {
  resolveLocalInstant(local.time, zone ?? 'UTC') // epoch milliseconds, or undefined inside a DST gap
}

Duration.fromMilliseconds(1_500).decompose() // { days: 0, hours: 0, minutes: 0, seconds: 1, milliseconds: 500 }
```

不可用的时区名称由 `canonicalClientTimeZone` 回答 `undefined`，由调用方抛出自己的拒绝——Session 提示词用 `session/invalid-time-zone`，subagent 续话用 `subagent/invalid-time-zone`。`canonicalizeTimeZone`、各严格解析器与 `fourDigitYearEpoch` 则会说明拒绝原因，以带判别值的结果回答，其 `rejected` 分支携带稳定的拒绝原因，由各调用方选择自己的错误码与诊断文案。`formatFourDigitYearInstant` 与 `resolveLocalInstant` 接收已校验的值，分别回答字符串与纪元毫秒，无法表示的纪元或落在 DST 缺口内的墙钟值回答 `undefined`。`Duration` 是一个基于单一毫秒计数的冻结值类型：它校验计数有限且落在可精确表示的范围内，并把非负的时间段拆成整数量。它只发布消费方会调用的部分；面向其它单位或时间段算术的成员都随第一个需要它的调用方落地。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

`src/instant.ts` 拥有严格时间边界，`src/duration.ts` 拥有跨度，`src/cron.ts` / `src/rrule.ts` 拥有重复计算。公共入口是 `src/index.ts`；解析器返回带判别值的结果，把错误码和呈现交给调用方。

严格解析器先匹配固定正则，再构造任何日期，因此拼写错误、越界时钟字段与日历上不存在的日期分别回答不同的原因。本地解析交给 `@js-temporal/polyfill`：`disambiguation: 'earlier'` 取重叠时段中的第一个时刻，而本地字段往返比对对前向跳变缺口内的值回答 `undefined`。

两种重复规则值都通过 `fourDigitYearEpoch` 校验已提交的 `scheduledAt`：它必须是真实日期，并采用带 3 位小数秒的规范 UTC 剖面。Cron 只为实际访问的候选分钟构造日历值；日期匹配、缺口与重叠策略及搜索边界由所有调用方共享。

| 入口 | 接受的输入 |
|---|---|
| `canonicalClientTimeZone` | `UTC` 或 IANA `Area/Location` 名称；被拒绝时回答 `undefined`。 |
| `canonicalizeTimeZone` | 同样的名称；回答规范拼写或拒绝原因；平台拒绝了一个格式合法的名称时，还会携带该平台错误。 |
| `parseLocalCalendar` | `YYYY-MM-DD` 与 `HH:mm:ss`，可带 1 到 3 位小数秒。 |
| `parseOffsetInstant` | 带显式 `Z` 或数字偏移的 RFC 3339；偏移量属于输入的一部分。 |
| `fourDigitYearEpoch` | 规范存储剖面：恰好 3 位小数秒与 `Z`。 |
| `formatFourDigitYearInstant` | 四位年份范围内的整数纪元毫秒；超出范围或非整数时回答 `undefined`。 |
| `isFourDigitYearInstant` | 同一范围的谓词形式，只判断范围边界的调用方无需自行推导。 |
| `resolveLocalInstant` | 真实日期的精确日历字段，或已构造好的 `Temporal.PlainDateTime`，外加已规范化的时区。 |
| `Duration` | 一个有限且可精确表示的毫秒计数及其拆分。 |
| `Cron.parse(expression, zone)` | 带显式 IANA 时区的五字段 Vixie Cron，包含依赖星号的日期匹配；搜索限制为格里历 400 年。 |
| `RRule.parse(expression, options?)` | 一个 `DTSTART` 和 `RRULE`，有界 RFC 5545 子集、分钟下限、静态展开限制及可选的严格作者输入检查。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Schedule 宿主存储](../../schedule/schedule/README.zh.md) —— 保存已提交 UTC 时点的消费方。
- [Session 控制器](../../api/session-controller/README.zh.md) —— 规范化浏览器时区的请求边界。
- [时间上下文](../../context/time-context/README.zh.md) —— 拒绝非规范浏览器时区的请求消费方。
- [util/ 包地图](../README.zh.md) —— 本库在共享工具中的位置。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，取决于把规范时区或已提交 UTC 时刻记到持久记录上的那些消费方：`dsh-time-context` 据时区渲染本轮模型可见的时区指令与时间戳，`dsh-schedule` 据已提交时刻渲染其模型可见的调度文本。

#### KV Cache 影响

自身没有。把时区或调度的派生文本注入请求的那个消费方，对该请求的缓存行为负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **别名解析取决于运行时的 ICU 数据**——一个别名组规范化成哪个名称由平台回答，因此两个跑在不同 Node 构建上的进程可能给出不同答案。
- **重复计算有界**——[Schedule 参考](../../../docs/subsystems/schedule.zh.md#recurrence-rules)列出共享表达式子集。解析成功返回冻结的 `rule`，提供 `expression`、`timeZone`、`next(after)` 和 `resolve(scheduledAt, acceptedAt)`；求值保留已提交发生时点并合并错过的时点。拒绝原因是 `syntax`、`time_zone`、`density` 或 `range`；无效决策时间抛出 `RangeError`。方法不读取墙钟或启动定时器。
- **`Duration` 没有日历单位**——一天恰好是 24 小时，月没有固定长度；需要本地日历天的调用方从时区推导。
- **`Duration` 只发布消费方会调用的部分**——`fromMilliseconds` 与 `decompose()`；某个换算、某个算术运算或 `zero` 恒等元都随第一个需要它的调用方落地，公开契约跟着调用方长，而不是长在它前面。
- **以秒为单位的跨度仍在自行相乘**——`dsh-schedule` 的间隔与延迟字段、DeepSeek 文件存储的刷新余量都是以秒为单位的跨度，用 `* 1_000` 换算；它们都还没迁移到本库，而以秒表示的纪元不是跨度，不得构造成跨度。
- **根入口加载重复计算依赖**——导入它会解析 `@js-temporal/polyfill` 和 `rrule`，只需要时区或跨度的消费方也一样。浏览器消费方必须在打包时计入这些依赖。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
