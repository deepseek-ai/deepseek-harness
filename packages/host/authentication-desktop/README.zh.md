---
kind: package-reference
description: "使用仅存于内存的私有凭据认证 Desktop 请求，不向 renderer 暴露凭据。"
---

# @deepseek-ai/dsh-host-authentication-desktop

[English](README.md) | 中文

## 概述

Desktop 可以使用私有凭据访问 Host，无需浏览器 Token 交换。凭据仅在 Electron 主进程与其自有 Host 之间流动，绝不进入浏览器 Cookie 存储；renderer 只收到普通启动数据。所有认证成功的 Desktop 请求在该 Desktop 生命周期中共享 owner 权限。

## 目录

- [使用](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

Desktop 启动 owner 收到父进程的私有凭据后，通过 Cordis 挂载插件。它注入 `connection` 创建 Peer，通过 `connection.authentication` 注册 Provider；Connection 插件提供这两个服务。配置仅在内存中交付，而非写入 profile 或设置文件。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `readSecret` | 必填 | 返回已在父进程私有 IPC 通道上通过校验的凭据的函数 |

Provider 接受单个与自身凭据匹配的 `dsh-desktop-session` Cookie 值。重复值、格式错误和不匹配凭据均拒绝。认证成功的 HTTP 和 WebSocket 准入复用已有 Peer。插件卸载移除 Provider 注册，并通过原 Connection 生命周期结束该 Peer。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Desktop 父进程生成并私下交付凭据。Host 应用的 IPC 接收器校验握手；启动入口在发布页面注入前通过 ConnectionAuthentication 完成认证。两端均使用固定 Cookie 名 `dsh-desktop-session` 和 `<name>=<secret>` 格式。Cordis 插件拥有凭据验证和 Peer 创建。Desktop 拥有 Host 地址校验和请求转发，包括来源检查与凭据附加。它提供进程通道、挂载插件并发布单条 ready 响应。ConnectionAuthentication 拥有 Provider 注册表与验证；Connection 拥有 Peer 创建与传输。

[插件入口](src/index.ts)导出标准的 `name`、`inject`、`apply` 成员；`Config` 是 TypeScript 接口。Token 和 Desktop 通过相同的 ConnectionAuthentication 服务注册，两者互不依赖。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Desktop 应用](../../../apps/desktop/README.zh.md)——父进程与 Host 启动。
- [Connection](../../client/connection/README.zh.md)——ConnectionAuthentication 注册与 Peer 生命周期。
- [Token 认证](../authentication-token/README.zh.md)——浏览器启动 Token 认证。

<a id="model-experience"></a>
## 模型体验

无，因为认证不增加模型可见输入。

#### KV Cache 影响

无；认证不修改模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本插件是 Desktop 启动组件。输入必须是进程 owner 已验证的私有凭据，共享 Peer 在该 Desktop 生命周期中授予 owner 权限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
