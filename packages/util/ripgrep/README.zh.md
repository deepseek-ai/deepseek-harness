---
description: "通过组合的子进程提供方运行打包的 ripgrep，为文件搜索消费方提供有界流式读取。"
kind: "package-library"
---

# @deepseek-ai/dsh-util-ripgrep

[English](README.md) | 中文

## 概述

使用本库，无需 shell 或系统安装的 `rg` 即可启动打包的 ripgrep。`tool-fs-search` 使用收集后的输出；`workspace-files` 增量读取文件路径，并在配置的上限处停止。调用方显式传入工作目录、参数、流模式、终止宽限期与取消信号，并负责解释退出码。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

从本包导入 `spawnRipgrep`，传入组合的子进程服务与显式的 `SubprocessSpawnSpec`；其中 `argv` 只包含 rg 参数。返回的 handle 按请求提供已收集输出或管道流。stdout 为管道时，`readRipgrepLines` 逐条提供以换行或 NUL 分隔的 UTF-8 记录；回调返回 false 会终止 rg，并抑制剩余记录。该函数等待 stdout、进程结果与托管进程范围全部结束后返回。回调、流或提供方失败会在清理后拒绝。调用方按自身 signal 解释退出码与取消。

只需要可执行文件路径的消费方可以独立使用 `resolveRgPath`。解析与启动失败会拒绝调用，不阻止导入本包。本库是依赖，不是 profile 插件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

单文件运行时优先选用可执行文件旁已有的 `-rg` 附属程序，否则使用 `@vscode/ripgrep` 平台包。Electron 路径将 `app.asar` 替换为 `app.asar.unpacked`。每次启动前置 `--no-config`，防止环境中的 rg 配置启用预处理程序。子进程提供方负责环境清理与终止；调用方负责截止时间与结果预算。参见[实现](src/index.ts)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [子进程提供方约定](../../subprocess/subprocess/README.zh.md)——显式启动规格与托管进程范围。
- [模型搜索工具](../../fs/tool-fs-search/README.zh.md)——输出收集、工具错误与结果保留。
- [工作区文件搜索](../../api/workspace-files/README.zh.md#search)——原生忽略规则与浅层优先的文件及祖先目录匹配。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过消费子进程输出的搜索工具。

#### KV Cache 影响

没有直接影响；模型可见结果与请求装配由消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **要求同处一个执行环境的程序**——解析使用 Host 的打包二进制路径。远端子进程提供方没有该程序时调用失败；不查找系统 rg，也不回退到文件系统遍历。
- **记录缓冲**——流式读取保留一条尚未完整的记录与当前流块；文件名可能含换行符的调用方使用 NUL 分隔符而不是换行符。记录按 UTF-8 解码，因此不是有效 UTF-8 的文件名会带着 U+FFFD 替换字符到达，无法用该字符串打开。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
