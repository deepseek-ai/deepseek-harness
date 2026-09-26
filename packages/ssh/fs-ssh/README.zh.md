---
description: "面向与 SSH 子进程共享文件的消费方，说明远端文件系统语义。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-ssh

[English](README.md) | 中文

## 概述

`dsh-fs-ssh` 在 SSH 辅助进程的文件系统中提供 `ctx.fs`。文件工具读写的文件与远端 Bash、终端、语言服务器和 Node 程序看到的文件一致。远端路径规范化、版本保护及原子修改使用辅助程序旁安装的本地文件系统实现。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本提供方与 [`dsh-ssh`](../ssh/README.zh.md) 及 `sandboxPolicy` 一同挂载，并使用配套 SSH 子进程与沙箱提供方执行程序。本提供方没有配置字段：连接身份和默认工作区属于 `dsh-ssh`，文件效果模式属于 `sandboxPolicy`。

`resolve()` 在远端主机上规范化路径。`processPath()` 与 `fileUrl()` 在同一个远端命名空间中标识文件，并不授予主机侧访问能力。文件 URL 对字面的百分号、反斜杠和换行进行编码，保留原文件名。`processPathFromHostPath()` 返回 `undefined`，因此需要已安装可执行文件或引导程序的消费方必须显式提供远端产物。

读取保留共享文件系统错误码。写入和编辑将已解析的逐次调用策略发送给辅助程序，由其规范化工作区并在原子修改所在位置执行策略。传输丢失报告 I/O 失败；修改可能已经提交，不会自动重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

辅助程序复用 [`fs-local`](../../fs/fs-local/README.zh.md) 与 [`fs-sandbox`](../../fs/fs-sandbox/README.zh.md)，保留符号链接身份、陈旧版本拒绝、差异基线及发布语义。UTF-8 流使用有界拉取请求，在消费方提前停止时关闭远端迭代器。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md) — 共享操作及错误含义。
- [SSH 连接](../ssh/README.zh.md) — 部署与断连行为。

-----

<a id="model-experience"></a>
## 模型体验

间接通过现有文件系统消费方产生影响，由它们展示远端路径及文件内容，并负责每个工具与提示。

#### KV Cache 影响

本提供方不贡献请求前缀内容。面向模型的工具与结果由消费方负责。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 辅助程序将整段文本读取及单次字节窗口限制为 8 MiB。更大的读取需使用文本流或多个字节窗口；其他 JSON 传输也受连接消息大小上限约束。
- 不支持文件系统监听：提供方不覆写 `watch()`，由基类以 `FS_IO_ERROR` 拒绝；不使用轮询，也不为远程路径建立本地监听。普通读取与消费方提供的手动刷新仍可用。
- 远端文件 URL 是执行坐标，不是主机文件系统句柄或 Web 下载链接。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口。消息校验及所属文件系统、子进程和沙箱提供方执行可观察的约束；此适配器没有增加可独立观察的状态关系。

</details>
