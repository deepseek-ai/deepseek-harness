<!-- 英文源文件由 scripts/gen-cordis-catalog.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-cordis-catalog` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/cordis-api/service.md` 重新记录配对。 -->

# Service

[English](service.md) | 中文

上下文服务的基类。以插件形式加载的子类会将自身注册为 `ctx.<name>`。

用于在 `ctx` 上公开具名 API 的服务基类。

子类在构造函数中调用 `super(ctx, name)`。服务会立即注册，并随所属 fiber 自动移除。

[源码](../../vendor/cordis/src/service.ts#L12)

### service.name

```ts cordis-catalog
/** The service name this instance is registered under. */
public name!: string
```

此实例注册时使用的服务名称。

[源码](../../vendor/cordis/src/service.ts#L33)

## 静态成员

### Service.init

```ts cordis-catalog
/** Symbol key of an instance method run after construction (class plugins). */
static readonly init: unique symbol
```

构造完成后运行的实例方法所使用的符号键（类插件）。

[源码](../../vendor/cordis/src/service.ts#L14)

### Service.check

```ts cordis-catalog
/** Symbol key of the availability predicate passed to `ctx.provide()`. */
static readonly check: unique symbol
```

传给 `ctx.provide()` 的可用性谓词所使用的符号键。

[源码](../../vendor/cordis/src/service.ts#L16)

### Service.invoke

```ts cordis-catalog
/** Symbol key of the call body making a service callable (e.g. `ctx.logger()`). */
static readonly invoke: unique symbol
```

使服务可被调用的调用体所使用的符号键（例如 `ctx.logger()`）。

[源码](../../vendor/cordis/src/service.ts#L18)

### Service.metadata

```ts cordis-catalog
/** Symbol key of the phantom intercept-metadata type parameter. */
static readonly metadata: unique symbol
```

虚设拦截元数据类型参数所使用的符号键。

[源码](../../vendor/cordis/src/service.ts#L20)

### Service.extend

```ts cordis-catalog
/** Symbol key of the helper deriving an extended service instance. */
static readonly extend: unique symbol
```

用于派生扩展服务实例的辅助方法所使用的符号键。

[源码](../../vendor/cordis/src/service.ts#L22)

### Service.tracker

```ts cordis-catalog
/** Symbol key of the tracker metadata used for context tracing. */
static readonly tracker: unique symbol
```

上下文追踪所用跟踪器元数据的符号键。

[源码](../../vendor/cordis/src/service.ts#L24)

### Service.mergeIntercept

```ts cordis-catalog
/** Symbol key of the intercept-metadata merge hook below. */
static readonly mergeIntercept: unique symbol
```

下述拦截元数据合并钩子所使用的符号键。

[源码](../../vendor/cordis/src/service.ts#L26)

### Service.resolveIntercept

```ts cordis-catalog
/** Symbol key of the intercept-metadata resolution helper below. */
static readonly resolveIntercept: unique symbol
```

下述拦截元数据解析辅助方法所使用的符号键。

[源码](../../vendor/cordis/src/service.ts#L28)
