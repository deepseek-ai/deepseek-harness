---
description: "在仓库测试中对着回环 OAuth 授权服务器运行 MCP OAuth 流程，并经真实 profile 挂载 MCP 管理器。"
kind: "package-library"
---

# @deepseek-ai/dsh-mcp-testkit

[English](README.md) | 中文

## 概述

需要真实 MCP OAuth 交换或经 profile 组合的 MCP 管理器的测试使用本包。它提供回环 OAuth 授权服务器和 MCP 端点，并经真实 profile、ConfigEditor 和 Loader 挂载 MCP 客户端宿主与管理器。测试将其作为开发依赖导入；每个 fixture 都把自己的清理注册到当前测试。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 `@deepseek-ai/dsh-mcp-testkit` 加入消费包的 `devDependencies`。启动 OAuth world，在其 context 上挂载管理器，再通过管理器驱动授权：

```ts
import { callback, managerProfile, oauthWorld, phase } from '@deepseek-ai/dsh-mcp-testkit'

const world = await oauthWorld()
await managerProfile(world.ctx, { base: { servers: { oauth: { ...world.config, enabled: true } } } })
const attempt = await world.ctx.mcpManager.startAuthorization('oauth')
```

`oauthWorld()` 返回带有凭据、授权、Web 服务器和工具服务的 world context、一份使用 OAuth 的 Streamable HTTP 配置、授权所有者工厂，以及改变协议服务器 token、拒绝和元数据应答的开关。`phase()` 等待尝试进入某个阶段，`callback()` 投递浏览器回调，`authorize()` 通过一个所有者完成一次授权。`managerProfile()` 用继承的 bundle 和可选的用户 patch 组合 MCP 客户端宿主与管理器；其 context 必须已带有工具服务。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[`src/oauth-world.ts`](src/oauth-world.ts) 由一台回环 HTTP 服务器应答 OAuth 发现、动态注册、token 和 MCP 请求，并记录每个请求。[`src/manager-profile.ts`](src/manager-profile.ts) 写出一个临时 profile，其 bundle 插入宿主与管理器条目，再经 Loader 挂载。两者都通过 `onTestFinished` 注册清理，因此只能在测试内运行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [MCP 客户端](../../mcp/mcp-client/README.zh.md#oauth)——OAuth 连接、显式授权与 MCP 客户端宿主。
- [MCP 管理器](../../mcp/mcp-manager/README.zh.md)——profile fixture 挂载的服务器集合。
- [test-support 分组地图](../README.zh.md)——同组测试工具。

-----

<a id="model-experience"></a>
## 模型体验

无，这些 fixture 只承载 OAuth 和 MCP 协议流量，不组装或发送模型请求。

#### KV Cache 影响

无；本包自身不发送 provider 请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 授权服务器总是批准请求：它不显示同意页、不校验客户端密钥，测试通过 world 的开关改变其应答。
- fixture 调用 `onTestFinished`，因此只能在 Vitest 测试内运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
