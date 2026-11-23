---
description: "为开发和配置已安装 Harness 插件的 agent 提供只读运行时 API 查询。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-cordis

[English](README.md) | 中文

## 概述

编写插件代码前查询 Host 和 Client 的运行时 API。Desktop 标准模式、创造模式和 SDK profile 同时提供这个只读工具与 Plugin Manager，后者负责持久化 profile 变更。检查注册表和 Host provider 由 Cordis host runner 提供；浏览器查询需要已连接的页面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Desktop 标准模式、创造模式和 SDK profile 包含这个工具。其他组合需要在宿主组合里挂载一次 `@deepseek-ai/dsh-cordis-host-runner`，它提供 `cordisInspect` 并注册 [Host provider](../cordis-host-runner/README.zh.md#host-inspect-providers)；再在每个要暴露这个工具的 agent preset 里挂载 `@deepseek-ai/dsh-tool-cordis`。调用 `cordis_inspect` 时省略 `query` 以发现 provider，再传入包含 `platform`、`provider`、`method` 及可选 `input` 的 `query` 对象，读取 provider 的具体方法和类型。没有 Agent 的查询以 `ToolContextUnavailableError` 失败。通过 [Plugin Manager](../../boot/plugin-manager/README.zh.md) 安装包含插件代码或 MCP 配置的组合包。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

preset 行通过 Cordis effect 注册这个工具，并查询共享的 `cordisInspect` 注册表。注册表拒绝重复的 provider id，所以 Cordis host runner 按进程注册一次 Host provider。Client provider 通过同一注册表同步清单，并从已连接页面回答查询。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Plugin Manager](../../boot/plugin-manager/README.zh.md) — 持久化组合包安装和启停。
- [Cordis host runner](../cordis-host-runner/README.zh.md) — 检查注册表、Host provider 和现有运行时消费者。

<a id="model-experience"></a>
## 模型体验

### 运行时检查

#### 模型所见

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-cordis) 描述一个只读检查工具，其描述说明目录发现和查询方式，不添加 system prompt 段落。在 `standard` 和 `cordis` preset 中，首轮 skill catalog 携带随附的 `dsh-doc` 技能的描述，该技能覆盖关于 DSH 的问题，以及构建或修改 DSH 插件、MCP 连接和 agent preset 的请求；其参考资料覆盖 Plugin Manager、MCP 设置、Client 打包和 slot 注册。查询结果包含所请求的 API 声明、当前工具 schema、带 Config 状态的运行中 entry 目录、单个 entry 投影后的 Config JSON Schema，或当前运行的 DSH 版本。

#### Token 影响

在随发行版提供的 Desktop 标准模式、创造模式和 SDK profile 中，此插件向每次模型请求提供一个工具 schema。查询结果追加到转录中；精确查询避免加载无关声明。

#### KV Cache 影响

未改变的工具 schema 保持前缀稳定。查询结果追加到历史中；启用其他插件可能改变后续工具 schema。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- Client 查询需要页面响应，并采用 Host runner 的[有界等待与重试策略](../cordis-host-runner/README.zh.md#client-inspection)。检查不能调用服务方法、配置插件或执行生成代码。

<a id="dev-note"></a>
### 开发备注

无。
