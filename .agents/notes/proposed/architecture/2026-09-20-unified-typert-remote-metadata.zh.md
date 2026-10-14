# Agent Note: 统一 Typert/Remote 元数据

Status: proposed

[English](2026-09-20-unified-typert-remote-metadata.md) | 中文

## Problem

CLI 帮助、参数解析和 MCP 工具发现需要在连接受控 Host 前取得本地方法说明、具名输入解析器、工具 JSON Schema 和结果元数据。Browser、Node 与独立消费方还需要类型化调用。工具消费方需要更严格的输入对象校验，但不能改变普通 Host 分发。这些需求不意味着运行时 TypeScript 分析、Host Service 激活，或每个消费方另行维护业务 schema。

#4644 原有的源码定义决策通过 `emitSourceDef`、提交的生成文件和 `./remote-source` 交付这些信息；Host 绑定携带定义，源码生成另有清单、新鲜度、发布和排除规则。本 note 替代该交付机制，并将输入严格性改为由消费方选择。

两种交付路径均来自同一个[编译器无关模型](../../implemented/architecture/2026-07-27-compiler-independent-typert-model.zh.md)。独立的 Host 与 Client Program 要求生成跨编译面声明，而非提交生成源码。需要精确 schema 时，显式预构建是可接受的；普通 ESM 产物无需运行中的 Host 即可提供离线元数据。[定向调用决策](../../implemented/architecture/2026-08-02-typert-remote-method-calls.zh.md)仍负责接收者查找、Gateway 分发和贡献生命周期。

## 技术架构

| 导出 | 职责 | 注册方式 |
|---|---|---|
| Host `./typert` | `TYPERT`：本地反射、schema，以及暴露私有 info 实例描述符的 `invocations` getter。 | Loader 导入并验证 contribution，再调用 `ctx.typert.register(TYPERT)`。 |
| 面向消费方的 Host `./remote` | 默认导出和 `TYPERT_REMOTE`：带有描述符和类型化 `methods` 的 `TypertRemoteInfo`，以及生成的 Remote 声明/映射。 | Harness 元数据消费方调用 `ctx.typert.remotes.register(TYPERT_REMOTE)`；实际调用方使用 `ctx.remote.$mount(TYPERT_REMOTE)`，它已经包含注册。独立读取方无需 Registry。 |
| Client `./client/typert` | Client 编译面自己的本地反射与 schema。 | 本地 Registry；这不是 Host Remote 投影。 |

[Registry](../../../../packages/typert/registry/src/service.ts) 实例属于各自的 Cordis Context 和进程。Host 与 Client 入口共享实现，而非状态。既有本地/Remote `get()` 与 `list()` 保留已注册的描述符对象；注册保留原子重复检查、通知、tombstone 和 fiber 管理的释放。不新增 Registry API、存储、订阅、元数据 RPC 或跨进程同步。独立 Program 和进程不共享对象身份。

[发射器](../../../../packages/typert/generator/src/emitter.ts)为每个端点写入一份静态 `TypertRemoteMethodSpec`，并调用已发布纯入口 `@deepseek-ai/dsh-typert-protocol/remote-info` 提供的 `createTypertRemoteInfo({ package, methods }, z)`。端点键提供 `namespace` 和 `method`，`id` 由包名与端点键组合。每份 spec 保留 service、接收者、有序参数、唯一的 `result` codec，以及可选的流模式、scope、uplink、取消、文档和源码位置字段。每个参数都有从同一 checker 解析后类型模型派生的 `codec` 和 `strictCodec`，分析器与模型不携带逐方法策略。参数 `wire` 默认使用 `name`；参数文档保留在 `parameters[].description`。不存在嵌套 `metadata`、独立 `output` 或 `parameterDescriptions`，也不导出顶层 `REMOTE_METHODS`。

[factory](../../../../packages/typert/protocol/src/remote-info.ts)返回真正的类实例，而非类构造函数或立即求值的对象字面量。构造时只保留 spec 和生成产物显式传入的 Zod 运行时，不构造 schema。首次读取 `descriptors` 或 `methods` 时（包括挂载或查询时）才构建并缓存一个共享索引。每个 `methods[endpoint]` 就是同一个直接方法描述符对象；仅使用 Context 接收者的方法保留在描述符和作用域声明中。带作用域投影的直接方法保留 scope 字段，但其通用具名调用器要求无作用域 Remote。

直接方法的 `input(options?: TypertRemoteInputOptions)` 返回缓存的 `TypertRemoteValue<Input>`；唯一选项是 `strict?: boolean`。`method.input()` 与 `{ strict: false }` 使用普通 codec：已声明对象接受并剥离未知字段。`{ strict: true }` 递归拒绝未声明字段。两种具名参数封装都拒绝额外参数；显式 JSON 与字典键保持开放，有约束的字典值仍然校验。消费方选择一个视图，通过 `input.create().parse(raw)` 与 `input.jsonSchema` 取得匹配的解析和投影。Host 分发与唯一的 `result` codec 保留普通行为，包括二进制 `encode`/`decode`。

每种输入策略的视图、具名解析器及 JSON Schema 投影都独立惰性求值并缓存。生成的独立 Zod factory 同样惰性求值且只缓存成功结果。原始 spec 内部要求 Zod factory，而面向消费方的 `TypertSchema<T>` 只承诺 `parse(value: unknown): T`。JSON Schema 仍是可选的生成器投影，而非运行时 `z.toJSONSchema()` 转换。生成产物导入并传入 Zod，包括没有参数或导出 schema的 Remote 端点。纯叶入口只保留 Zod 类型导入，没有运行时模块依赖；协议根入口重新导出 factory 并导入 Cordis，但不会因此将 Zod 加入所有协议消费方的静态模块图。导入和元数据/schema 读取绝不发起网络调用。

Registry 查询返回基础描述符。纯叶入口或协议根入口的 `isTypertRemoteMethod(descriptor)` 以 `object`/`unknown` 类型收窄直接调用能力；精确端点类型来自 `TYPERT_REMOTE.methods`，而非动态查询。一元 `mode` 省略；流式 `mode` 为 `'stream'`。`invoke(remote, input, signal?)` 在调用时解析已挂载的命名空间方法，保留其 `this`、可选位置参数空位和 signal。它不使用 async 包装，直接转发同一个完整 `Promise<RemoteResult<DecodedOutput>>` 或 `RemoteStreamHandle<Output, Uplink>`；流迭代、`send`、`end` 和 `dispose` 均保留。`TypertRemoteMethod` 的第五个泛型参数独立于结果解析器的原始输出，保留载体解码后的一元字节类型。

文档和 JSON Schema 可选。每个不受支持的输入变体或结果投影记录各自的 `jsonSchemaError`，同时保留解析器及独立文档；只捕获专用投影错误。显式选择工具的消费方要求工具说明和受支持的输入 JSON Schema。即使缺少可选输出 JSON Schema，输出解析仍然必需。原生 `dsh-tools` 注册额外要求 `output.schema`：仅有解析器并不满足要求。这些消费方要求不得阻止本来有效的 Remote 方法生成。

## Proposal

在下游 Session-client、CLI、MCP 和原生工具包中完成普通产物迁移。本 note 保持 proposed，因为该迁移尚未完成。

### 共享生成，两种访问方式

框架消费方将普通元数据加载到自己的 Registry。独立消费方可以直接导入 `./remote`，无需 Cordis、Host Service 激活或连接。两者读取同一份生成业务定义。保留独立的 Host/Client Program，并分析每个编译面的所有贡献方，使局部生成保留外部声明合并。注册不会将每个反射方法都暴露为可调用 endpoint 或工具。

严格源码启动显式预构建，并通过 Loader 加载普通 `./typert`。有限的无 descriptor fallback 仍支持基本参数、signal、取消、流式调用、JSON 转换和一元字节附件，但无法恢复被擦除的字段、约束或工具文档。一旦观察到严格的本地 descriptor，撤销后必须拒绝调用，而不是降级到 fallback。`@Remote` 只接受 `name` 和 `mode`；消费方选择输入策略，无需另加开发者注解。

Host 元数据就绪仍由组合负责。要求严格校验的 Host 必须等待本地注册完成后再接受调用；`hasSeen()` 不会保护首次注册之前的端点。返回惰性 info 实例既不完成异步 Loader 发现，也不建立就绪保证。Loader 校验静态 codec spec 及可调用的 `input`/`invoke`，注册贡献时不调用选择器、解析器 factory 或投影。

### 下游迁移目标

已检查的 #4111 树包含 Session-client、CLI、MCP 和原生工具消费方，当前分支并不包含这些完整 package。其 Session client 从源码导出选择 13 个 Session 方法及 Workspace 列举。迁移该树需要一并更新选择、连接时挂载、离线 CLI 初始化、MCP 呈现及原生工具注册；仅删除源码导出并不足够。

| 消费方 | 元数据适配 | 保留的执行方式 |
|---|---|---|
| Browser / Node Remote 调用方 | 导入普通 `./remote`；在实际调用 Context 中挂载一次。 | 生成 namespace、Gateway、认证 Connection 和目标 controller。 |
| 离线 CLI 帮助 / 解析 | 在 CLI profile 的元数据 Context 中，于目标发现之前注册；选择 `input({ strict: true })`。 | 帮助不连接；调用时由独立的实际调用 Context 挂载。 |
| MCP 发现 / 调用 | 读取选中的 Registry 条目并选择 `input({ strict: true })`；保留消费方自有工具说明和 envelope。 | `tools/list` 离线；`tools/call` 使用相同 Session client。外部 MCP 客户端收到协议 JSON，而不是 Registry 模块。 |
| 原生工具 | 读取 Host 本地方法信息；要求工具注册的 `output.schema`。 | 在工具边界解析，然后直接调用同进程 controller。 |
| 独立适配器 | 直接读取类型化 `TYPERT_REMOTE.methods`。 | 仅调用时使用其选择的 Remote 运行时。 |

当前 Session 选择和附件准备仍由消费方拥有；CLI/MCP 输入接收使用选择时的同一严格输入视图验证补全后的业务参数。下游 `follow` 适配器的 `activate: false` 策略只适用于具有该 API 的版本；当前分支的 `follow` 没有此选项。中止观察不等于取消已接受的 Session 工作。

### 新旧接入示例

旧示例是依赖改动中源码导出消费方的历史对照。新示例使用普通产物。这些片段省略外围插件声明，且包含已移除的 API。`raw`、`request`、`signal` 和已认证、已挂载、无作用域的 `remote` 是调用方输入，不是新增框架 API。

**操作拥有者与严格 Host。** 保留业务签名；将生成定义注册交给普通 Typert Loader，而非 Service 构造函数。

```text
// Old source delivery.
import { TYPERT_REMOTE } from './remote.generated.ts'
// Constructor: super(ctx, 'sessionController', { namespace: 'session', definitions: TYPERT_REMOTE })
@Remote({ name: 'page', emitSourceDef: true, rejectUnknownFields: true })
page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
  return this.history.page(request, signal)
}

// Ordinary delivery; no generated-source import or constructor definitions.
// Constructor: super(ctx, 'sessionController', { namespace: 'session' })
@Remote({ name: 'page' })
page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
  return this.history.page(request, signal)
}
```

**Browser 与 Node 调用。** 源码导出消费方将 `/remote-source` 改为 `/remote`；已有普通消费方本来就使用此路径。实际调用 Context 挂载一次，不额外向 Registry 注册。

```text
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote'
await ctx.remote.$mount(TYPERT_REMOTE)
const result = await ctx.remote.session.page(request, signal)
const stream = ctx.remote.session.follow(followRequest, signal)
try {
  for await (const frame of stream) consume(frame)
} finally {
  await stream.dispose()
}
```

**离线 CLI 与框架元数据。** 旧选择读取源码方法表；替代方式在目标发现之前读取 profile 拥有的 Registry。两个片段是不同选择，不是同时声明。

```text
// Old selection.
import { REMOTE_METHODS } from '@deepseek-ai/dsh-api-session-controller/remote-source'
const page = REMOTE_METHODS['session/page']
```

```text
// Metadata plugin: inject: ['typert']; no Gateway, Connection, or Host controller.
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote'
import { isTypertRemoteMethod } from '@deepseek-ai/dsh-typert-protocol/remote-info'
ctx.typert.remotes.register(TYPERT_REMOTE)
const page = ctx.typert.remotes.get('session/page')
if (page === undefined || !isTypertRemoteMethod(page)) {
  throw new Error('session/page generated direct method is not loaded')
}
```

注册属于该插件的 fiber。帮助使用 `description` 和 `input({ strict: true })`；类型化 facade 可以保留对普通生成声明的 type-only 导入。显式工具选择不修改已注册元数据。

**CLI 输入与分发。** 本地 `current` 解析和附件准备之后，两种元数据访问方式使用同样的调用步骤：

```text
if (page.mode === 'stream') throw new Error('session/page must be unary')
const input = page.input({ strict: true })
const arguments_ = input.create().parse(raw)
const result = await page.invoke(remote, arguments_, signal)
if (!result.ok) throw result.error
const output = page.result.create().parse(result.value)
```

**MCP 发现与调用。** 选择时验证工具特有要求；生成过程本身不要求它们。

```text
const input = page.input({ strict: true })
if (!page.description) throw new Error('session/page has no tool description')
if (input.jsonSchema === undefined) throw new Error('session/page has no supported tool input schema')
const tool = {
  name: 'remote_session_page',
  description: page.description,
  inputSchema: input.jsonSchema,
  ...(page.result.jsonSchema === undefined ? {} : { outputSchema: page.result.jsonSchema }),
}
```

这个简化对象只展示元数据依赖。真实 MCP 适配器保留 `{ arguments, current, content }` 输入及 `{ ok, value }` / 失败输出 envelope。列举无需连接；调用执行输入接收、本地准备、通过 `input.create()` 解析、调用及输出解析。可选输出投影不会移除输出验证。

**原生工具。** 查询 `ctx.typert.local.get('session/page')`，并用 `isTypertRemoteMethod` 收窄，而非读取源码方法表。原生工具可以选择 `method.input({ strict: true })`，取得匹配的解析与输入投影。原生注册仍要求受支持的输入与结果投影，包括 core Tool 必需的 `output.schema`；MCP 的可选输出投影在这里并不足够。facade 取得类型化请求后，两种设计执行同样的本地调用：

```text
const value = await ctx.sessionController.page(request, signal)
```

**独立消费方。** 读取普通 info 实例的类型化索引，不要求 Registry：

```text
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote'
const page = TYPERT_REMOTE.methods['session/page']
const arguments_ = page.input().create().parse(raw)
const result = await page.invoke(remote, arguments_, signal)
```

**严格源码启动。** 构建普通产物，再使用受支持的源码启动器：

```sh
pnpm run build
pnpm dsh --profile <profile-name> <profile-arguments>
```

## Alternatives considered

- **提交源码：** 满足离线需求，但增加冗余交付和维护路径；显式普通预构建已经足够。
- **嵌套描述符元数据与独立方法表：** 重复结果和参数事实，并增加需要跟踪的对象身份。一份 spec 直接在描述符上派生调用辅助能力；`TypertRemoteInfo` 扩展既有 contribution 并保留 `descriptors`，让 Gateway 与 Registry 沿用现有注册 API。
- **所有导入方强制使用 Registry：** 为独立消费方增加生命周期要求，却不增加信息。
- **仅用 fallback：** 无法提供被擦除的验证或工具文档；仅为受支持子集保留。
- **手写适配器 schema 或运行时 TypeScript 分析：** 重复承担所有权，或引入构建期提取已解决的运行时编译器要求。

## Acceptance criteria

- 普通产物为每个端点生成一份静态方法 spec，并返回惰性类实例；直接方法索引引用描述符对象，保留完整流式/二进制类型、独立编译面及完整编译面的声明合并。
- 描述符索引与每种输入策略的视图、解析器和投影都独立惰性求值并缓存；Loader 校验静态 spec 及可调用辅助能力，不调用选择器、解析器或投影。
- 每个输入参数从同一模型生成普通与严格 codec；消费方无需方法注解即可选择策略。两种封装都拒绝额外具名参数；严格输入递归关闭已声明对象，但不关闭 JSON 或字典键，也不改变 Host 分发和结果。
- 协议源码与构建入口没有 Zod 运行时依赖；生成产物显式提供 Zod，无参端点也能创建拒绝额外字段的空输入对象；[生产 headless profile 的 Loader 回归](<../../../../packages/context/time-context/tests/time-context.e2e.ts>)断言真实 Session 事件。
- Registry 身份、原子注册、撤销和释放保持不变。
- 缺少文档或不支持可选投影不阻止生成；选中的工具拒绝缺少必需信息的条目，并仍然解析输出。
- 严格源码/产物调用与有限 fallback 分别测试；撤销严格 descriptor 绝不启用 fallback。
- 源码静态检查不消费过期生成声明；产物检查声明并重建输入。生产代码不保留源码定义 opt-in、源码导出、清单或新鲜度规则。

## Risks

完整下游 profile 组合仍需在相应 package 中继续完成；生成的元数据不代表每个 #4111 操作或 CLI/MCP 应用都已迁移。明确接受的取舍是完整源码运行时元数据需要显式预构建。缺失或过期产物要求重新生成，而不是降低验证或另建一套手写 schema。
