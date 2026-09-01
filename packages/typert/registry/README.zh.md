---
description: "运行时 Typert 注册表：保存生成的包反射、实时 Zod schema 与 Remote 调用描述符，并按需为消费方解析。"
kind: "package-reference"
---

# @deepseek-ai/dsh-typert-registry

[English](README.md) | 中文

## 概述

`dsh-typert-registry` 让生成的 Typert 产物在运行时可按需查询：每个包的反射——服务、事件与对象——其实时 Zod schema 与 Remote 调用描述符都保存在稳定键下，消费方可以按需查询或解析。注册是原子且按 fiber 作用域的：贡献要么整体落地要么完全不落地，并在注册组件卸载时自动撤销。同一服务还托管 Remote 调用所经由的 lookup 与作用域 Context 提供方注册表。它不执行 TypeScript 分析，也不生成 schema；这些由生成器与 loader 负责。

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

在存储或消费生成 Typert 产物的任何 Host 或 Client 组合中挂载本注册表；它提供 `ctx.typert`。没有配置。

### 最小设置

加载注册表插件；Client face 由 Client 运行时自身的元数据以同样方式安装，两个 face 运行同一实现：

```yaml
- name: '@deepseek-ai/dsh-typert-registry'
```

### 查询 schema 与反射

消费方用 `get(key)`、`resolve(key)` 或 `list(filter?)` 读取 schema，用 `getPackage(name, face?)` 或 `listPackages(filter?)` 读取包反射。`resolve()` 能区分格式错误的键、未注册的包，以及已注册但未以该名称提供 schema 的包，各自给出不同的错误。`toJSONSchema(key)` 把实时 Zod schema 投影为 JSON Schema，且不缓存结果。

### 注册贡献

生成产物在 Loader 组合中通过 [loader](../loader/README.zh.md) 注册；其他所有者直接调用 `ctx.typert.register(contribution)`，并获得撤销它的同一资源释放函数。重复的包与 face 组合键、schema 键、调用 id 或端点会在提交任何内容之前拒绝整个批次。

### Lookup 与 Context 提供方

Remote 调用通过 `ctx.typert.lookups` 与 `ctx.typert.contexts` 解析 Host 对象与作用域 Context。`registerHost()` 安装一个双向 Host Context adapter 及其 wire 声明，`configureHost()` 只替换其中的 resolver。`registerClient()` 为同一个 merge-declared kind 安装双向 Client adapter。`identifyHost(ctx)` 通过 Host adapter 识别活 Context 所代表的唯一 kind 与 identity，并拒绝歧义识别。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释注册表如何存储与拥有贡献；消费方 API 已在[使用本包](#use-this-package)中说明。

### 设计理念

注册表建立在一个原则之上：贡献是一次原子、由 fiber 拥有的提交。`register()` 先校验包与 face 组合键、schema 与调用描述符，再在单个 Cordis effect 下提交全部内容，该 effect 的资源释放函数精确撤销这一贡献。重复标识在拥有该操作的所有权边界失败，此时任何状态都未改变。

### 子注册表

- `ctx.typert.local`——当前环境的调用定义，含供源码模式回退使用的 `hasSeen()` 历史。
- `ctx.typert.remotes`——在调用方 fiber 中挂载的、由消费方选中的贡献。
- `ctx.typert.lookups`——lookup 提供方，以及按键配置的组合方解析器覆盖。
- `ctx.typert.contexts`——按作用域键配置的 Host Context 提供方与 Client Context 绑定器。

每个子注册表都会向已订阅的监听器发布 `TypertRegistryChange` 事件；抛异常的监听器会被记录日志，且不会阻止后续监听器。

### 标识与校验

键是稳定的：反射用 `<package>#<face>`，schema 用 `<package>#<name>`，端点用 `<namespace>/<method>`。校验会拒绝含 `#` 的名称、超出 RPC 端点段文法的 wire 名称、重复键，以及在其注册表生命周期内改变 wire 声明的 lookup 定义；严格编解码器必须携带可解析的 schema。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/service.ts`](src/service.ts) | `TypertRegistry` 服务、存储、校验、effect 接线 |
| [`src/types.ts`](src/types.ts) | 贡献、记录与过滤器类型 |
| [`src/client/index.ts`](src/client/index.ts) | 安装同一注册表的 Client face |
| — | 不发布运行时不变式伴生入口；schema 与 package-reflection record 在 register/dispose 内一起变更，没有独立 event 或第二数据源可供交叉核对；重复 identity 在所属操作处失败。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从注册表逐步进入供给它与消费它的内容。

- [Typert loader](../loader/README.zh.md)——生成宿主产物的自动注册。
- [Typert 生成器](../generator/README.zh.md)——产生注册表所存贡献的包。
- [Typert 协议](../protocol/README.zh.md)——注册表所服务的描述符、编解码器与提供方约定。
- [Typert 子系统参考](../../../docs/subsystems/typert.zh.md)——字面的 `ctx.typert` 约定。
- [API Gateway 参考](../../../docs/api-gateway.zh.md)——调用描述符与提供方的主要消费方。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该运行时类型注册表的消费方（cordis_inspect、wire faces、门禁）拥有注册表内容的任何模型可见投影。

#### KV Cache 影响

无直接影响；把反射或 schema 放入请求的消费方负责由此产生的前缀变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明注册表存储与拒绝什么；它们是当前包约束，不是任务积压。

- **不合并图**——注册表按 face 存储生成的反射，但不合并宿主侧与客户端侧的图，也不解析 TypeScript 引用；这些是分析器与生成器的事。
- **schema 键不含 face**——宿主侧与客户端侧在不同上下文中运行，因此在同一上下文中注册来自两个 face 的同名 schema 会被作为重复项拒绝。
- **JSON Schema 投影不缓存**——`toJSONSchema()` 每次调用都返回全新文档；需要重复投影的消费方自行负责缓存。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
