---
description: "面向使用 SSH 文件系统和子进程提供方的组合，说明远端文件效果限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-ssh

[English](README.md) | 中文

## 概述

`dsh-sandbox-ssh` 为 SSH 子进程提供方启动的进程提供 `ctx.sandbox`。远端主机选择其已安装的本地沙箱后端，并在远端执行每次调用的策略。Bash 与 Node 获得同一后端的执行完整性等级、拒绝特征及运行器失败分类。

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

将本提供方与共享 [SSH 连接](../ssh/README.zh.md)、SSH 文件系统及 SSH 子进程提供方一同挂载。本包没有专用配置。等待 `confine(argv, policy, signal)`，由正在运行的远端辅助程序解析每次调用的策略与命令。

传入完整的 `read-only` 或 `workspace-write` 策略。工作区路径在远端主机解释并规范化。消费方在 `danger-full-access` 模式下绕过 `confine()`；连接不额外引入本地／远端策略标记。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

正在运行的辅助程序规范化策略根路径，再向已加载的沙箱提供方获取强制执行限制的 argv、执行完整性等级与运行器失败证据。SSH 子进程提供方直接执行返回的 argv，并负责 fd 7 传输及托管进程生命周期。取消请求或后端不可用时，会在调用方取得可启动命令之前拒绝请求。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进程沙箱子系统](../../../docs/subsystems/sandbox.zh.md) — 策略含义及执行完整性披露。
- [本地沙箱提供方](../../sandbox/sandbox-local/README.zh.md) — 远端主机继承的后端及平台限制。

-----

<a id="model-experience"></a>
## 模型体验

间接通过现有沙箱消费方产生影响，由它们报告模式、拒绝及执行完整性，并负责审批展示及模型参数。

#### KV Cache 影响

本提供方不贡献请求前缀内容。面向模型的工具与结果由消费方负责。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 文件效果模式不限制网络访问或进程可见性。远端 `partial` 后端仍属于部分执行。
- SSH 主机与已安装辅助程序属于可信基础设施。摘要检查与文件效果限制不构成对抗恶意主机的安全边界。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口。消息校验及所属文件系统、子进程和沙箱提供方执行可观察的约束；此适配器没有增加可独立观察的状态关系。

</details>
