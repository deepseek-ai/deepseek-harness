# 执行环境

[English](environment.md) | 中文

[`dsh-environment`](../../packages/experimental/environment/README.zh.md) 服务提供 `ctx.environments`：提供方贡献的执行环境的注册表，它在这些环境中运行已定义的函数。

## 注册表

`EnvironmentInfo` 包含由提供方管理的 `EnvironmentHandle` 和面向用户的 `displayName`。句柄是非空的不透明字符串，在同一注册表中必须唯一；显示名称可以重复。提供方将元数据与 `EnvironmentTransport` 一同注册，连接配置保留在提供方内部。`list()` 返回元数据快照；`get(handle)` 读取当前注册项。不带载荷的 `environments/change` 事件在每次注册和每次实际生效的注销之后触发，消费方据此重新读取 `list()`。移除提供方会撤销其环境并关闭相应连接。

[单目标 SSH](../../packages/experimental/environment-ssh/README.zh.md)、[SSH 配置](../../packages/experimental/environment-ssh-config/README.zh.md)和[本地](../../packages/experimental/environment-local/README.zh.md)提供方使用同一套协议。SSH 配置发现针对具体别名组合使用单目标 SSH 提供方，并在加载期间跟随配置文件的变化。SSH 和本地传输均为每个新连接启动全新的 `daemon.js serve --stdio` 进程；复用活跃通道时保留该进程。

## 定义与运行

`define(fn, options)` 绑定自包含函数、其结果校验和发起端处理函数，并返回 `EnvironmentRunner`。每次使用环境句柄、参数和信号调用该运行器，最多运行一次函数：该次调用会解析到该句柄当前的注册项，发送参数，以及根据该定义的函数源码和发起端方法名称计算的哈希（在该连接的守护进程持有该定义之前还会附带定义本身），并通过所属定义的 `result` 校验返回值。定义时不与任何环境通信。注册表和发起端处理函数在 dsh 中运行。每次运行占用目标执行进程的一个 worker 线程，因此阻塞的函数不会延迟其他运行。`EnvironmentContext` 属于该进程，提供该进程的文件系统、路径、工作目录、平台、进程执行、信号、上限和类型化 `origin` 方法。发起端调用仅限于活跃的运行及其所属连接。

参数、结果和发起端值都是通过结构化克隆复制的 `EnvironmentValue`，因此可以携带以 `Uint8Array` 表示的二进制数据、`undefined`、日期、Map 和 Set。注册表和 `EnvironmentContext` 上的 `limits.maxMessageBytes` 限制每条编码后的消息；注册表会自动拆分大于一帧的消息。函数抛出异常的运行以 `ENVIRONMENT_RUN_FAILED` 失败，其 `EnvironmentError.remote` 保存所抛出错误的名称、消息和字符串错误码。

注册表负责协议，并为每个注册项缓存一个独立连接；传输实现负责执行进程的启动和停止。工作尚未发送时可重连一次；已发送的运行不会重放。取消和连接失败不会回滚已完成的副作用。进行中的运行不会切换到使用同一句柄的替代注册项。执行限制、信任机制、取消和错误语义见[包参考](../../packages/experimental/environment/README.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxenvironments--environmentregistry"></a>

### `ctx.environments` — `EnvironmentRegistry`

Owner of environment registrations and of one daemon connection per environment. A connection opens on the first call and reopens on the next call after it closes; runs in flight when it closes fail and are never replayed. Providers contribute metadata and transports; the registry uses one common execution protocol for all of them.

```ts cordis-catalog
/**
 * Admit a provider identifier without interpreting its format.
 * @param value - non-empty stable identifier chosen by the provider.
 * @returns the branded registry key.
 */
handle(value: string): EnvironmentHandle

/**
 * Contribute an environment and its connection capability. Emits `environments/change` once registered.
 * @param info - provider-owned handle and user-facing display name.
 * @param transport - opens channels to this environment's execution process.
 * @returns a disposer that removes this registration, closes its connection and emits `environments/change`;
 * later calls do nothing.
 */
register(info: EnvironmentInfo, transport: EnvironmentTransport): () => void

/**
 * Snapshot the public metadata of current provider contributions.
 * @returns metadata without connection settings or execution objects.
 */
list(): readonly EnvironmentInfo[]

/**
 * Read the current registration's public metadata.
 * @param handle - provider-owned environment identifier.
 * @returns its handle and display name; throws when the environment is unavailable.
 */
get(handle: EnvironmentHandle): EnvironmentInfo

/**
 * Define `fn` for execution processes; each run names its environment. Only its source text and the names of its origin
 * handlers are sent, so `fn` must be a self-contained function or arrow expression without host closures. The type
 * of `fn`'s first parameter determines the arguments of each call. Arguments, results and origin values are copied
 * by structured clone; values it cannot copy, such as functions, fail their run. The own property names of
 * `options.handlers`, read here once, are the `env.origin` methods; names added to the object later are neither
 * exposed nor served, while an origin call looks its handler up on the object when it arrives. The handlers' types
 * determine `env.origin` parameter types and awaited result types. Handlers serve every call and receive only
 * parameters from the function, so host state that belongs to one call, such as a tool call's background job,
 * needs a definition made for that call. Defining neither contacts an environment nor requires a registration.
 * @param fn - daemon-side code receiving each call's arguments and the daemon environment.
 * @param options - result validation and host handlers.
 * @returns a function that runs `fn` at most once per call.
 */
define<A extends EnvironmentValue, T, H extends EnvironmentHandlers = Record<never, never>>( fn: EnvironmentFunction<A, NoInfer<H>>, options: EnvironmentDefineOptions<T, H>, ): EnvironmentRunner<A, T>
```

Source: [`packages/experimental/environment/src/index.ts`](../../packages/experimental/environment/src/index.ts)

<a id="environments-events"></a>

### `environments/*` events

<a id="environmentschange--emit"></a>

#### `environments/change` — emit

The set of registered environments changed. Fires once per registration and once per effective unregistration, after `list()` and `get()` reflect the change; a removed registration's connection is already detached and closing. Payload-free: listeners re-read `list()`. Listener failures are logged and do not undo the change.

```ts cordis-catalog
/**
 * The set of registered environments changed. Fires once per registration and once per effective
 * unregistration, after `list()` and `get()` reflect the change; a removed registration's connection is
 * already detached and closing. Payload-free: listeners re-read `list()`. Listener failures are logged
 * and do not undo the change.
 * @mode emit
 */
'environments/change'(): void
```

Source: [`packages/experimental/environment/src/index.ts`](../../packages/experimental/environment/src/index.ts)
<!-- END GENERATED cordis-surface -->
