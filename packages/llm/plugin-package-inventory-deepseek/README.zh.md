---
description: "面向发送官方 DeepSeek 请求的部署，说明活跃 Loader 包清单元数据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-package-inventory-deepseek

[English](README.md) | 中文

## 概述

用于 DeepSeek 官方 LLM API 请求的完整存活 Loader 插件包清单。该函数插件注入 Loader、存活 Agent 注册表与 `ctx.deepseekLlmApiExtensions`，并拥有 `dsh_plugin_packages` 字段。当官方 API 需要活动包清单进行请求诊断时，请启用它。

## 目录

- [配置](#configuration)
- [收集](#collection)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration"></a>
## 配置

| 配置键 | 默认值 | 含义 |
|---|---:|---|
| `enabled` | `true` | 注册 `dsh_plugin_packages` 贡献。将其设为 `false` 可省略包元数据。 |

随附 profile 使用该默认值，因此只要准备成功，每个 DeepSeek 官方请求都会携带包清单。

<a id="collection"></a>
## 收集

每次请求都会重读宿主 Loader 树中的存活非 group 配置项。存在可选 `ctx.agentPresets` 且 `sessionId` 解析到已加入 standing preset 的存活 Agent 时，该 preset 的独立 Loader 树也会加入同一次收集；未挂载该服务的部署只报告宿主树。只有根 fiber 处于 `ACTIVE` 且 Loader 有效状态为启用的配置项才会纳入。

裸包与包子路径 specifier 通过 Node 包搜索路径解析，无需包导出 `./package.json`。每个普通配置项使用其所属 Loader 树的基址。standing preset 的根配置项使用宿主基址，与 preset Loader 对裸包的显式覆写保持一致；嵌套 include 仍使用自身基址。相对与绝对模块会向上查找最近的 manifest（元数据清单）；没有 `name` 的 manifest 只标记松散模块，不贡献包身份。具名包 manifest 还必须声明非空 `version`，格式错误的包元数据会使请求准备失败。系统使用与 locale 无关的比较按确切名称／版本对去重并排序，同时存活的不同版本仍会分开保留。

版本 1 的 `dsh_plugin_packages` 字段只包含 `{ name, version }` 对。系统会排除禁用、pending、failed、disposed、unloading 状态，结构性 `cordis:` 配置项，普通依赖，没有所属包身份的松散文件，以编程方式挂载的子 fiber，以及内存动态插件。

<a id="model-experience"></a>
## 模型体验

### 包清单元数据

#### 模型看到的内容

无。`dsh_plugin_packages` 是位于模型消息、系统提示词与工具 schema 之外的提供方元数据。

#### Token 影响

模型输入 token 为零；完整清单只会增加 HTTP 请求字节数。

#### KV Cache 影响

无；包生命周期变化不会改变模型可见前缀。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **仅含 Loader 包来源**——以编程方式创建的子 fiber 与内存动态插件没有权威 NPM 名称／版本来源，因此不在该清单内。
- **省略松散模块**——没有具名且带版本所属 manifest 的相对文件是插件模块，不是插件包。
- **原地替换包需要重启**——manifest 身份会在进程存活期内缓存。Loader 的启用、禁用、挂载、卸载与普通源码 HMR 仍会刷新存活配置项集合，但在同一进程中把已挂载包的 manifest 替换为另一版本并不是受支持的升级路径。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。每次请求直接读取权威 Loader fiber 状态与 package manifest，插件不保留独立可变 inventory。
