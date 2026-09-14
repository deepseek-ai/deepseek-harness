---
description: "Typert 组地图：构建时类型图生成器、运行时注册表、Loader 集成与共享 Remote 协议，它们共同支撑类型化的 Host 到 Client 调用。"
kind: "package-group"
---

# packages/typert

[English](README.md) | 中文

## 概述

借助 Typert 组，Client 环境能以类型化方法调用 Host 能力，并在无需手写协议代码的情况下共享生成的 schema 与反射信息。构建时生成器把源代码类型声明转换为与编译器无关的模型与运行时产物，运行时注册表保存这些产物，Loader 集成则在 Loader 组合中自动注册它们。共享的协议包提供 Remote 调用声明——装饰器、wire 描述符、编解码器与提供方约定——供业务包、生成产物、Host Gateway 与 Client API 共同消费。本页是四个包的索引；每个包的 README 负责各自的配置、用法与限制。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`generator/`](generator/README.zh.md) | 在构建时分析源代码类型，并生成运行时加载所需的反射、schema 与 Remote 描述符 | — |
| [`loader/`](loader/README.zh.md) | 把 Loader 组合中已生成的 Typert 产物自动注册到运行时注册表 | 消费 `ctx.loader` 与 `ctx.typert` |
| [`protocol/`](protocol/README.zh.md) | 声明 Host 与 Client 共享的 Remote 装饰器、wire 描述符、编解码器与提供方约定 | — |
| [`registry/`](registry/README.zh.md) | 在运行时保存生成的包反射与实时 Zod schema，并提供 lookup 与 Context 提供方注册表 | `ctx.typert` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Typert 子系统参考](../../docs/subsystems/typert.zh.md)——从协议与注册表类型中原样记录的公共约定。
- [API Gateway 参考](../../docs/api-gateway.zh.md)——生成的 Remote 描述符如何成为实际的 Host 到 Client 调用。
- [Remote 调用 Agent Note](../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.zh.md)——Remote 调用背后的架构与传输决策。
- [包工作区地图](../README.zh.md)——工作区中的每个组及其职责。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
