# Plugins and lifecycle

English | [中文](index.zh.md)

This page describes the Cordis plugin model and lifecycle state machine.

## Fiber state machine

Every loaded plugin owns a **Fiber** scope with the following states:

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

| State | Meaning |
|------|------|
| PENDING | Declared, but required dependencies are not ready |
| LOADING | Dependencies are ready and `apply` is running |
| ACTIVE | The plugin is running |
| FAILED | `apply` threw an error |
| UNLOADING | The plugin is unloading and disposing resources |
| DISPOSED | The plugin is fully unloaded |

## Dependency-driven loading

A plugin with `inject` waits for every required service before loading:

```ts ignore-check
export const inject = ['tools', 'llm']

export function apply(ctx: Context) {
  // ctx.tools and ctx.llm are ready here.
}
```

If a required service disappears, for example during provider replacement, the plugin unloads automatically (ACTIVE → DISPOSED) and loads again when the service returns.

## Automatic cleanup

Every registration made through `ctx` is undone when the plugin unloads:

```ts ignore-check
export function apply(ctx: Context) {
  // Event listener: removed automatically on unload.
  ctx.on('some-event', handler)

  // Custom resource: the returned disposer runs on unload.
  ctx.effect(() => {
    const connection = createConnection()
    return () => connection.close()
  })
}
```

The framework tracks and disposes all of these operations:
- `ctx.on(event, handler)` — event listener
- `ctx.tools.register(tool)` — tool registration
- `ctx.llm.registerAdapter(names, adapter)` — LLM adapter registration
- `ctx.effect(() => cleanup)` — custom resource

During unload, disposer invocation starts in reverse registration order, but multiple async disposers run concurrently and have no serial completion guarantee. Put order-dependent cleanup in one disposer returned from a single `ctx.effect()` and await its steps serially there.

## Nested contexts

`ctx.plugin()` creates a child Fiber that inherits the parent context but has an independent lifecycle:

```ts ignore-check
export function apply(ctx: Context) {
  // Register a child plugin.
  ctx.plugin(childPlugin)

  // The child has its own Fiber and unloads with its parent.
}
```

## Dispose semantics

To stop a plugin instance early:

```ts
import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
declare function myPlugin(ctx: Context): void

const fiber = ctx.plugin(myPlugin)

// Dispose it manually later.
await fiber.dispose()
```

`dispose` guarantees:
1. All registrations owned by the plugin are removed.
2. Child plugins are recursively unloaded.
3. The returned promise resolves after all asynchronous cleanup finishes.

## Hot replacement (HMR)

With `@deepseek-ai/dsh-hmr` loaded from `cordis.yml`, editing a plugin source file triggers:

1. Unload the old plugin and clean up its registrations.
2. Load the new code.
3. Run the new `apply`.

Because plugin registrations clean themselves up, hot replacement does not retain registrations from the old instance.

## Example lifecycle

```ts ignore-check
export function apply(ctx: Context) {
  console.log('plugin loading')

  ctx.effect(() => {
    console.log('effect registered')
    return () => console.log('effect cleaned up')
  })
}
```

Loading prints:
```
plugin loading
effect registered
```

Unloading prints:
```
effect cleaned up
```

## Next steps

- [Services and dependencies](./service.md) — expose a capability to other plugins
- [Event system](./events.md) — communicate between plugins
- [Cordis tutorial](../../../cordis-tutorial/index.md) — the same lifecycle, services, and events built step by step against the Cordis runtime
