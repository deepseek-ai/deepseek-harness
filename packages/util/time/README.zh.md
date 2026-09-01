---
description: "面向在协议边界接收调用方所报时区的维护者，说明 IANA 时区校验与规范化。"
kind: "package-library"
---

# dsh-util-time

[English](README.md) | 中文

## 概述

零依赖的时区词汇，供接收调用方时区的协议边界使用。`canonicalClientTimeZone` 只接受 `UTC` 或 IANA `Area/Location` 名称，并回答该名称在当前平台上的规范拼写，因此别名不会进入持久记录：时区标识会存在消息上、并由另一个进程稍后重新推导，别名在那里比不相等。本库只做校验与规范化——不格式化任何时间，也不持有失败词汇，因为每个边界抛自己的域码。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

它是**库，不是服务也不是插件**：无 `ctx`、不注册任何东西、不持有状态。

不发布运行时不变量伴生入口；这个纯工具不拥有事件流或可变运行时数据，时区规范化由单元测试验证。

在接收时区的那个边界上调用它，让值在进入任何持久物之前先过一遍。不可用的名称回答 `undefined`，由调用方抛出自己的拒绝——Session prompt 用 `session/invalid-time-zone`，subagent 续话用 `subagent/invalid-time-zone`。

-----

<a id="api"></a>
## API

```ts
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
```

| 导出 | 职责 |
|---|---|
| `canonicalClientTimeZone(value)` | 对接受的时区回答规范的 `UTC` 或 IANA `Area/Location` 名称；空串、带空白、缩写、单段或平台不支持的名称回答 `undefined`。 |

<a id="model-experience"></a>
## Model Experience

间接影响，取决于把规范时区记到持久消息上的那个消费方——`dsh-time-context` 据此渲染该轮模型可见的时区指令与时间戳。

#### KV Cache effect

自身没有。把时区派生文本注入请求的那个消费方，对该请求的缓存行为负责。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **别名解析取决于运行时的 ICU 数据**——一个别名组规范化成哪个名称由平台回答，因此两个跑在不同 Node 构建上的进程可能给出不同答案。
- **只做校验**——不格式化、不做偏移运算、不推导 DST、不做时刻换算；需要这些的消费方直接用 `Intl`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
