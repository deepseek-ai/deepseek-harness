---
description: "面向替换仅安全上下文可用的 crypto.randomUUID 调用的维护者，说明跨运行时 UUID 生成。"
kind: "package-library"
---

# dsh-util-crypto

[English](README.md) | 中文

## 概述

零依赖、可在浏览器使用的 UUID 与字节编码辅助函数。UUID 铸造基于 `crypto.getRandomValues`——所有发布上下文都提供的那个随机原语。`crypto.randomUUID` 是安全上下文限定的 Web API：经普通 HTTP 在局域网地址上提供的页面或 worker（浏览器预览部署）根本没有这个方法，必须在那里运行的代码不能调它。全仓 `no-restricted-properties` lint 规则把 `crypto.randomUUID` 的调用者指到这里；只跑在 Node 的代码从 `node:crypto` 导入 `randomUUID` 维持原样。

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

-----

<a id="api"></a>
## API

```ts
import { bytesToBase64, randomUUID, type Uuid } from '@deepseek-ai/dsh-util-crypto'
```

| 导出 | 角色 |
|---|---|
| `bytesToBase64(data)` | 以有界分片把字节数组编码为标准 base64。 |
| `randomUUID()` | 随机 RFC 9562 v4 UUID 字符串，由 `crypto.getRandomValues` 铸造。可原位替换 `crypto.randomUUID()`。 |
| `Uuid` | 五段式 UUID 字符串类型，与 `crypto.randomUUID` 声明的返回形状一致。 |

<a id="model-experience"></a>
## Model Experience

间接地，经由用它铸造请求、会话与附件标识符的消费方，这些标识符均不作为语义内容进入提示词。

#### KV Cache effect

无直接失效；铸造标识符的消费方自行负责其请求变化。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅 v4**——不提供其他 UUID 版本、命名空间或解析；需要更多能力的消费方应引入真正的 UUID 依赖。
- **唯一性是概率性的**——122 位随机，与 `crypto.randomUUID` 同级保证；此处不做碰撞检测。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这个纯工具不持有事件流或可变运行时数据；其值运算由单元测试覆盖。
