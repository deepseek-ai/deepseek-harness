# Agent Note: 编译器无关的 Typert 类型模型

Status: implemented

[English](2026-07-27-compiler-independent-typert-model.md) | 中文

## Problem

直接从 TypeScript AST 拼接 Zod 和反射文本，会把类型分析、业务语义识别与单个生成目标绑在一起。这样的生成器只能回答“这段语法能否生成”，无法提供包、face、公开导出、service、event、对象及其类型关系的标准表示，也无法供静态检查和后续生成目标复用。

host 与 client 属于独立 TypeScript project；把两者放进同一个 `ts.Program` 会合并冲突的 Cordis `Context` 与 `Events` 声明。与此同时，client 类型仍需显式引用 host 类型，因此完全隔离或在两边复制类型都不能表达真实依赖。

## Decision

[`dsh-typert-generator`](../../../../packages/typert/generator/README.zh.md) 分别从 host 和 client project 建立 `ts.Program`，只把 compiler node、symbol 和 checker 当作提取工具。分析结束后，所有生成器和扫描器只消费 Typert 自有的 `WorkspaceModel`、`FaceModel` 与 `TypeGraph`，模型中不保留 AST 或 checker 对象。生成器不依赖 `@deepseek-ai/dsh-typert-registry`。

TypeGraph 保存开发者写下的计算前类型结构，包括泛型参数与应用、显式继承、conditional、mapped、递归引用和 JSDoc。无法无损表示的可达类型使分析失败；某个 emitter 无法处理已经建模的节点时由该 emitter 失败，而不是把类型展平或降级为 `unknown`。

每个 face 独立拥有 PackageModel 和 TypeGraph。`tsconfig.host.json` 与 `tsconfig.client.json` 的直接 project references 决定 package 的 face 归属，`package.json#exports` 决定公开边界。跨 face 关系只来自源码中的显式 import 或 re-export，并作为独立 link 保留；外部 npm 类型记录为 External，不读取或复制其声明。

PackageModel 识别 Cordis service、event、`@typert object` 引用对象和 `@typert schema` 数据根。service 与 object 只暴露 public instance member，排除 constructor、static、private 和 protected；继承边保留在 TypeGraph 中，不复制为扁平成员。缺少 public property、parameter 或 return 类型标注时，`check` 模式报错，`write` 模式写入 checker 推断结果后重建 project 并再次以严格模式分析。

[`dsh-typert-registry`](../../../../packages/typert/registry/README.zh.md) 提供 `ctx.typert`，且只负责运行时注册：一个 contribution 原子携带 package-face reflection 与可选 Zod schema factory，并随 Cordis effect 撤销。注册表校验 factory 时不会调用它；首次 `get()`、`resolve()`、`list()` 或 JSON Schema 投影才会物化并缓存各 schema。注册表不分析 TypeScript，也不合并两个 face。

包产物发布仍通过 package exports 采用显式 opt-in。`WorkspaceTypertGenerator` 仅在被调用时校验所请求 face 的根目录产物协议：host face 必须通过面向用户的 subpath `package/typert` 暴露 `package/lib/typert.host.{js,d.ts}`，client face 必须通过 `package/client/typert` 暴露 `package/lib/typert.client.{js,d.ts}`；它不会修改这些 exports。后续的 [Typert Remote 设计](2026-08-02-typert-remote-method-calls.zh.md) 为根目录 build、typecheck、lint 与文档类型检查增加了全仓 Host 约定 pass。对于已 opt-in 的 Host 包，该 pass 会在消费方解析两者之前生成本地反射产物与严格的 Host-for-Client `/remote` 约定。生成的本地声明将 `TYPERT` 类型保持为 `unknown`，因此业务包不依赖注册表。

构建期的 `CordisCatalogProjector` 一次消费分析后的 `FaceModel` 与 `TypeGraph`，生成 `docs/cordis-catalog/events.md`、`docs/cordis-catalog/services.md`，以及为 `tool-cordis` 提交的静态 `SERVICE_API`、`EVENT_API` 和 `TYPE_API` catalog。`tool-cordis` 读取该静态 catalog，运行时不依赖 `ctx.typert`。[`dsh-typert-loader`](../../../../packages/typert/loader/README.zh.md) 与注册表仍是独立的运行时路径：loader 监听 Cordis Loader 配置项生命周期事件，导入显式发布的 `./typert` host 产物，并通过 `ctx.typert` 注册；两者都不是当前 `cordis_inspect` catalog 的数据源。

## Verification contract

提交内的小型双 face project 对完整类型模型及其源码声明索引做 snapshot。全仓分批分析与直接聚焦分析必须为相同 face 生成模型等价的 `FaceModel` 与 `TypeGraph`。类型级全集和运行时集合比较保证每种 node、target、declaration 与 member discriminant 都来自真实 TypeScript syntax；字段语义矩阵覆盖所有 keyword、type operator、literal value 类目，以及泛型、参数、tuple、mapped modifier、import attributes、abstract、predicate 和 enum initializer 的各个状态。

`SyntaxZoo` 中每个 property 的源码类型经 TypeScript printer 标准化后，必须与 TypeGraph 渲染结果逐项相等，随后所有渲染 declaration 再交给 TypeScript 编译。这一层检查节点内部信息是否无损，包括无插值 template literal、带 type argument 的 type query 和受约束 `infer`，不以 discriminant 覆盖或代码覆盖率代替结构等价。

边界用例固定同 face 与跨 face 的显式包导入、跨 face 命名 re-export、精确 export alias、qualified `import()` link 和全局 `@types` External 归属，并拒绝 package 自有 TypeScript 诊断、相对路径越界、`package.json#exports` 之外的引用，以及尚无模型 target 的跨 face namespace re-export。interface declaration merging 显式保留每个 authored part，无法无损表示的其他 merge 失败。

Zod emitter 对支持的节点和各类 literal 逐类执行成功与失败 parse，对不支持的节点逐类断言明确的 `TypertEmitError`。Emitter fixture 对生成的 Zod JavaScript 与 `.d.ts` 文本做快照，执行每个 schema factory，并对声明做类型检查。`dsh-typert-registry` 测试固定原子注册、首次使用物化、成功结果缓存、factory 失败后重试、查询、JSON Schema 和 effect 撤销，`dsh-typert-loader` 测试还证明延迟挂载、卸载及未完成 dynamic import 的释放行为。真实 `dsh-tools` 纵切从模型生成 contribution，经运行时注册表加载后，将其服务、事件与关联类型记录同已提交的静态 `SERVICE_API`、`EVENT_API` 和 `TYPE_API` 对照。全仓 projector 测试重新生成两份 Cordis catalog 文档与 `tool-cordis` API catalog，并要求三份文本同已提交产物逐字节一致。

## Alternatives considered

**直接保存 TypeScript AST。** AST 能保留源码写法，但会让每个消费者依赖 compiler 生命周期、node identity 和 checker 上下文，无法形成稳定的架构边界，因此只在提取阶段使用。

**基于 checker 的最终类型生成。** 展平后的 `ts.Type` 便于直接遍历，却丢失泛型、conditional、mapped 和 alias application 的开发者表达，无法满足反射与后续生成需要。

**合并 host/client project 或复制 host 类型。** 合并会污染 Cordis declaration merging；复制会产生第二份类型事实源。独立 face 加显式 cross-face link 保留了 project 隔离与真实引用关系。

**让 `dsh-typert-registry` 承担类型解析和跨包合成。** 这会把 TypeScript compiler、Cordis 生命周期和具体 schema 策略重新耦合。注册表保持为生成 artifact 的生命周期容器，复杂分析留在构建期模型。

## Consequences

新增生成目标或静态检查可复用同一 TypeGraph，业务类目也可在 PackageModel 上扩展，而无需再次解析 AST。保留计算前类型和独立 face 的代价是模型比打平后的 schema 更复杂，emitter 必须显式声明支持范围并对缺失能力失败。

包级显式 opt-in 使产物发布与 exports 由各包自行管理。仓库编排仍可为每个已 opt-in 的包运行全仓 Host 约定 pass；该 pass 仍由后续 Remote Gateway Agent Note 负责说明。静态 Cordis catalog 可从标准模型复现，同时不把 `tool-cordis` 与运行时注册表状态耦合。`ctx.typert` 只反映当前运行时中已挂载的产物；对于消费方物化后仍持有的 Zod 实例，卸载流程无法控制。
