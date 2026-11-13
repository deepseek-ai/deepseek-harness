---
kind: upgrade-guide
description: "Cordis 4.0.0-rc.12 用 ctx[Context.root] 取代 ctx.root，并重命名服务拦截元数据 API。"
---

# `ctx[Context.root]` 取代 `ctx.root`，服务拦截元数据 API 重命名

[English](guide.md) | 中文

## 变更

`@deepseek-ai/cordis` 现在包含上游 Cordis 4.0.0-rc.12。针对上一版本编写的第三方插件和服务会受到以下影响：

- `ctx.root` 不再存在。根上下文改为 `ctx[Context.root]`；`Context.root` 是 `Context` 类上导出的 symbol。在插件内读取 `ctx.root` 会抛出 `cannot get property "root" without inject`。
- `Service.config` 改为 `Service.metadata`。服务用 `declare [Service.metadata]: T` 声明其拦截类型。
- `[Service.resolveConfig](base?, head?)` 改为不带参数的 `[Service.resolveIntercept]()`。
- 全局 symbol `Symbol.for('cordis.metadata')` 现在对应 `Service.metadata`。`@Inject()` 等装饰器存储的方法元数据改用 `symbols.decorator`（`Symbol.for('cordis.decorator')`）。
- 服务的 `Config.merge` 钩子不再被调用。改为重写 `[Service.mergeIntercept](...values)`；它按优先级从低到高接收各个值。
- 插件在对象形式的 `inject` 中声明的元数据现在优先级最低，用 `ctx.intercept()` 添加的拦截会覆盖它；此前是注入的值覆盖拦截。
- 用 `ctx.isolate(name)` 创建的上下文不再回退到外层插件注入的 `name`。在其下启动的插件，以及在其自身提供撤回后的读取，都会抛出 `cannot get property "<name>" without inject`。
- `ctx.parallel()` 失败时抛出的 `AggregateError` 的消息会注明事件名；在非活动状态下被销毁的 fiber（例如失败的 fiber）现在会进入 `FiberState.DISPOSED`。

## 迁移

1. 将所有 `ctx.root` 替换为 `ctx[Context.root]`，并从 `@deepseek-ai/cordis` 以值的形式导入 `Context`。无法导入的纯 JavaScript 可以读取 `ctx[Symbol.for('cordis.root')]`。
2. 在服务类中，将 `declare [Service.config]` 改为 `declare [Service.metadata]`，将对 `[Service.resolveConfig]()` 的调用改为 `[Service.resolveIntercept]()`。原来的 `base` 参数改为在 `inject` 中声明，`head` 参数改为用 `ctx.intercept()` 添加。
3. 如果代码通过 `symbols.metadata` 或 `Symbol.for('cordis.metadata')` 读写装饰器的方法元数据，改用 `symbols.decorator`。
4. 将 `Config.merge` 的实现移到服务类的 `[Service.mergeIntercept](...values)` 方法中。
5. 如果插件依赖其 `inject` 元数据覆盖祖先的 `ctx.intercept()`，改为在该插件的上下文上用 `ctx.intercept()` 设置该值。
6. 如果 `ctx.isolate(name)` 之下的代码需要外层插件的服务，在隔离的上下文中提供该服务，或从未隔离的上下文启动这段代码。
7. 运行 TypeScript 构建：引用 `ctx.root`、`Service.config` 和 `Service.resolveConfig` 的代码会编译失败。启动插件，确认服务可以解析，日志名称保持不变。
