---
description: "面向在协议边界接收调用方所报时区、墙钟选择器或耗时的维护者，说明严格的 RFC 3339 时刻、本地日历与时区解析，以及毫秒精度的时间段类型。"
kind: "package-library"
---

# dsh-util-time

[English](README.md) | 中文

## 概述

共享时间词汇，供接收调用方时区、墙钟选择器或耗时的边界使用。`canonicalClientTimeZone` 回答当前平台上的规范 `UTC` 或 IANA `Area/Location` 拼写，因此别名不会进入持久记录。严格解析器以带判别值的结果读取 RFC 3339 时刻、本地日历字段与时区名称，`resolveLocalInstant` 则套用受维护的 `Temporal` 的 DST 与重叠行为。`Duration` 以毫秒保存一段时间并拆成整数量。本库不持有失败词汇，也不生成面向模型的文本：每个调用方把拒绝原因映射成自己的域错误码。

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

在接收时区或墙钟选择器的那个边界上调用它，让值在进入任何持久物之前先过一遍。`dsh-api-session-controller` 与 `dsh-subagent` 通过 `canonicalClientTimeZone` 接收调用方所报时区；`dsh-time-context` 通过 `canonicalizeTimeZone` 接收某一轮请求所报时区，并拒绝别名而不是把它改写；`dsh-schedule` 通过严格解析器读取每一个绝对选择器与墙钟选择器，并通过 `resolveLocalInstant` 解析其本地目标；`dsh-session-format-v0-to-v1` 通过 `fourDigitYearEpoch` 校验持久记录里的调度时刻，同时保留它自己的已发布日志错误。`dsh-time-context` 通过 `Duration` 读取其耗时读数，并保留它注入那一行的措辞。自行拥有日历或间隔运算的消费方保留那部分运算，只在边界值上调用这些入口。


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

`src/instant.ts` 承载各解析器，`src/duration.ts` 承载时间段；`src/index.ts` 转出两者，并新增 `canonicalClientTimeZone`——协议边界已经在消费的 `string | undefined` 形式。该模块的 JSDoc 说明每个入口接受的输入剖面与全部拒绝原因。

严格解析器先匹配固定正则，再构造任何日期，因此拼写错误、越界时钟字段与日历上不存在的日期分别回答不同的原因。本地解析交给 `@js-temporal/polyfill`：`disambiguation: 'earlier'` 取重叠时段中的第一个时刻，而本地字段往返比对对前向跳变缺口内的值回答 `undefined`。

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
| `Duration` | 一个落在可精确表示范围内的毫秒计数，以及它拆出的整日、整时、整分、整秒与不足一秒的余数。 |

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
- **不含重复规则运算**——只做时刻有效性、本地日历解析、时区解析、规范格式化与毫秒精度的时间段；遍历候选日期或间隔的搜索由调用方自己拥有。
- **`Duration` 没有日历单位**——一天恰好是 24 小时，月没有固定长度；需要本地日历天的调用方从时区推导。
- **`Duration` 只发布消费方会调用的部分**——`fromMilliseconds` 与 `decompose()`；某个换算、某个算术运算或 `zero` 恒等元都随第一个需要它的调用方落地，公开契约跟着调用方长，而不是长在它前面。
- **以秒为单位的跨度仍在自行相乘**——`dsh-schedule` 的间隔与延迟字段、DeepSeek 文件存储的刷新余量都是以秒为单位的跨度，用 `* 1_000` 换算；它们都还没迁移到本库，而以秒表示的纪元不是跨度，不得构造成跨度。
- **`Temporal` polyfill 是运行时依赖**——只导入 `canonicalClientTimeZone` 的消费方在模块加载时同样会解析它，因为两个入口共用一个模块。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
