---
description: "PTC 执行能力族的包映射：程序执行能为你做什么，以及每个部分由哪个包负责。"
kind: "package-group"
---

# ptc-runtime/——PTC 执行能力族

[English](README.md) | 中文

## 概述

`ptc-runtime/` 组让模型编写一个程序，以普通异步调用的方式调用宿主提供的函数，然后只返回程序的打印输出和返回值。如需在全新 Node 进程中按所配沙箱策略执行，请选择 TypeScript 后端；如需 CPython 进程，请选择实验性 Python 后端。每次运行都不会保留之前程序的状态。失败会作为结果返回，供调用方诊断或提供给模型。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

这三个包共同提供程序执行能力；每个 README 描述其各自部分做什么。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`ptc-runtime/`](ptc-runtime/README.zh.md) | 定义 PTC 运行时做什么：针对宿主提供的绑定运行一个程序，并报告其打印和返回的内容 | `ctx.ptcRuntime` |
| [`ptc-runtime-node/`](ptc-runtime-node/README.zh.md) | 在全新受管 Node 进程中按已解析沙箱策略执行 TypeScript | 注册 `ctx.ptcRuntime` |
| [`experimental/ptc-runtime-python/`](../experimental/ptc-runtime-python/README.zh.md) | 实验性 Python 后端：负责 Node 宿主与 CPython 子进程之间的 fd-3 协议，以及 CPython 运行时实现 | — |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考了解服务约定，再看消费此能力的 PTC mode 设计，以及它所遵循的能力 seam 模型。

- [PTC 运行时子系统参考](../../docs/subsystems/ptc-runtime.zh.md)——请求／结果词汇、绑定与 `ctx.ptcRuntime` 的 Cordis 接口面。
- [PTC mode Agent Note](../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md)——工具注册表如何把 `run_code` 呈现给模型。
- [能力 seam](../../docs/capability-seams.zh.md)——本家族遵循的 Service Definition / Service Provider / Consumer 拆分。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
