# Event system

English | [中文](events.zh.md)

Events are the core communication mechanism between Cordis plugins. Harness uses them extensively for loosely coupled extension points.

## Basic use

### Listen for an event

```ts ignore-check
ctx.on('event-name', (payload) => {
  // Handle the event.
})
```

### Emit an event

```ts ignore-check
ctx.emit('event-name', payload)
```

## Event modes

Cordis provides several event modes for different interaction contracts.

### emit — broadcast

Every listener runs synchronously and return values are ignored:

```ts ignore-check
// Emit
ctx.emit('my-plugin/ready', { id: 'worker-1' })

// Listen
ctx.on('my-plugin/ready', ({ id }) => {
  console.log(`${id} is ready`)
})
```

### bail — short circuit

Listeners run in order; the first result other than `null`, `false`, or `undefined` becomes the final result:

```ts ignore-check
// Dispatch
const result = ctx.bail('some-check', input)

// Listen: a returned value stops later listeners.
ctx.on('some-check', (input) => {
  if (shouldBlock(input)) return 'blocked'
  // Return null, false, or undefined to continue to the next listener.
})
```

### serial — ordered execution

Listeners run in registration order and asynchronous results are awaited. The first result other than `null`, `false`, or `undefined` stops further execution:

```ts ignore-check
await ctx.serial('setup-phase', context)
```

### waterfall — pipeline

Each listener may wrap the downstream result to form a processing chain. A listener **must call `next()` to delegate downstream**; omitting the call short-circuits the pipeline:

```ts ignore-check
// Dispatch
const output = await ctx.waterfall('my-plugin/transform', input, async () => input)

// Listen: next() is mandatory.
ctx.on('my-plugin/transform', async (_input, next) => {
  const downstream = await next()
  return downstream.trim()
})
```

::: warning
A waterfall listener **must call `next()`**. Omitting it short-circuits the pipeline by design, enabling interception and gateway behavior.
:::

## Typed events

Harness uses TypeScript declaration merging for type-safe events:

```ts
import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/check': (input: string) => boolean | undefined
    'my-plugin/transform': (input: string, next: () => Promise<string>) => Promise<string>
  }
}

// ctx.on('my-plugin/ready', ...) and ctx.emit('my-plugin/ready', ...)
// are now inferred correctly.
```

## Cordis events and session records

Harness Cordis events use `namespace/action` names, including `agent/pre-step`, `agent/request-error`, `tools/result`, and `session/event`. The generated `cordis-surface` regions on the [subsystem pages](../../../subsystems/core.md) record complete signatures and modes.

`turn/*`, `step/*`, `tool/call`, `tool/result`, and `compaction/*` are durable session-event types, not same-named Cordis events. To observe them, listen to `session/event` and inspect `event.type`.

## Event listeners are effects

A listener registered with `ctx.on()` is removed automatically when its plugin unloads:

```ts ignore-check
export function apply(ctx: Context) {
  // This listener is removed when the plugin disposes.
  ctx.on('tools/result', handler)
}
```

## Example: logging plugin

This plugin logs tool calls and results:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-tools'

export const name = 'tool-logger'

export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    console.log(`[tool] ${exec.name}(${JSON.stringify(exec.arguments)})`)
    const text = result.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    console.log(`[tool result] ${text.slice(0, 100)}`)
  })
}
```

## Next steps

- [Capability layering](../practice/index.md) — understand events within capability interfaces
- [LLM adapters](../practice/llm-adapter.md) — implement a complete LLM backend
