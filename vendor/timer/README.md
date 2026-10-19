# @cordisjs/plugin-timer

Disposal-aware timer service for Cordis.

## Usage

```ts
import { Context } from 'cordis'
import Timer from '@cordisjs/plugin-timer'

const root = new Context()
await root.plugin(Timer)

const dispose = root.timeout(() => {
  root.logger.info('done')
}, 1000)

dispose()
```

Timer handles are registered on the current fiber, so they are cleared automatically when the plugin that created them is disposed.

## API

| API | Description |
| --- | --- |
| `ctx.timeout(callback, delay)` | Run once and return a disposer. |
| `ctx.timeout(delay)` | Return a promise that resolves after `delay`. |
| `ctx.interval(callback, delay)` | Run repeatedly and return a disposer. |
| `ctx.interval(delay)` | Return an async iterator that yields on each interval. |
| `ctx.throttle(callback, delay, noTrailing?)` | Return a throttled function with `.dispose()`. |
| `ctx.debounce(callback, delay)` | Return a debounced function with `.dispose()`. |

`ctx.setTimeout()` and `ctx.setInterval()` are kept as deprecated aliases for `ctx.timeout()` and `ctx.interval()`.

Concurrent `next()` calls on an interval iterator complete in request order, one per tick. Returning from or throwing into the iterator settles every pending read; disposing the owning fiber rejects every pending read. Ticks without a pending read are discarded.

Throttle and debounce wrappers return `void`, regardless of the callback return type. Calling `.dispose()` or disposing the owning fiber cancels pending work and makes later calls inert. `noTrailing` suppresses delayed throttle calls while retaining leading calls until disposal.
