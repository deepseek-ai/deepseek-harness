<!-- 英文源文件由 scripts/gen-cordis-catalog.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-cordis-catalog` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/cordis-api/fiber.md` 重新记录配对。 -->

# Fiber

[English](fiber.md) | 中文

fiber 是一个已加载的插件实例，包含其生命周期状态、经过校验的配置以及已注册的作用。`ctx.fiber` 是当前 fiber，`ctx.effect()` 会将调用委托给它。

### ctx.effect(execute, label?)

```ts cordis-catalog
/**
 * Register a cleanup-aware effect on this fiber.
 *
 * `execute` runs immediately; the disposers it produces are collected and
 * run (in reverse order) either when the returned disposer is called or
 * when the fiber unloads, whichever comes first. Calling the disposer twice
 * is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
 * already disposed, and `TypeError` if `execute` returns an invalid shape.
 *
 * @param execute — the effect body; see {@link Effect} for accepted shapes.
 * @param label — effect label shown in `getEffects()` diagnostics.
 * @returns a disposer that tears the effect down and settles once done.
 */
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
```

在此 fiber 上注册一个支持清理的作用。

`execute` 会立即运行；它产生的清理函数将被收集，并在调用返回的清理函数或卸载 fiber 时按相反顺序运行，以先发生者为准。重复调用清理函数不会产生任何效果。如果 fiber 已经 dispose（资源释放），则抛出 `CordisError('INACTIVE_EFFECT')`；如果结构无效，则抛出 `TypeError`，表示 `execute` 返回了不受支持的结果。

- `execute`：作用主体；可接受的结构见 `Effect`。
- `label`：在 `getEffects()` 诊断信息中显示的作用标签。

**返回**一个用于撤销该作用的清理函数，并在清理完成后结算。

[源码](../../vendor/cordis/src/fiber.ts#L415)

### ctx.fiber

```ts cordis-catalog
/** The fiber (plugin runtime instance) that owns this context. */
fiber: Fiber
```

拥有此上下文的 fiber（插件运行时实例）。

[源码](../../vendor/cordis/src/fiber.ts#L12)

## Fiber 类

单次插件应用的运行时实例。

fiber 会跟踪 `ctx.plugin()` 返回的插件上下文所对应的依赖状态、经过校验的配置、生命周期作用和清理操作。

[源码](../../vendor/cordis/src/fiber.ts#L184)

### fiber.uid

```ts cordis-catalog
/** Unique id within the registry; 0 for the root fiber, `null` once disposed. */
public uid: number | null
```

在注册表中的唯一 id；根 fiber 的 id 为 0，dispose 后为 `null`。

[源码](../../vendor/cordis/src/fiber.ts#L186)

### fiber.ctx

```ts cordis-catalog
/** The context this fiber's plugin runs in (extends the parent context). */
public readonly ctx: Context
```

此 fiber 的插件运行所在的上下文（扩展自父上下文）。

[源码](../../vendor/cordis/src/fiber.ts#L188)

### fiber.config

```ts cordis-catalog
/** The validated plugin config (updated by `update()`). */
public config: any
```

经过校验的插件配置（由 `update()` 更新）。

[源码](../../vendor/cordis/src/fiber.ts#L190)

### fiber.state

```ts cordis-catalog
/** Current lifecycle state; transitions emit `internal/status`. */
public state
```

当前生命周期状态；状态转换会发出 `internal/status`。

[源码](../../vendor/cordis/src/fiber.ts#L194)

### fiber.dispose

```ts cordis-catalog
/** Dispose this fiber: unload the plugin, then settle once cleanup finished. */
public readonly dispose: () => Promise<void>
```

dispose 此 fiber：卸载插件，并在清理完成后结算。

[源码](../../vendor/cordis/src/fiber.ts#L196)

### fiber.store

```ts cordis-catalog
/** Snapshot of required service implementations while loaded; `undefined` otherwise. */
public store: Dict<Impl> | undefined
```

加载期间所需服务实现的快照；其他情况下为 `undefined`。

[源码](../../vendor/cordis/src/fiber.ts#L198)

### fiber.inertia

```ts cordis-catalog
/** The in-flight load/unload transition, if one is currently running. */
public inertia: Promise<void> | undefined
```

当前正在进行的加载或卸载转换；如果没有此类转换，则为 undefined。

[源码](../../vendor/cordis/src/fiber.ts#L200)

### fiber.name

```ts cordis-catalog
/** The plugin's display name, inherited from the nearest named ancestor, else `'root'`. */
get name()
```

插件的显示名称，继承自最近的具名祖先；如果不存在，则为 `'root'`。

[源码](../../vendor/cordis/src/fiber.ts#L336)

### fiber.assertActive()

```ts cordis-catalog
/**
 * Throw if the fiber has already been disposed.
 *
 * @returns nothing when the fiber is still active.
 * @throws {CordisError} `INACTIVE_EFFECT` when the fiber's uid has been cleared.
 */
assertActive()
```

如果 fiber 已经 dispose，则抛出异常。

**返回**：fiber 仍处于活动状态时不返回任何内容。

[源码](../../vendor/cordis/src/fiber.ts#L351)

### fiber.effect(execute, label?)

```ts cordis-catalog
/**
 * Register a cleanup-aware effect on this fiber.
 *
 * `execute` runs immediately; the disposers it produces are collected and
 * run (in reverse order) either when the returned disposer is called or
 * when the fiber unloads, whichever comes first. Calling the disposer twice
 * is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
 * already disposed, and `TypeError` if `execute` returns an invalid shape.
 *
 * @param execute — the effect body; see {@link Effect} for accepted shapes.
 * @param label — effect label shown in `getEffects()` diagnostics.
 * @returns a disposer that tears the effect down and settles once done.
 */
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
```

在此 fiber 上注册一个支持清理的作用。

`execute` 会立即运行；它产生的清理函数将被收集，并在调用返回的清理函数或卸载 fiber 时按相反顺序运行，以先发生者为准。重复调用清理函数不会产生任何效果。如果 fiber 已经 dispose，则抛出 `CordisError('INACTIVE_EFFECT')`；如果结构无效，则抛出 `TypeError`，表示 `execute` 返回了不受支持的结果。

- `execute`：作用主体；可接受的结构见 `Effect`。
- `label`：在 `getEffects()` 诊断信息中显示的作用标签。

**返回**一个用于撤销该作用的清理函数，并在清理完成后结算。

[源码](../../vendor/cordis/src/fiber.ts#L415)

### fiber.getEffects()

```ts cordis-catalog
/**
 * Return metadata for currently registered effects.
 *
 * @returns one {@link EffectMeta} tree per labeled live effect.
 */
getEffects()
```

返回当前已注册作用的元数据。

**返回**：每个带标签的活动作用对应一棵 `EffectMeta` 树。

[源码](../../vendor/cordis/src/fiber.ts#L568)

### fiber.await()

```ts cordis-catalog
/**
 * Wait for current lifecycle work and rethrow startup errors.
 *
 * @returns this fiber, once it has settled into a stable state.
 * @throws the config-validation or plugin-startup error, if any.
 */
async await()
```

等待当前生命周期工作完成，并重新抛出启动错误。

**返回**：进入稳定状态后的此 fiber。

[源码](../../vendor/cordis/src/fiber.ts#L704)

### fiber.restart()

```ts cordis-catalog
/**
 * Dispose and immediately reload this plugin with its current config.
 *
 * @returns a promise resolving once the reload settled.
 * @throws {CordisError} `INACTIVE_EFFECT` when the fiber is already disposed.
 */
async restart()
```

dispose 此插件，并立即使用其当前配置重新加载。

**返回**一个在重新加载完成后兑现的 promise。

[源码](../../vendor/cordis/src/fiber.ts#L718)

### fiber.update(config, noSave?)

```ts cordis-catalog
/**
 * Validate and apply new config, then restart the plugin.
 *
 * Runs the `internal/update` waterfall first, so update hooks (and HMR)
 * can veto or replace the restart.
 *
 * @param config — the new raw config; validated before anything restarts.
 * @param noSave — hint for persistence hooks not to write the change back.
 * @returns nothing; the restart runs behind the `internal/update` waterfall.
 * @throws {ValidationError} when the new config fails validation.
 */
update(config: any, noSave = false)
```

校验并应用新配置，然后重新启动插件。

首先运行 `internal/update` waterfall（瀑布式事件），因此更新钩子（以及 HMR（热模块替换））可以否决或取代重新启动操作。

- `config`：新的原始配置；在任何内容重新启动前进行校验。
- `noSave`：提示持久化钩子不要写回此变更。

**返回**无返回值；重启由 `internal/update` waterfall 执行。

[源码](../../vendor/cordis/src/fiber.ts#L736)

## Effect

`ctx.effect()` 和插件启动所接受的作用主体结果。

可以是单个清理函数、兑现为清理函数的 promise，或生成多个清理函数的（可能为异步的）可迭代对象。生成器作用会在每个清理函数产生时将其注册。

```ts cordis-catalog
/**
 * Effect body result accepted by `ctx.effect()` and plugin startup.
 *
 * Either a single disposer, a promise of one, or a (possibly async) iterable
 * yielding several — generator effects register each yielded disposer as it
 * is produced.
 */
type Effect<T = any> =
  | SyncEffect<T>
  | AsyncEffect<T>
```

[源码](../../vendor/cordis/src/fiber.ts#L83)

## Disposable

作用返回的函数，用于在资源释放期间释放资源。

拥有该函数的 fiber 卸载时，清理函数会按注册的相反顺序运行；清理函数可以是异步的，此时卸载过程会等待其完成。

```ts cordis-catalog
/**
 * Function returned by an effect to release resources during disposal.
 *
 * Disposers run in reverse registration order when the owning fiber unloads;
 * they may be async, in which case unloading awaits them.
 */
type Disposable<T = any> = () => T
```

[源码](../../vendor/cordis/src/fiber.ts#L74)

## EffectMeta

用于在诊断信息中公开嵌套作用标签的树节点。

```ts cordis-catalog
/** Tree node used to expose nested effect labels for diagnostics. */
interface EffectMeta {
  /** Human-readable effect label, e.g. `ctx.on("event")` or `ctx.provide("name")`. */
  label: string
  /** Metadata of nested effects registered while this effect ran. */
  children: EffectMeta[]
}
```

[源码](../../vendor/cordis/src/fiber.ts#L96)

## CordisError

具有稳定机器可读错误码的框架错误。

```ts cordis-catalog
/** Framework error with a stable machine-readable code. */
class CordisError extends Error {
  /**
   * @param code — the stable error code; also the default message.
   * @param message — optional human-readable override.
   */
  constructor(public code: CordisError.Code, message?: string)
}

/** Cordis error code definitions. */
namespace CordisError {
  export type Code = keyof typeof Code

  export const Code = {
    INACTIVE_EFFECT: 'cannot create effect on inactive context',
  } as const
}
```

[源码](../../vendor/cordis/src/fiber.ts#L157)

## ValidationError

插件配置未通过 standard-schema 校验时抛出的错误。

```ts cordis-catalog
/** Error raised when plugin configuration fails standard-schema validation. */
class ValidationError extends TypeError {
  name = 'ValidationError'

  /**
   * Build the aggregated message from schema issues.
   *
   * @param issues — the standard-schema issues, one message line each.
   */
  constructor(issues: readonly StandardSchemaV1.Issue[])
}
```

[源码](../../vendor/cordis/src/fiber.ts#L19)
