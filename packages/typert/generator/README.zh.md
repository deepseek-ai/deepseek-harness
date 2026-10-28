---
description: "构建时 Typert 生成器：源代码类型分析、与编译器无关的模型与产物生成，供接入 Typert 发布或消费生成产物的维护者阅读。"
kind: "package-library"
---

# @deepseek-ai/dsh-typert-generator

[English](README.md) | 中文

## 概述

`dsh-typert-generator` 让维护者把公开的 TypeScript 类型转换为构建产物和与编译器无关的模型。包通过 `./typert` 和可选的 `./client/typert` 导出选择加入；如果声明、发布清单、Remote 导出或 Zod 投影无法被正确表示，生成过程就会失败。仓库构建会生成可执行 schema factory 与配套声明，工具也可以调用 `WorkspaceAnalyzer` 完成检查或目录生成而不发布产物。生成过程只在构建时运行，绝不会进入实时 agent（智能体）会话。

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

<a id="ordinary-remote-metadata"></a>
### 普通 Remote 元数据

发射器为每个端点写入一份静态 `TypertRemoteMethodSpec`，并将 spec 和产物自身导入的 Zod 运行时传给纯 `createTypertRemoteInfo` factory。普通消费方 `./remote` 产物保留默认导出和 `TYPERT_REMOTE`，其类型为 `TypertRemoteInfo`，`TYPERT_REMOTE.methods` 中的条目具有精确的 `TypertRemoteMethod<Input, Output, Mode, Uplink, DecodedOutput>` 类型。每个条目就是 `TYPERT_REMOTE.descriptors` 中同一个直接方法描述符对象；仅使用 Context 接收器的方法保留在描述符和作用域声明中。不存在独立的 `REMOTE_METHODS` 导出、嵌套 `metadata` 或第二份 `output` codec。[协议](<../protocol/README.zh.md>)负责 factory 和方法 API。

factory 返回类实例，并保留 spec，直到 `descriptors` 或 `methods` getter 构建两者共享的索引。消费方选择的每种输入策略视图、解析器和投影都独立惰性求值并缓存，生成的独立 Zod factory 同样在首次使用时物化并缓存。普通 Host `./typert` 创建私有 info 实例，由 `TYPERT.invocations` getter 暴露其描述符。Host 与消费方产物共享定义，不承诺跨 Program 或进程的对象身份。

生成的声明对拥有者类型和 schema 类型使用仅类型导入。导入元数据既不会激活 Host Service，也不会打开网络连接。框架内消费方查询现有[注册表](<../registry/README.zh.md>)；独立消费方可以直接导入 `./remote`。要求严格校验的源码组合预先构建普通产物，并通过 [loader](<../loader/README.zh.md>) 注册 `./typert`；无描述符的源码发现无法恢复已擦除的类型约束、文档或 schema。

缺少 JSDoc 或不支持工具 JSON Schema，不会阻止其他方面有效的普通生成及其严格 codec。元数据独立于投影保留解析器与可用文档：每个不受支持的输入变体或输出投影都省略 `jsonSchema`，并记录各自的 `jsonSchemaError`。工具消费方显式选择方法，并要求其所需文档和受支持的输入 schema；输出解析器是必需的，但输出 JSON Schema 是可选的，除非该消费方要求提供。仅有元数据不会让每个 Remote 方法自动成为工具。

每个生成参数 spec 都包含从同一个 checker 解析后类型模型派生的 `codec` 和 `strictCodec`；分析器与模型不携带逐方法输入策略。`method.input()` 与 `{ strict: false }` 选择 Host 分发使用的普通 codec，其已声明对象接受并剥离未知字段。`method.input({ strict: true })` 为解析和受支持的 JSON Schema 选择递归关闭的已声明对象。两种具名参数封装都拒绝额外参数；显式 JSON 与字典键保持开放，具名字典字段也须满足索引值类型的约束。严格解析先展开具名字段与索引值的联合分支，再合并并关闭每个受支持的对象组合，包括可选字段和可空索引值。`result` 保留唯一的普通 codec。工具投影的目标是 [`@deepseek-ai/dsh-tools`](../../core/tools/src/json-schema.ts) 对工具参数、工具输出和生成的 PTC SDK 强制执行的 tool-schema 子集；它支持标量、对象、数组和互斥联合类型，规范的 `JsonValue` 与字符串键 JSON 字典无需递归引用。子集之外的类型会被报告，而不是以更弱的 schema 投影。TypeScript 未表达的数值范围与其他语义规则仍由操作拥有者负责。

`WorkspaceTypertGenerator` 先分析每个选中 face 的所有贡献方，再筛选要生成产物的包，因此包子集保留与完整构建相同的声明合并结果和输出字节。

### 静态分析工作区

静态消费方直接针对工作区的 `tsconfig.host.json` 与 `tsconfig.client.json` 聚合配置调用 `WorkspaceAnalyzer`，选择 face 与包子集，并在不生成或加载运行时产物的前提下读取生成的 `FaceModel` 与类型图。`analyzeInBatches()` 通过有界的编译器程序处理大批量包选择，模型形态保持一致；`discoverPackages()` 无需构建类型检查程序即可找出参与贡献的包，其可选的 `package.json` 谓词会在读取某个包的源码或项目配置之前就跳过该包。Typert 只解析它所分析的包的 tsconfig；校验每个被引用的 tsconfig 由包编译中的 `tsc -b` 负责。

JSON、YAML、SVG、PNG、JPEG 和 WebP 资源导出不提供 TypeScript 声明，因此不进入 API 模型。JavaScript 或 TypeScript 导出源文件缺失时仍报错。

### 在 tsdown 构建中运行生成

`./tsdown` 子路径导出 `decoratorPlugin()` 与 `typertPlugin()`。`./tsdown` 子路径导出 `decoratorPlugin()` 与 `typertPlugin()`。`decoratorPlugin()` 转换标准 TypeScript 装饰器，不读取或写入元数据。仓库构建在仅源码生成完成后使用它；需要在打包时生成元数据的消费方使用 `typertPlugin()`。

`typertPlugin()` 用于需要在打包时生成元数据的构建：它在打包前转换 TypeScript 依赖中的标准装饰器，并在包输出根目录生成模型驱动的 face 产物。其 `transform` 钩子带有模块 id 过滤器，非 TypeScript 模块不会进入 JavaScript。工作区根目录是打包输出最近的、同时包含 `tsconfig.host.json` 与 `packages/` 的祖先目录，因此包自身的 face 叶子配置永远不会被当作根目录。`package` 模式在当前包的 `writeBundle` 中同步生成，并只生成该包。

`workspace` 模式对每个显式贡献方各生成一次，且不阻塞打包：第一个包构建的 `buildStart` 在 Worker Thread 中启动生成，第一个 `writeBundle` 等待结果并写入全部产物，之后的打包立即返回。分析错误、worker 崩溃或提前退出、worker 响应格式错误，都会以指明工作区与原因的 `TypertWorkerError` 使该打包失败，从而使整个 tsdown 阶段失败；报告失败之前 worker 已被终止。

### 不经打包器生成

`writeWorkspaceArtifacts()` 与 `writePackageArtifacts()` 是插件的写盘函数：每个产物写成 `lib/typert.<face>.{js,d.ts}`，带 Remote 方法时另写 `lib/typert.remote-client.{js,d.ts,d.ts.map}`，没有 Remote 方法的 Host 产物会删除残留的 Remote client 文件。把 `WorkspaceTypertGenerator.generateContributors()` 的结果交给它们写盘，得到的字节与 `workspace` 模式插件相同；`findWorkspaceRoot()` 采用插件的工作区根目录规则。仓库中不打包的生成 [`scripts/generate-typert.ts`](../../../scripts/generate-typert.ts) 就以这种方式为产物构建与仅生成声明的构建在包编译之前生成 Host face。

设置 `rejectBuildOutputs: true` 后，若 face program 载入了工作区包 `lib/` 目录下的文件，或无法解析对工作区包的 import（例如包尚未编译的工作区），分析会以 `TypertAnalysisError` 失败。错误信息列出每个这样的 import 说明符，以及应由 `paths` 别名映射到的源文件；因此通过的生成只依赖工作区源码，可以在包编译之前或与之并行运行。若某个 face 的源码 import 生成产物（例如 Client face import `/remote`），则不要开启它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释生成器如何得到与编译器无关的模型以及它生成什么；可观察的构建行为已在[使用本包](#use-this-package)中说明。

### 设计理念

生成器遵循一项核心分离原则：提取与生成通过与编译器无关的模型解耦。`WorkspaceAnalyzer` 读取以 face aggregate tsconfig 为种子的 TypeScript 程序，产出 `FaceModel` 与 `TypeGraph` 数据；`FaceModelEmitter` 只消费该模型，绝不接收编译器节点。模型保留声明标识、泛型参数及应用、显式继承、条件类型与映射类型、导入属性、abstract 修饰符与源码 JSDoc，并排除构造函数、静态成员与非公共成员。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 公共 API：分析器、生成器、工作区生成器、渲染器、目录投影 |
| [`src/analyzer.ts`](src/analyzer.ts) | `WorkspaceAnalyzer`：face 程序、check/write 模式、分批、发现、源码索引 |
| [`src/model.ts`](src/model.ts) | 与编译器无关的模型类型 |
| [`src/emitter.ts`](src/emitter.ts) | `FaceModelEmitter`：Zod schema 与声明生成、Remote 声明 |
| [`src/workspace.ts`](src/workspace.ts) | `WorkspaceTypertGenerator`：发现、生成、导出与文件清单校验；工作区根目录查找 |
| [`src/tsdown-plugin.ts`](src/tsdown-plugin.ts) | tsdown 插件面：装饰器转换与产物生成 |
| [`src/artifact-files.ts`](src/artifact-files.ts) | 插件与不打包生成共用的包内产物写盘函数 |
| [`src/build-output-guard.ts`](src/build-output-guard.ts) | 为 `rejectBuildOutputs` 检测 face program 中的工作区 `lib/` 文件与无法解析的工作区 import |
| [`src/worker.ts`](src/worker.ts) | workspace 模式生成所用的 Worker Thread 入口 |
| [`src/cordis-catalog.ts`](src/cordis-catalog.ts) | 生成 Cordis 目录所用的目录投影 |

### 分析与 face

Host 与 Client 是两个独立的 TypeScript 程序。直接项目引用确定编译器 face 的成员归属，`dsh.client` 包子路径则确定运行时 face 的贡献；`package.json#exports` 划定所有跨包公开边界，跨 face 的边只能来自导入或重新导出。解析到本包内部模块的相对导入会沿该模块的重新导出继续追踪，直到出现包说明符，因此包内转发模块保留原始声明引用；解析到其他包的相对导入会失败。`check` 模式遇到语法或语义诊断、缺失的公开类型标注、跨包私有引用，以及模型无法无损保留的可达声明合并时都会失败；`write` 模式插入类型检查器推导出的标注，并返回无诊断的 check 模式模型。NPM 依赖拥有的类型继续以 `external` 引用表示，不会被展开。流方法的返回类型可以是 `Iterable<Out>`、`AsyncIterable<Out>` 或协议包的 `RemoteStream<Out, In>`，后者与标准库包装器一样按符号名与声明所在包识别；第二个类型参数不为 `never` 时产出描述符的上行编解码器，生成的 Client 签名则返回 `RemoteStreamHandle<Out, In>`。

### 生成与发布约定

`FaceModelEmitter` 输出包含只缓存成功结果的 Zod schema factory 与 `TYPERT` 贡献的可执行 JavaScript，以及把 factory 通过包的公开导出标注为返回 `z.ZodType<SourceType>` 的声明文件；不支持的 Zod 投影会失败。含 Remote 方法的 Host face 还会额外为 Client 生成 Host Remote 约定的 `typert.remote-client.*` 投影。`WorkspaceTypertGenerator` 校验每个贡献方的 `package.json`：`./typert` 与 `./client/typert`（存在 Remote 方法时还有 `./remote`）必须指向精确的生成文件，且 `files` 清单必须包含它们。

[一元二进制结果](../protocol/README.zh.md)在泛型类型解析后被识别。其 codec 校验字节数组类型与 JSON 元数据，不遍历、复制或冻结字节载荷；生成的 Client 声明保留原有元数据类型，并将字节的底层缓冲区收窄为 `ArrayBuffer`。

### 目录投影

运行时类型闭包索引导出的 workspace 声明和被引用的框架 enum。Vendor 声明不参与业务 API 发现；公共结果引用其中 enum 时，目录仍提供其定义。

根导出包含本仓库 Cordis 目录使用的模型驱动提取逻辑、完整性检查与确定性文本渲染器。它们接受 `CordisCatalogPolicy`；由仓库持有的类型链接、基础类型／豁免分类与继承的 Cordis 条目仍位于 `scripts/gen-cordis-catalog.ts`，由调用方显式传入，因此本包只包含投影机制，不会隐式复制仓库的文档分类体系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从生成模型逐步进入运行时与 Remote 调用路径。

- [Typert 子系统参考](../../../docs/subsystems/typert.zh.md)——生成器建模的 Remote 约定与注册表接口。
- [Typert 协议](../protocol/README.zh.md)——生成产物所扩展并消费的声明。
- [Typert 注册表](../registry/README.zh.md)——生成产物所供给的运行时存储。
- [API 网关参考](../../../docs/api-gateway.zh.md)——生成的 Remote 描述符如何端到端被调用。
- [与编译器无关的模型 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-27-compiler-independent-typert-model.zh.md)——模型设计、备选方案与后果。

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
- **严格索引对象合并存在限制**——当对象成员都是具体属性时，具名字段与索引值的联合类型会逐分支组合。递归引用、嵌套索引签名和计算成员仍使用独立 schema 的交集；严格解析可能拒绝字段来自不同交集分量的合法值。
- **没有生成的 schema 跨 face 导入**——跨 face 链接会在模型中表示以供分析，但生成的 schema 均不需要跨 face 的运行时 Zod 导入。
- **发现范围只覆盖具体公开导出**——既未导出、也未由可达图导入的声明按设计排除在包模型之外。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
