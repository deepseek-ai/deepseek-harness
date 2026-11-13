---
kind: upgrade-guide
description: "Cordis 4.0.0-rc.12 replaces ctx.root with ctx[Context.root] and renames the service intercept-metadata API."
---

# `ctx[Context.root]` replaces `ctx.root`, and service intercept metadata is renamed

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/cordis` now carries upstream Cordis 4.0.0-rc.12. Third-party plugins and services written against the previous release are affected:

- `ctx.root` no longer exists. The root context is `ctx[Context.root]`; `Context.root` is a symbol exported on the `Context` class. Inside a plugin, reading `ctx.root` throws `cannot get property "root" without inject`.
- `Service.config` becomes `Service.metadata`. A service declares its intercept type with `declare [Service.metadata]: T`.
- `[Service.resolveConfig](base?, head?)` becomes `[Service.resolveIntercept]()`, which takes no arguments.
- The global symbol `Symbol.for('cordis.metadata')` now keys `Service.metadata`. The method metadata that decorators such as `@Inject()` store moved to `symbols.decorator` (`Symbol.for('cordis.decorator')`).
- A service's `Config.merge` hook is no longer called. Override `[Service.mergeIntercept](...values)` instead; it receives the values in increasing precedence.
- Metadata a plugin declares in object-form `inject` now has the lowest precedence. Intercepts added with `ctx.intercept()` override it; previously the injected value overrode them.
- A context created with `ctx.isolate(name)` no longer falls back to the enclosing plugin's injected `name`. Plugins started under it, and reads after its own provision is withdrawn, throw `cannot get property "<name>" without inject`.
- A failed `ctx.parallel()` throws an `AggregateError` whose message names the event, and a fiber disposed while it was not active, such as a failed one, now settles to `FiberState.DISPOSED`.

## Migration

1. Replace every `ctx.root` with `ctx[Context.root]`, importing `Context` as a value from `@deepseek-ai/cordis`. Plain JavaScript without the import can read `ctx[Symbol.for('cordis.root')]`.
2. In service classes, rename `declare [Service.config]` to `declare [Service.metadata]` and calls of `[Service.resolveConfig]()` to `[Service.resolveIntercept]()`. Replace `base` and `head` arguments by declaring the base value in `inject` and adding the override with `ctx.intercept()`.
3. Where code reads or writes decorator method metadata through `symbols.metadata` or `Symbol.for('cordis.metadata')`, use `symbols.decorator` instead.
4. Move a `Config.merge` implementation to a `[Service.mergeIntercept](...values)` method on the service class.
5. Where a plugin relied on its `inject` metadata overriding an ancestor `ctx.intercept()`, set the value with `ctx.intercept()` at the plugin's context instead.
6. Where code under `ctx.isolate(name)` needs the enclosing plugin's service, provide that service inside the isolated context or start the code from a context that is not isolated.
7. Run your TypeScript build: references to `ctx.root`, `Service.config` and `Service.resolveConfig` fail to compile. Start the plugin and confirm that services resolve and logs keep their names.
