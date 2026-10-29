<!-- 英文源文件由 scripts/gen-cordis-catalog.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-cordis-catalog` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/cordis-api/context.md` 重新记录配对。 -->

# 上下文

[English](context.md) | 中文

上下文是 Cordis 的核心对象：所有服务、事件和生命周期 API 都通过 `ctx` 访问。事件方法见[事件](events.zh.md)，副作用与当前 fiber 见 [Fiber](fiber.zh.md)，插件加载见[注册表](registry.zh.md)。

Cordis 插件的根依赖容器和子依赖容器。

上下文是一个代理：普通属性读取通过服务解析器进行，而 `extend()`、`isolate()` 和 `intercept()` 会创建有作用域的子上下文，且不修改其父上下文。

[源码](../../vendor/cordis/src/context.ts#L42)

### ctx.extend(meta?)

```ts cordis-catalog
/**
 * Create a child context with extra metadata on top of the current scope.
 *
 * The child prototypally inherits every property of this context; own
 * properties of `meta` shadow the inherited ones. The parent is not mutated.
 *
 * @param meta — own properties (including symbol keys) to define on the child.
 * @returns a child context inheriting from this one.
 */
extend(meta = {}): this
```

在当前作用域之上创建一个带有额外元数据的子上下文。

子上下文通过原型继承当前上下文的所有属性；`meta` 的自有属性会遮蔽继承的同名属性。父上下文不会被修改。

- `meta`：要在子上下文上定义的自有属性，包括以 symbol 为键的属性。

**返回**继承自当前上下文的子上下文。

[源码](../../vendor/cordis/src/context.ts#L99)

### ctx.isolate(name, label?)

```ts cordis-catalog
/**
 * Create a child context with an independent service scope for `name`.
 *
 * Below the returned context, reads and writes of the service `name`
 * resolve against the new label instead of the parent's, so a different
 * implementation can be provided without affecting the parent scope.
 * Passing the same `label` to two `isolate()` calls joins their scopes.
 *
 * @param name — the service name to isolate.
 * @param label — scope label to join; defaults to a fresh unique symbol.
 * @returns a child context whose `name` service resolves in the new scope.
 */
isolate(name: string, label?: symbol)
```

创建一个子上下文，使 `name` 拥有独立的服务作用域。

在返回的上下文之下，对服务 `name` 的读写会根据新标签解析，而不再根据父上下文的标签解析，因此可以提供不同的实现而不影响父作用域。将同一个 `label` 传给两次 `isolate()` 调用，可使二者加入同一作用域。

- `name`：要隔离的服务名称。
- `label`：要加入的作用域标签；默认为一个新建的唯一 symbol。

**返回**一个子上下文，其 `name` 服务在新作用域中解析。

[源码](../../vendor/cordis/src/context.ts#L121)

### ctx.intercept(name, config)

```ts cordis-catalog
/**
 * Add service-specific intercept config for plugins started below this
 * context.
 *
 * Plugins loaded under the returned context see `config` merged into the
 * service's resolved config (ancestor entries first; see
 * `Service[symbols.resolveConfig]`). The parent context is not affected.
 *
 * @param name — the service name whose config to intercept.
 * @param config — the intercept config to merge for that service.
 * @returns a child context carrying the additional intercept entry.
 */
intercept<K extends InjectKey>(name: K, config: Context[K] extends { [symbols.config]: infer T } ? T : never): this
intercept(name: string, config: any): this
```

为在此上下文之下启动的插件添加服务专属的拦截配置。

在返回的上下文下加载的插件会看到 `config` 已合并到服务解析后的配置中（祖先条目在前；见 `Service[symbols.resolveConfig]`）。父上下文不受影响。

- `name`：要拦截其配置的服务名称。
- `config`：要为该服务合并的拦截配置。

**返回**一个携带额外拦截条目的子上下文。

[源码](../../vendor/cordis/src/context.ts#L139)

### ctx.root

```ts cordis-catalog
/** The root context of the application (every child context shares it). @experimental */
root: this
```

应用的根上下文，所有子上下文均共享它。@experimental

[源码](../../vendor/cordis/src/context.ts#L22)

### ctx.baseUrl

```ts cordis-catalog
/** Base URL used to resolve relative plugin/module specifiers, if the runtime sets one. */
baseUrl?: string | undefined
```

用于解析相对插件／模块说明符的基础 URL，前提是运行时设置了该值。

[源码](../../vendor/cordis/src/context.ts#L24)

### ctx.events

```ts cordis-catalog
/** The event bus. Its methods are also mixed onto `ctx` (`ctx.on`, `ctx.emit`, ...). */
events: EventsService
```

事件总线。它的方法也会混入 `ctx`（`ctx.on`、`ctx.emit` 等）。

[源码](../../vendor/cordis/src/context.ts#L26)

### ctx.logger

```ts cordis-catalog
/** The logging service. Call `ctx.logger(name)` for a named logger. */
logger: LoggerService
```

日志服务。调用 `ctx.logger(name)` 可获取具名 logger。

[源码](../../vendor/cordis/src/context.ts#L28)

### ctx.reflect

```ts cordis-catalog
/** The reflection layer backing the context proxy (`ctx.get`, `ctx.provide`, ...). */
reflect: ReflectService
```

为上下文代理提供支持的反射层（`ctx.get`、`ctx.provide` 等）。

[源码](../../vendor/cordis/src/context.ts#L30)

### ctx.registry

```ts cordis-catalog
/** The plugin registry. Its methods are mixed onto `ctx` (`ctx.plugin`, `ctx.inject`). */
registry: RegistryService
```

插件注册表。它的方法会混入 `ctx`（`ctx.plugin`、`ctx.inject`）。

[源码](../../vendor/cordis/src/context.ts#L32)

## 静态成员

### Context.effect

```ts cordis-catalog
/** Symbol key under which a disposer exposes its {@link EffectMeta} diagnostics tree. */
static readonly effect: unique symbol
```

资源释放函数用于公开其 EffectMeta 诊断树的 symbol 键。

[源码](../../vendor/cordis/src/context.ts#L44)

### Context.filter

```ts cordis-catalog
/** Symbol key for a context's listener filter, consulted on every event dispatch. */
static readonly filter: unique symbol
```

上下文监听器过滤器的 symbol 键，每次分派事件时都会查询该过滤器。

[源码](../../vendor/cordis/src/context.ts#L46)

### Context.isolate

```ts cordis-catalog
/** Symbol key of the isolation map (see the `Context[symbols.isolate]` property). */
static readonly isolate: unique symbol
```

隔离映射的 symbol 键（见 `Context[symbols.isolate]` 属性）。

[源码](../../vendor/cordis/src/context.ts#L48)

### Context.intercept

```ts cordis-catalog
/** Symbol key of the intercept map (see the `Context[symbols.intercept]` property). */
static readonly intercept: unique symbol
```

拦截映射的 symbol 键（见 `Context[symbols.intercept]` 属性）。

[源码](../../vendor/cordis/src/context.ts#L50)

### Context.is(value)

```ts cordis-catalog
/**
 * Returns true for Cordis context proxies and context prototypes.
 *
 * Works across realms and across multiple copies of cordis, because the
 * brand is keyed by a global symbol rather than by `instanceof`.
 *
 * @param value — the value to test.
 * @returns `true` if `value` is a Cordis context, narrowing its type.
 */
static is(value: any): value is Context
```

对于 Cordis 上下文代理和上下文原型，返回 true。

此方法可跨 realm 和多个 cordis 副本工作，因为其品牌标识以全局 symbol 为键，而不是通过 `instanceof` 判断。

- `value`：要测试的值。

**返回** `true` 时，`value` 是 Cordis 上下文，并会收窄其类型。

[源码](../../vendor/cordis/src/context.ts#L61)

## 服务存储与混入

### ctx.get(name, strict?)

```ts cordis-catalog
/**
 * Read a service from the store without the inject requirement.
 *
 * @param name — the service name.
 * @param strict — when `true` (default), only return implementations
 * whose providing fiber is currently active.
 * @returns the service value, or `undefined` when not (yet) provided.
 */
get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
get(name: string, strict?: boolean): any
```

从存储中读取服务，无需满足注入要求。

- `name`：服务名称。
- `strict`：设为 `true`（默认值）时，仅返回其提供方 fiber 当前处于活动状态的实现。

**返回**服务值；如果尚未提供，则返回 `undefined`。

[源码](../../vendor/cordis/src/reflect.ts#L17)

### ctx.set(name, value)

```ts cordis-catalog
/**
 * Overwrite a provided service's value.
 *
 * Only the fiber that provided the service may set it; setting an
 * unprovided name throws.
 *
 * @param name — the service name.
 * @param value — the new service value.
 */
set<K extends string & keyof this>(name: K, value: undefined | this[K]): void
set(name: string, value: any): void
```

覆盖已提供服务的值。

只有提供该服务的 fiber 才能设置它；设置尚未提供的名称会抛出异常。

- `name`：服务名称。
- `value`：新的服务值。

[源码](../../vendor/cordis/src/reflect.ts#L29)

### ctx.provide(name, value)

```ts cordis-catalog
/**
 * Register a service implementation owned by the current fiber.
 *
 * The service becomes visible to dependents in the same isolation scope
 * once the fiber is active; it is unregistered (waking dependents) when
 * the returned disposer runs or the fiber unloads. Throws if the name is
 * already provided in this scope or declared as an accessor.
 *
 * @param name — the service name.
 * @param value — the service value.
 * @returns a disposer that unregisters the service.
 */
provide<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void
provide(name: string, value?: any): () => void
```

注册一个归当前 fiber 所有的服务实现。

fiber 激活后，该服务对同一隔离作用域内的依赖方可见；当返回的资源释放函数运行或 fiber 卸载时，该服务会被取消注册，并唤醒依赖方。如果该名称已在此作用域中被提供，或已声明为访问器，则抛出异常。

- `name`：服务名称。
- `value`：服务值。

**返回**一个用于取消注册该服务的资源释放函数。

[源码](../../vendor/cordis/src/reflect.ts#L44)

### ctx.accessor(name, options)

```ts cordis-catalog
/**
 * Define a computed context property backed by get/set hooks.
 *
 * The accessor is removed when the current fiber unloads. Throws if the
 * name is already declared.
 *
 * @param name — the context property name.
 * @param options — the `get` hook and optional `set` hook.
 */
accessor(name: string, options: Omit<Property.Accessor, 'type'>): void
```

定义一个由 get/set 钩子支持的计算型上下文属性。

当前 fiber 卸载时会移除该访问器。如果该名称已被声明，则抛出异常。

- `name`：上下文属性名称。
- `options`：`get` 钩子和可选的 `set` 钩子。

[源码](../../vendor/cordis/src/reflect.ts#L56)

### ctx.mixin(name, mixins)

```ts cordis-catalog
/**
 * Expose selected members of a service directly on `ctx`.
 *
 * Each mixed-in key becomes an accessor that forwards to the service
 * (binding methods to it), so e.g. `ctx.on` forwards to `ctx.events.on`.
 * Mixins are removed when the current fiber unloads.
 *
 * @param name — the context property holding the source service.
 * @param mixins — keys to forward, or a source-key → ctx-key map.
 */
mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void
```

直接在 `ctx` 上公开服务的指定成员。

每个混入的键都会成为一个转发到该服务的访问器，并将方法绑定到该服务。例如，`ctx.on` 会转发到 `ctx.events.on`。当前 fiber 卸载时会移除这些混入。

- `name`：存放源服务的上下文属性。
- `mixins`：要转发的键，或从源键到 ctx 键的映射。

[源码](../../vendor/cordis/src/reflect.ts#L67)
