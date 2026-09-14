---
description: "浏览器安全的 Workspace 路径辅助函数：拼接相对路径、缩写 POSIX 主目录并生成显示标题。"
kind: "package-library"
---

# dsh-util-workspace-path

[English](README.md) | 中文

## 概述

供 Workspace 相关客户端和控制器包共享、可在浏览器使用的路径辅助函数。该包负责拼接 Workspace 相对路径、缩写用于展示的 POSIX 主目录、从 POSIX 或 Windows 路径提取 Workspace 标题、把路径拆成目录部分与末段供展示，并拥有在 Sidebar 与资源模型之间命名工作区文件的 `dsh-resource://file/…` 地址语法。`relativizeToCwd` 在显示时省略工作区前缀，并保留该目录以外的路径。它不提供 Cordis service，也不持有运行时状态。

## 目录

- [文件地址](#file-addresses)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="file-addresses"></a>
## 文件地址

资源地址 = `dsh-resource://<type>/…`，type（URI 的 host）即资源协议键（`file`，或插件在 `ResourceProtocolMap` 中声明的键）；其他 scheme 属导航协议，另行定义。`dsh-resource://file/session/<sessionId>/<path>` 指定授权 Host 读取的 Session，以及工作区相对或绝对路径。前导斜杠保留在路径中：`/etc/hosts` 对应 `dsh-resource://file/session/s//etc/hosts`，Windows 盘符对应 `dsh-resource://file/session/s/C:/x/y.txt`，UNC 对应 `dsh-resource://file/session/s///server/share/y.txt`。Host 解析路径并执行访问检查。`absolute/<path>` 形式仍可解析，但不携带授权 Session，因此 file 提供方不能读取，Preview 也不认领；两者均不借用当前或 Tab Session。语法住在 [`src/file-address.ts`](src/file-address.ts)；路径辅助函数留在 [`src/index.ts`](src/index.ts) 并再导出它。

`sessionFileAddress(sessionId, path)` 将 `\` 归一为 `/`，去掉前导 `./`，但保留前导 `/` 字符。id 和每个路径段都做组件编码，`:` 保持字面。`fileAddressFor(sessionId, cwd, path)` 始终构造 Session 地址：`cwd` 内的路径转为相对路径；其他绝对路径（包括 `cwd` 未知时）仍作为该 Session 地址内的绝对路径。`absoluteFileAddress(absolutePath)` 只构造不带 Session 的形式。`parseFileAddress(address)` 检查精确的文件地址前缀、忽略查询与片段后缀、逐段解码，并为 Session 地址返回 `{ scope, sessionId, path }`，为不带 Session 的形式返回 `{ scope, path }`。其他 type 或 scheme、未知作用域、缺 id 或路径，或错误转义都返回 `undefined`。

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
