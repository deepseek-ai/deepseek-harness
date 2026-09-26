---
description: "账号页面使用经过认证的 Remote 操作和快照流。控制器提供登录状态，不返回 token 或 PKCE 私密数据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-account-controller

[English](README.md) | 中文

## 概述

账号页面使用经过认证的 Remote 操作和快照流。控制器提供登录状态，不返回 token 或 PKCE 私密数据。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

account 命名空间提供 getState、getProfile / getBalance、getUnnotifiedBonuses、ackBonusNotified、startSignIn、cancelSignIn、signOut 和 watch。watch 先发送完整初始状态，随后发送完整状态变化；断开连接只停止观察，不取消登录。取消操作必须指定尝试 ID，防止旧页面取消新登录。账号缺失或已切换时 getUnnotifiedBonuses 返回 null、ackBonusNotified 返回 false；需要调用方重试的失败以抛出的 Remote 错误返回。

到达 Platform 的每个操作都接收调用界面的 `AccountClientMetadata`——客户端版本、当前语言和以秒为单位的 UTC 偏移——因此 Host 报告的是发起请求的界面，而不是它上一次见到的调用方。取消和 watch 不接该参数，因为它们不会到达 Platform。

`watchExpiry` 仅发送实时凭据失效通知，不发送初始值，也不重放历史通知。桌面端通过该流，在切换到 Welcome 时交接一次性 toast。

`hasRunningAccountTasks` 通过账号模块的判断函数，检查运行中 Agent 最近记录的请求上下文，包括工具和重试阶段。空闲 Agent 及 API key 上下文不计入。移除凭据时，账号提供方独立取消匹配任务。

<a id="understand-the-implementation"></a>
## 理解实现

控制器向账号服务转发操作，不维护独立的账号状态，因此不发布 invariant。

<a id="further-exploration"></a>
## 深入探索

[凭证子系统](../../../docs/subsystems/credentials.zh.md)定义存储接口；[架构](../../../docs/architecture.zh.md)说明应用组合。

<a id="model-experience"></a>
## 模型体验

无，因为账号凭证只影响 HTTP 认证，不进入模型提示、Session 日志或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- UI 断线后可通过 watch 恢复状态，但不能在 Host 退出后恢复登录尝试。凭证和请求 token 解析不对 Remote 暴露。

<a id="dev-note"></a>
### 开发备注

[桌面登录决策](../../../.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.zh.md)记录取消和存储的职责。
