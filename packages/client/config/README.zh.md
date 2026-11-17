---
description: "浏览器同步插件配置的类型"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-config

[English](README.md) | 中文

## 概述

浏览器插件读取自身实时 Host 配置所用的类型。插件只声明一份 Config 并配一个 Host schema；其 Client 面通过 `apply` 以 `SyncedConfig` 收到顶层 volatile 字段，并通过 `ctx.config` 读取其他包的同步配置。本包只包含类型；值的投影、下发与更新由 [Client Modules](../modules/README.zh.md#synced-plugin-configuration) 负责。

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

插件包把本包列入 `devDependencies`，只用 `import type` 从 `@deepseek-ai/dsh-client-config/types` 导入：

| 类型 | 用途 |
|---|---|
| `SyncedConfig<C>` | 共享 Config 类型为 `C` 的 Client 面的 `apply` 配置：每个顶层 `Volatile` 字段对应一个 `SyncedConfigRef`。每个字段都可能读到 `undefined`（密钥、无法投影的值，或尚未与浏览器代码对应的 Host 构建），插件在每次读取时处理缺值 |
| `SyncedConfigRef<T>` | 单个字段：`get()` 读取当前冻结值，写法与 Host 读取 volatile 引用一致；`getSnapshot` 与 `subscribe` 使它可以直接作为可观察数据源注入 slot 的 `hooks`。它没有写操作 |
| `SyncedConfigValues` | 图行携带的单个插件同步字段的 JSON 值 |
| `SyncedConfigService` | `ctx.config.resolveConfigByPackage<C>(packageName)`，只读地查询另一个包当前激活的对象；导入这些类型也同时声明了 `ctx.config` |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包通过 `./types` 与两个面导出类型，Host 与 Client 的 `apply` 都不注册任何内容。所有类型由 Client Modules 实现：Host 面把值投影进图行，页面条目控制器把对象交给每次插件激活并提供 `ctx.config`。因此插件依赖这些类型，而不是依赖启动最早的 Client Modules 包。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Note：前端插件配置同步](../../../.agents/notes/implemented/architecture/2026-11-15-client-config-sync.zh.md)
- [Client Modules 同步插件配置](../modules/README.zh.md#synced-plugin-configuration)

-----

<a id="model-experience"></a>
## 模型体验

无，本包声明浏览器配置类型，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `resolveConfigByPackage` 信任调用方给出的 Config 类型参数，类型写错不会被发现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
