<!-- 英文源文件由 scripts/gen-cordis-catalog.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-cordis-catalog` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/cordis-api/events.md` 重新记录配对。 -->

# 事件

[English](events.md) | 中文

每个上下文中都混入了事件分发 API。Harness 事件声明及其分发模式会生成到各自所属的[子系统页面](../subsystems/core.zh.md)。

### ctx.parallel(name, ...args)

```ts cordis-catalog
/**
 * Dispatch an event, running all listeners concurrently.
 *
 * @param name — the event name.
 * @param args — arguments passed to every listener.
 * @returns a promise resolving once every listener has settled.
 */
parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>
parallel<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promise<void>
```

分发一个事件，并发运行所有监听器。

- `name`：事件名称。
- `args`：传递给每个监听器的参数。

**返回值**：一个 Promise，在所有监听器均已完成后兑现。

[源码](../../vendor/cordis/src/events.ts#L43)

### ctx.emit(name, ...args)

```ts cordis-catalog
/**
 * Dispatch an event synchronously, ignoring listener return values.
 *
 * @param name — the event name.
 * @param args — arguments passed to every listener.
 */
emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
emit<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): void
```

同步分发一个事件，忽略监听器的返回值。

- `name`：事件名称。
- `args`：传递给每个监听器的参数。

[源码](../../vendor/cordis/src/events.ts#L52)

### ctx.serial(name, ...args)

```ts cordis-catalog
/**
 * Dispatch an event, awaiting listeners in order until one bails.
 *
 * @param name — the event name.
 * @param args — arguments passed to each listener.
 * @returns the first bail value (non-null, non-false, non-undefined), if any.
 */
serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
serial<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
```

分发一个事件，依次等待各监听器，直到其中一个提前终止分发。

- `name`：事件名称。
- `args`：传递给每个监听器的参数。

**返回值**：第一个提前终止值（非 null、非 false 且非 undefined）；如果没有，则不返回此类值。

[源码](../../vendor/cordis/src/events.ts#L62)

### ctx.bail(name, ...args)

```ts cordis-catalog
/**
 * Dispatch an event, calling listeners in order until one bails.
 *
 * @param name — the event name.
 * @param args — arguments passed to each listener.
 * @returns the first bail value (non-null, non-false, non-undefined), if any.
 */
bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
bail<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
```

分发一个事件，依次调用各监听器，直到其中一个提前终止分发。

- `name`：事件名称。
- `args`：传递给每个监听器的参数。

**返回值**：第一个提前终止值（非 null、非 false 且非 undefined）；如果没有，则不返回此类值。

[源码](../../vendor/cordis/src/events.ts#L72)

### ctx.waterfall(name, ...args)

```ts cordis-catalog
/**
 * Dispatch an event whose last argument is a `next` continuation.
 *
 * Each listener wraps the rest of the chain: calling `next()` invokes the
 * next listener (finally the built-in behavior); not calling it vetoes.
 *
 * @param name — the event name.
 * @param args — listener arguments; the final one is the innermost `next`.
 * @returns the outermost listener's return value.
 */
waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
waterfall<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
```

分发一个事件，其最后一个参数是续接执行的 `next` 回调。

每个监听器都会包装调用链的其余部分：调用 `next()` 会执行下一个监听器，最终执行内置行为；不调用则会否决后续执行。

- `name`：事件名称。
- `args`：监听器参数；最后一个参数是最内层的 `next`。

**返回值**：最外层监听器的返回值。

[源码](../../vendor/cordis/src/events.ts#L85)

### ctx.on(name, listener, options?)

```ts cordis-catalog
/**
 * Register an event listener owned by the current fiber.
 *
 * @param name — the event name to listen for.
 * @param listener — called with the dispatch arguments.
 * @param options — listener options; a boolean is shorthand for `prepend`.
 * @returns a disposer removing the listener; `true` if it was still registered.
 */
on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
```

注册一个归当前 fiber 所有的事件监听器。

- `name`：要监听的事件名称。
- `listener`：使用分发参数调用的监听器。
- `options`：监听器选项；布尔值可作为 `prepend` 的简写。

**返回值**：一个用于移除监听器的资源释放函数；如果调用该函数时监听器仍处于注册状态，则返回 `true`。

[源码](../../vendor/cordis/src/events.ts#L96)

### ctx.once(name, listener, options?)

```ts cordis-catalog
/**
 * Same as `on()`, but the listener disposes itself after its first call.
 *
 * @param name — the event name to listen for.
 * @param listener — called at most once with the dispatch arguments.
 * @param options — listener options; a boolean is shorthand for `prepend`.
 * @returns a disposer removing the listener; `true` if it was still registered.
 */
once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
```

与 `on()` 相同，但监听器在首次调用后会自行注销。

- `name`：要监听的事件名称。
- `listener`：使用分发参数调用，最多调用一次。
- `options`：监听器选项；布尔值可作为 `prepend` 的简写。

**返回值**：一个用于移除监听器的资源释放函数；如果调用该函数时监听器仍处于注册状态，则返回 `true`。

[源码](../../vendor/cordis/src/events.ts#L105)

## EventOptions

`ctx.on()` 和 `ctx.once()` 接受的选项。

```ts cordis-catalog
/** Options accepted by `ctx.on()` and `ctx.once()`. */
interface EventOptions {
  /** Add the listener before existing listeners for the same event. */
  prepend?: boolean
  /** Receive the event regardless of context filter checks. */
  global?: boolean
}
```

[源码](../../vendor/cordis/src/events.ts#L111)

## DispatchMode

事件服务使用的事件分发策略。

`emit` 运行同步监听器但不等待它们，`parallel` 同时等待所有监听器，`serial` 依次等待监听器直至其中一个提前终止分发，`bail` 遇到第一个同步提前终止值时停止，`waterfall` 则围绕最终的 `next` 回调组合监听器。

```ts cordis-catalog
/**
 * Event dispatch strategy used by the event service.
 *
 * `emit` runs synchronous listeners without awaiting them, `parallel` awaits
 * all listeners together, `serial` awaits them in order until one bails,
 * `bail` stops on the first synchronous bail value, and `waterfall` composes
 * listeners around a final `next` callback.
 */
type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'
```

[源码](../../vendor/cordis/src/events.ts#L31)
