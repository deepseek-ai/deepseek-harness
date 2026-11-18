---
description: "DeepSeek 账号能力族的包映射：浏览器登录、已存账号授权，以及为每个 DeepSeek API 请求在账号登录与 API 密钥之间选择的请求鉴权。"
kind: "package-group"
---

# account/：DeepSeek 账号

[English](README.md) | 中文

## 概述

`account/` 组通过系统浏览器让用户登录 DeepSeek，并把账号授权保存在 [`credentials/`](../credentials/README.zh.md) 拥有的本地凭据库中。Host 消费方从不读取 token：`ctx.deepseekAuth` 向 `ctx.deepseekAccount` 索取某个请求目标的凭据，并把其请求头、用于 HTTP 401 的失效操作以及退出登录时中止的信号交给 DeepSeek 模型路由和 Web 提供方。同一个服务也为由 API 密钥计费的消费方释放密钥。客户端通过不携带凭据的 `account` Remote 命名空间获得账号状态。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

两个包提供账号功能和 DeepSeek 请求鉴权；它们的 README 覆盖日常使用，全部约定以子系统参考为准。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`deepseek-account/`](deepseek-account/README.zh.md) | 浏览器登录、已存授权、Platform 资料、余额与通知读取，以及面向允许目标的仅限 Host 的请求凭据 | `ctx.deepseekAccount` |
| [`deepseek-auth/`](deepseek-auth/README.zh.md) | 面向所有 DeepSeek API 消费方的请求鉴权：按计费方式排定 API 密钥与账号登录的顺序，把每一种绑定到其部署，并释放请求头 | `ctx.deepseekAuth` |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考了解账号约定，再看授权所在的凭据库。

- [账号子系统参考](../../docs/subsystems/account.zh.md)——登录状态、请求凭据、Platform 会话投影与生成的 Cordis 接口面。
- [凭据子系统参考](../../docs/subsystems/credentials.zh.md)——保存授权的凭据记录。
- [能力 seam](../../docs/capability-seams.zh.md)——本家族遵循的 Service Definition / Service Provider / Consumer 拆分。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-deepseek-account)——账号服务的每个受支持字段。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
