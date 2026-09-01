---
description: "生成的 Typert 产物所用的 Loader 集成：已挂载的包如何自动把宿主侧反射与 schema 贡献给运行时注册表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-typert-loader

[English](README.md) | 中文

## 概述

挂载 `dsh-typert-loader` 后，Loader 组合中每个挂载的包都会自动把其生成的 Typert 反射与 schema 贡献给运行时注册表——并在包或本插件卸载时自动撤销。没有该导出的包会被跳过，因此在任何 Loader 组合中挂载它都是安全的。显式 `packages` 用于覆盖嵌套在另一 Loader 配置项之下的插件，这些插件的 fiber 不携带可解析的包说明符。它是仅支持 Node 的插件，需要配置树解析锚点才能解析包。

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

在加载发布生成 Typert 产物的包的 Host Loader 组合中挂载本插件。注册表本身来自 `dsh-typert-registry`；本插件只负责发现与注册。

### 最小配置

加载注册表与 loader；loader 默认发现每一个 Loader 配置项：

```yaml
- name: '@deepseek-ai/dsh-typert-registry'
- name: '@deepseek-ai/dsh-typert-loader'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `packages` | `[]` | 为嵌套在另一 Loader 配置项下的插件额外注册的包产物；每个包都必须能从配置树解析，并导出 `./typert` |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-typert-loader)是每个受支持字段的穷尽式真源。

### 注册什么

每个符合条件的 Loader 配置项都会把其生成的宿主侧反射与 schema 贡献给运行时注册表。注册跟随配置项生命周期：配置项或本插件卸载时撤销；在两者都已消失后才结束的注册会被丢弃。

### 可观察行为与失败

没有该导出的包会被静默跳过。解析结论与已导入的 manifest 会在整个进程生命周期内缓存，因此新增 `./typert` 导出后必须重启。已挂载配置项对应的产物格式错误时，激活会大声失败；之后才发生的失败按包记录日志，不会阻止无关包完成注册。无法从配置树解析、或缺少该导出的显式 `packages` 条目会大声失败并指名该包。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 loader 如何扫描、校验与注册；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

本插件是一个增量扫描器，与 client-modules 的 Node 半实现对称：每次 Cordis `internal/plugin` 事件都会把该 fiber 的配置项名称标记为脏，微任务 flush 会针对实时 Loader 配置项逐一调和每个脏名称；激活阶段用所有当前配置项填充同一脏集合。

### Manifest 校验

`validateTypertManifest()` 是模块／文件边界：manifest 从构建产物进入类型化注册表，因此每个字段都会被检查。manifest 必须指名导出它的包、携带 `host` face、持有 zod v4 schema 实例，并保持服务、事件、对象、成员、类型与文档记录格式正确；调用描述符必须使用严格编解码器。每次失败都会指名包与缺陷。

### 缓存与归属

结论（可解析说明符、是否导出）与已导入的 manifest 按包名缓存且永不过期。注册按配置项名称键控，并通过 `ctx.typert.register()` 返回的同一资源释放函数撤销；进行中的任务按配置项跟踪，因此迟到的导入不可能在其所有者消失后注册贡献。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、扫描器、manifest 校验、注册接线 |
| — | 不发布运行时不变式伴生入口；Loader entry 生命周期直接持有每个准确的 registry disposer，integration test 会观察注册与移除。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从 loader 逐步进入它注册什么以及什么产生这些内容。

- [Typert 注册表](../registry/README.zh.md)——本插件所供给的服务。
- [Typert 生成器](../generator/README.zh.md)——产生 loader 所导入产物的包。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-typert-loader)——`packages` 字段声明及其 JSDoc。
- [Typert 组地图](../README.zh.md)——完整的类型反射流水线。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 loader 集成只注册生成的产物；任何模型可见投影均由消费方负责。

#### KV Cache 影响

无直接影响；注册变化只有在消费方读取注册表时才会触及请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 loader 不会发现或注册什么；它们是当前包约束，不是任务积压。

- **仅宿主侧**——发现机制只会导入宿主侧 `./typert` 产物；在为客户端运行时添加等价的发现机制之前，需要先有独立的组合所有者。
- **嵌套插件需要显式条目**——Loader 配置项会被自动发现，但嵌套在另一配置项之下、或完全不经 Loader 加载的插件，需要显式加入 `packages`，或由其所有者直接调用 `ctx.typert.register()`。
- **缓存结论永不过期**——进程中途新增 `./typert` 导出的包需要重启后 loader 才会注册它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
