---
description: "为开发和配置已安装 Harness 插件的 agent 提供只读运行时 API 查询。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-cordis

[English](README.md) | 中文

## 概述

编写插件代码前查询 Host 和 Client 的运行时 API。创造模式同时提供这些只读工具与 Plugin Manager，后者负责持久化 profile 变更。检查注册表由 Cordis host runner 提供；浏览器查询需要已连接的页面。

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

创造模式包含这组工具。其他组合需要在宿主组合里、提供 `cordisInspect` 的 host runner 旁挂载一次 `@deepseek-ai/dsh-tool-cordis/host`，并在每个要暴露这些工具的 agent preset 里挂载 `@deepseek-ai/dsh-tool-cordis`；仅有 preset 行不会注册任何 Host provider。调用 `cordis_inspect_list` 发现 provider，再用 `cordis_inspect_query` 查询其具体方法和类型。Host 的 `Config` provider 分页列出运行中的 Loader entry（`offset`、最多 100 的 `limit`、可选的精确插件 `name`；`total` 与 `nextOffset` 界定遍历），每个 entry 带 Loader id、patch 所寻址的树内 id 及其 Config 状态（`schema`、`absent`、`unsupported`、group 与 include 载体为 `tree`、禁用、未导入或已销毁的 entry 为 `inactive`），并把单个 entry 的原生 Config 投影为自包含的 JSON Schema 文档，同时在 profile 包查找能解析时给出该 entry 的 `packageDir`，即包 README 与构建产物 `lib/` 所在目录。通过 [Plugin Manager](../../boot/plugin-manager/README.zh.md) 安装包含插件代码或 MCP 配置的组合包。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Host provider 结合生成的 Service/Event 目录、经 app-boot Config 投影器投影的运行中 Loader 树，以及请求 agent 的工具注册表。Client provider 通过现有检查注册表同步清单，并从已连接页面回答查询。宿主入口持有 Host provider 的注册，preset 行持有两个工具，都通过 Cordis effect；注册表拒绝重复的 provider id，所以 provider 按进程注册一次而不是按 preset 注册。检查直接读取 provider，不维护独立运行时投影，因此不发布不变式配套插件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Plugin Manager](../../boot/plugin-manager/README.zh.md) — 持久化组合包安装和启停。
- [Cordis host runner](../cordis-host-runner/README.zh.md) — 检查注册表和现有运行时消费者。

<a id="model-experience"></a>
## 模型体验

### 运行时检查

#### 模型所见

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-cordis) 描述两个只读检查工具。插件不贡献 system prompt 段落：工具描述已说明何时调用每个工具以及查询不会调用业务方法。在 `cordis` preset 中，首轮 skill catalog 携带两个随附技能的描述，把插件、MCP、组合编辑和未指定去向的视觉请求路由到覆盖 Plugin Manager、MCP 设置、Client 打包和 slot 注册的技能。查询结果包含所请求的 API 声明、当前工具 schema、带 Config 状态的运行中 entry 目录，或单个 entry 投影后的 Config JSON Schema。

#### Token 影响

插件可见时，只有两个工具 schema 进入模型请求。查询结果追加到转录中；精确查询避免加载无关声明。

#### KV Cache 影响

未改变的工具 schema 保持前缀稳定。查询结果追加到历史中；启用其他插件可能改变后续工具 schema。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- Client 查询等待页面响应或取消。检查不能调用服务方法、配置插件或执行生成代码。
- `Config.listConfigs` 只遍历 profile 的 Loader 树。Agent preset 的 `plugins` 列表挂载在独立的 preset 树中，所以只出现在 preset 声明里的插件不会被列出，除非 profile 树也挂载了它。

<a id="dev-note"></a>
### 开发备注

无。
