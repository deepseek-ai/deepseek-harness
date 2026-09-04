---
description: "浏览器安全的 Workspace 路径辅助函数：拼接相对路径、缩写 POSIX 主目录并生成显示标题。"
kind: "package-library"
---

# dsh-util-workspace-path

[English](README.md) | 中文

## 概述

供 Workspace 相关客户端和控制器包共享、可在浏览器使用的路径辅助函数。该包负责拼接 Workspace 相对路径、缩写用于展示的 POSIX 主目录，以及从 POSIX 或 Windows 路径提取 Workspace 标题；它不提供 Cordis service，也不持有运行时状态。

## 目录

- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **路径解析仅处理字面值**——它识别 POSIX 绝对路径、Windows 盘符路径和 UNC 路径，拼接相对路径时保留 Workspace 路径的分隔符，但不访问文件系统，也不规范化 `.` 与 `..` 路径段。
- **主目录缩写仅支持 POSIX**——Windows 路径保持不变，因为可移植浏览器无法安全推断 Windows 主目录路径等价关系。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这个工具不持有可变运行时关系。
