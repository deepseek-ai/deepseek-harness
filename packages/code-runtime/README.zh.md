---
description: "代码执行能力族的包映射：程序执行能为你做什么，以及每个部分由哪个包负责。"
kind: "package-group"
---

# code-runtime/——代码执行能力族

[English](README.md) | 中文

## 概述

`code-runtime/` 组提供程序执行能力：模型编写一个程序，把宿主提供的函数当作普通异步调用，运行时在隔离环境中执行它，只返回程序打印和返回的内容。一个包定义共享能力（`ctx.codeRuntime`），第二个包在全新的 Node Worker 线程中执行 TypeScript 程序，第三个包持有 Node host 与 CPython 子进程之间的 fd-3 协议格式（wire protocol），为 Python 后端服务。每次运行彼此独立——程序之间不保留任何状态——失败也会作为结果的一部分返回，调用方因此能知道程序为何失败，并把它反馈给模型。

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
| [`code-runtime/`](code-runtime/README.zh.md) | 定义代码运行时做什么：针对宿主提供的绑定运行一个程序，并报告其打印和返回的内容 | `ctx.codeRuntime` |
| [`code-runtime-worker-thread/`](code-runtime-worker-thread/README.zh.md) | 在全新的 Node Worker 线程中执行 TypeScript 程序 | 注册 `ctx.codeRuntime` |
| [`experimental/code-runtime-python/`](../experimental/code-runtime-python/README.zh.md) | 实验性 Python 后端：持有 Node host 与 CPython 子进程之间的 fd-3 协议格式与 CPython 运行时实现 | — |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考了解服务约定，再看消费此能力的 PTC mode 设计，以及它所遵循的能力 seam 模型。

- [代码运行时子系统参考](../../docs/subsystems/code-runtime.zh.md)——请求／结果词汇、绑定与 `ctx.codeRuntime` 的 cordis 接口面。
- [PTC mode Agent Note](../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md)——工具注册表如何把 `run_code` 呈现给模型。
- [能力 seam](../../docs/capability-seams.zh.md)——本家族遵循的 Service Definition / Service Provider / Consumer 拆分。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
