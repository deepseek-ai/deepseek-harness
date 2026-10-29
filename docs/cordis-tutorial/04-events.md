# 4. Events

English | [中文](04-events.zh.md)

Services support direct calls; **events** let a plugin announce something without knowing which plugins listen. The harness uses events for interactions such as tool results, model requests, and approval decisions.

## Declare, emit, listen

Create `stats.ts` in `tmp/cordis-tutorial` — a service that counts things and announces each change:

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    stats: StatsService
  }
  interface Events {
    'stats/report'(name: string, count: number): void
  }
}

export class StatsService extends Service {
  private counts = new Map<string, number>()

  constructor(ctx: Context) {
    super(ctx, 'stats')
  }

  bump(name: string) {
    const next = (this.counts.get(name) ?? 0) + 1
    this.counts.set(name, next)
    this.ctx.emit('stats/report', name, next)
  }
}

export const name = 'stats'

export function apply(ctx: Context) {
  ctx.plugin(StatsService)
}
```

The `interface Events` merge is the event-system twin of the `interface Context` merge from chapter 3: it declares the event name and its listener signature, so `ctx.emit` and `ctx.on` are fully typed. The `namespace/action` naming convention keeps the flat event namespace readable.

Create `reporter.ts`:

```ts ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type {} from './stats.ts'

export const name = 'reporter'
export const inject = ['stats']

export function apply(ctx: Context) {
  ctx.on('stats/report', (name, count) => {
    console.log(`[stats] ${name} -> ${count}`)
  })
  ctx.stats.bump('tool_call')
  ctx.stats.bump('tool_call')
  ctx.stats.bump('prompt')
}
```

The `import type {} from './stats.ts'` line imports nothing at runtime; it exists so TypeScript sees the declaration merges. Compose and run:

```yaml
- name: './stats.ts'
- name: './reporter.ts'
```

```
[stats] tool_call -> 1
[stats] tool_call -> 2
[stats] prompt -> 1
```

Because `ctx.on()` is an effect, the listener disappears with the plugin — no manual `removeListener` bookkeeping, ever.

## Dispatch modes

`emit` is one of five dispatch modes. Which one an event uses is part of its contract — it decides whether listeners can return values, run concurrently, or short-circuit each other:

| Mode | Call | Semantics |
|---|---|---|
| emit | `ctx.emit(name, ...args)` | Synchronous broadcast; returned promises and values are not awaited or collected. |
| parallel | `await ctx.parallel(name, ...args)` | All listeners run concurrently; awaited together. |
| serial | `await ctx.serial(name, ...args)` | Listeners run in order, awaited; the first non-`null`/`false`/`undefined` return wins and stops the rest. |
| bail | `ctx.bail(name, ...args)` | Synchronous version of serial. |
| waterfall | `ctx.waterfall(name, ...args, next)` | Around-middleware; see below. |

Every harness event documents its mode in the generated reference on its owning [subsystem page](../subsystems/core.md).

## Waterfall: transform or short-circuit

Waterfall is the mode that powers interception. Each listener receives the arguments plus a `next()` continuation; it can transform what `next()` returns, or return without calling `next()` and short-circuit the rest of the chain — what the Cordis docs call the veto. Create `waterfall-demo.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'demo/transform'(input: string, next: () => Promise<string>): Promise<string>
  }
}

export const name = 'waterfall-demo'

export function apply(ctx: Context) {
  // Listener 1: wrap the downstream result.
  ctx.on('demo/transform', async (input, next) => {
    const downstream = await next()
    return downstream.toUpperCase()
  })

  // Listener 2: short-circuit when it owns the decision.
  ctx.on('demo/transform', async (input, next) => {
    if (input.includes('blocked')) return '** blocked **'
    return next()
  })

  void (async () => {
    console.log(await ctx.waterfall('demo/transform', 'hello', async () => 'hello'))
    console.log(await ctx.waterfall('demo/transform', 'blocked words', async () => 'blocked words'))
  })()
}
```

Point `cordis.yml` at just this file and run:

```
HELLO
** BLOCKED **
```

Walk through the second line: listener 1 runs first, calls `next()`, which invokes listener 2; listener 2 sees `blocked` and returns without calling `next()` — the innermost default (the function passed to `ctx.waterfall`) never runs — and listener 1 uppercases the replacement message on the way out.

The discipline that follows: **a waterfall listener that only observes or annotates must call `next()`**; returning without it is a deliberate short-circuit. Forgetting `next()` in a logging listener silently swallows the default behavior for everyone downstream. It is a standing rule of this repository ([waterfall semantics](../cordis-primer.md#cordis-waterfall-semantics)).

The harness uses waterfalls for decisions that cooperating plugins may wrap or answer: [`agent/pre-step`](../subsystems/core.md#agentpre-step--waterfall) lets a plugin reject a proposed step or replace its input, and [`approval/request`](../subsystems/approval.md#approvalrequest--waterfall) lets a policy answer instead of the user.

Next: [Configuration](05-config.md) — plugin options from `cordis.yml`.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
