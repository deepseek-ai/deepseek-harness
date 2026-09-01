---
description: "构建时 Typert 生成器：源代码类型分析、与编译器无关的模型与产物生成，供接入 Typert 发布或消费生成产物的维护者阅读。"
kind: "package-library"
---

# @deepseek-ai/dsh-typert-generator

[English](README.md) | 中文

## 概述

`dsh-typert-generator` 在构建时把源代码 TypeScript 转换为与编译器无关的数据与可运行产物：它分析工作区各包的类型树，生成 `FaceModel` 与类型图，并输出包含受支持 Zod schema 与 `TYPERT` 反射贡献的可执行 JavaScript，以及配套声明文件。它是构建时库而非插件——绝不会在实时 agent 会话中运行。仓库的 Host tsdown 会自动运行它；业务包通过导出 `./typert` 与 `./client/typert` 入口选择加入，生成器会校验这些导出与发布文件清单。静态消费方也可以直接调用分析器进行类型检查或目录生成，无需发布任何内容。

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

本包供把 Typert 生成接入构建或消费生成产物的包维护者与仓库维护者使用。发布是选择加入的：声明导出入口、运行构建，产物即出现在 `lib/` 中；静态分析则不需要产物。

### 从包中发布 Typert 产物

参与贡献的包在 `package.json` 中声明宿主侧产物导出；同时贡献两侧的包还要声明 `./client/typert`，含 Remote 方法的包还要声明 `./remote`：

```yaml
exports:
  "./typert":
    types: "./lib/typert.host.d.ts"
    default: "./lib/typert.host.js"
files:
  - "lib/typert.host.js"
  - "lib/typert.host.d.ts"
```

构建完成后，`lib/typert.host.js` 与 `lib/typert.host.d.ts` 即存在，[loader](../loader/README.zh.md) 会在 Loader 组合中注册该贡献。生成的声明文件把 `TYPERT` 暴露为 `unknown`，因此参与贡献的包永远不会依赖运行时注册表。当声明缺失、指向错误文件，或在没有 Remote 方法的情况下发布 Remote 产物时，生成器会使构建失败；不支持的 Zod 投影会以 `TypertEmitError` 指明具体构造并失败，而不会展平或弱化源类型。

### 静态分析工作区

静态消费方直接以工作区的 `tsconfig.host.json` 与 `tsconfig.client.json` aggregate 调用 `WorkspaceAnalyzer`，选择 face 与包子集，并在不生成或加载运行时产物的前提下读取生成的 `FaceModel` 与类型图。`analyzeInBatches()` 通过有界的编译器程序处理大批量包选择，模型形态保持一致；`discoverPackages()` 无需构建类型检查程序即可找出参与贡献的包。

### 在 tsdown 构建中运行生成

包的 `./tsdown` 子路径为根 tsdown 配置提供 `typertPlugin()`：它在打包前降低 TypeScript 依赖中的标准装饰器，并在包输出根目录生成模型驱动的 face 产物。`package` 模式只生成当前打包的包；`workspace` 模式对每个显式贡献方各生成一次。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释生成器如何得到与编译器无关的模型以及它生成什么；可观察的构建行为已在[使用本包](#use-this-package)中说明。

### 设计理念

生成器建立在一个分离之上：提取与生成通过与编译器无关的模型解耦。`WorkspaceAnalyzer` 读取以 face aggregate tsconfig 为种子的 TypeScript 程序，产出 `FaceModel` 与 `TypeGraph` 数据；`FaceModelEmitter` 只消费该模型，绝不接收编译器节点。模型保留声明标识、泛型参数及应用、显式继承、条件类型与映射类型、导入属性、abstract 修饰符与源码 JSDoc，并排除构造函数、静态成员与非公共成员。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 公共 API：分析器、生成器、工作区生成器、渲染器、目录投影 |
| [`src/analyzer.ts`](src/analyzer.ts) | `WorkspaceAnalyzer`：face 程序、check/write 模式、分批、发现、源码索引 |
| [`src/model.ts`](src/model.ts) | 与编译器无关的模型类型 |
| [`src/emitter.ts`](src/emitter.ts) | `FaceModelEmitter`：Zod schema 与声明生成、Remote 声明 |
| [`src/workspace.ts`](src/workspace.ts) | `WorkspaceTypertGenerator`：发现、生成、导出与文件清单校验 |
| [`src/tsdown-plugin.ts`](src/tsdown-plugin.ts) | tsdown 插件面：装饰器降低与产物生成 |
| [`src/cordis-catalog.ts`](src/cordis-catalog.ts) | 生成 Cordis 目录所用的目录投影 |

### 分析与 face

Host 与 Client 是两个独立的 TypeScript 程序。直接项目引用确定编译器 face 的成员归属，`dsh.client` 包子路径则确定运行时 face 的贡献；`package.json#exports` 划定所有跨包公开边界，跨 face 的边只能来自导入或重新导出。`check` 模式遇到语法或语义诊断、缺失的公开类型标注、跨包私有引用，以及模型无法无损保留的可达声明合并时都会失败；`write` 模式插入类型检查器推导出的标注，并返回无诊断的 check 模式模型。NPM 依赖拥有的类型继续以 `external` 引用表示，不会被展开。

### 生成与发布约定

`FaceModelEmitter` 输出包含受支持 Zod schema 与 `TYPERT` 贡献的可执行 JavaScript，以及把 schema 通过包的公开导出标注为 `z.ZodType<SourceType>` 的声明文件；不支持的 Zod 投影会失败。含 Remote 方法的 Host face 还会额外为 Client 生成 Host Remote 约定的 `typert.remote-client.*` 投影。`WorkspaceTypertGenerator` 校验每个贡献方的 `package.json`：`./typert` 与 `./client/typert`（存在 Remote 方法时还有 `./remote`）必须指向精确的生成文件，且 `files` 清单必须包含它们。

### 目录投影

根导出包含本仓库 Cordis 目录使用的模型驱动提取逻辑、完整性检查与确定性文本渲染器。它们接受 `CordisCatalogPolicy`；由仓库持有的类型链接、基础类型／豁免分类与继承的 Cordis 条目仍位于 `scripts/gen-cordis-catalog.ts`，由调用方显式传入，因此本包只包含投影机制，不会隐式复制仓库的文档分类体系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从生成模型逐步进入运行时与 Remote 调用路径。

- [Typert 子系统参考](../../../docs/subsystems/typert.zh.md)——生成器建模的 Remote 约定与注册表接口。
- [Typert 协议](../protocol/README.zh.md)——生成产物所扩展并消费的声明。
- [Typert 注册表](../registry/README.zh.md)——生成产物所供给的运行时存储。
- [API Gateway 参考](../../../docs/api-gateway.zh.md)——生成的 Remote 描述符如何端到端被调用。
- [Compiler-independent model Agent Note](../../../.agents/notes/implemented/architecture/2026-07-27-compiler-independent-typert-model.zh.md)——模型设计、备选方案与后果。

-----

<a id="model-experience"></a>
## 模型体验

无，因为构建时生成器在任何 agent 运行时之外运行，不触及任何模型请求。

#### KV Cache 影响

无直接影响；生成产物只有在消费方将其放入请求时才会触及请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明生成器无法建模或生成的构造；它们是当前包约束，不是任务积压。

- **包导出模式会被跳过**——参与贡献的包需要具体的导出目标；通配符导出模式不会被分析。
- **跨 face 的命名空间重新导出会失败**——具名与星号重新导出会生成链接，但在 `TypeTargetModel` 能够不经展平表示模块命名空间之前，命名空间重新导出无法表示。
- **Zod 生成器只支持有意限定的子集**——泛型 schema 声明，以及以条件类型或映射类型为 schema 根的计算构造，都会失败，直到存在明确的 schema 工厂策略。
- **没有生成的 schema 跨 face 导入**——跨 face 链接会在模型中表示以供分析，但生成的 schema 均不需要跨 face 的运行时 Zod 导入。
- **发现范围只覆盖具体公开导出**——既未导出、也未由可达图导入的声明按设计排除在包模型之外。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是运行于 Cordis 之外的源码分析器与构建时 emitter；model snapshot、可执行 artifact 与消费包 typecheck 强制其输出约定。
