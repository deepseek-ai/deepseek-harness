---
description: "subprocess 组地图：共享的子进程服务及其本地宿主提供方，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# subprocess/：子进程能力家族

[English](README.md) | 中文

## 概述

harness 运行的每个子进程与终端会话——bash 命令、语言服务器、持久 shell 与进程外 subagent 后端——都经由一个共享服务（`ctx.subprocess`）启动、观察与终止，并由一个本地提供方在宿主机器上执行。它不是独立的产品功能：消费方能力 seam 决定每个进程的含义，命令语义、时限与面向模型的呈现仍归它们所有。本组提供可执行文件查找、带 spill 恢复的有界输出捕获、由提供方管理且明确披露较弱 fallback 的进程范围，以及每个子进程起步时所用的清理后环境。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`subprocess`](subprocess/README.zh.md) | 定义子进程服务：可执行文件查找、受管进程 spawn 与真实终端会话 | `ctx.subprocess` |
| [`subprocess-local`](subprocess-local/README.zh.md) | 在支持的平台上以原生受管范围运行宿主进程与终端，其他平台使用明确披露的较弱 fallback | 注册到 `ctx.subprocess` |
| [`win32-process`](win32-process/README.zh.md) | 归属 sandbox 与普通进程创建、stdio、Job 分配、轮询、等待与句柄清理所用的共享 Win32 绑定 | 库，不使用 ctx key |

即使消费方重载，进程生命周期仍由服务负责管理；消费方负责定义进程的含义（一条 bash 命令、一个语言服务器），以及决定塑造该进程的每一项默认值。

-----

<a id="related-documentation"></a>
## 相关文档

- [子进程子系统](../../docs/subsystems/subprocess.zh.md)——spawn spec、输出读取器、结果与受管的 `DSH_*` 环境。
- [subprocess seam Agent Note](../../.agents/notes/archived/architecture/2026-07-26-subprocess-seam.md)——bash 执行器的进程部分为何成为独立的 seam。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
