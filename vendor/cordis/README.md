# Cordis

Cordis is a TypeScript plugin framework for applications that need explicit
dependency injection, scoped services, lifecycle-managed cleanup, and optional
configuration-driven loading. The core package is published as `cordis`; the
official packages in this repository add a loader, config-file includes, HMR,
console logging, timers, and project scaffolding.

## Install

```sh
yarn add cordis
```

Cordis is ESM-first. The repository is tested on current Node releases, and the
scaffolder requires Node 22 or newer.

## Quick Start

```ts
import { Context, Service } from 'cordis'

declare module 'cordis' {
  interface Context {
    counter: Counter
  }

  interface Events {
    'app/ready'(message: string): void
  }
}

class Counter extends Service {
  value = 0

  constructor(ctx: Context) {
    super(ctx, 'counter')
  }

  next() {
    return ++this.value
  }
}

const greeter = Object.assign((ctx: Context) => {
  ctx.on('app/ready', (message) => {
    ctx.logger.info('%s #%d', message, ctx.counter.next())
  })
}, {
  inject: ['counter'],
})

const root = new Context()
await root.plugin(Counter)
await root.plugin(greeter)

root.emit('app/ready', 'started')
await root.fiber.dispose()
```

The important pieces are:

- `new Context()` creates the root dependency container.
- `ctx.plugin()` starts a plugin and returns a `Fiber`.
- `inject` tells Cordis which services must exist before the plugin runs.
- Effects, event listeners, and services are removed when their owning fiber is
  disposed.

## Documentation

- [Tutorial: build a plugin](../../docs/tutorials/build-a-plugin.md)
- [Guide: plugin lifecycle](../../docs/guides/plugin-lifecycle.md)
- [Guide: loader configuration](../../docs/guides/loader-config.md)
- [API reference](../../docs/api/core.md)

## Packages

| Package | Purpose |
| --- | --- |
| `cordis` | Core context, plugin registry, fiber lifecycle, events, services, and logger. |
| `create-cordis` | Interactive project scaffolder. |
| `@cordisjs/plugin-loader` | Runtime plugin tree and loader service. |
| `@cordisjs/plugin-include` | YAML/JSON config-file include support for the loader. |
| `@cordisjs/plugin-group` | Nested plugin groups for loader configs. |
| `@cordisjs/plugin-hmr` | Hot module replacement for loader-managed plugins. |
| `@cordisjs/plugin-logger-console` | Console exporter for the built-in logger. |
| `@cordisjs/plugin-timer` | Disposal-aware timeout, interval, throttle, and debounce helpers. |
| `@cordisjs/utils` | Shared utilities used by Cordis packages. |

## Development

```sh
yarn install
yarn build
yarn test
yarn lint
```

The monorepo uses Yakumo to build and test all packages. Most examples in the
docs use public APIs from `cordis`; loader examples additionally use
`@cordisjs/plugin-loader` and `@cordisjs/plugin-include`.

## Volatile configuration

Schemas may return `Volatile<T>` references, whose values are read through `.get()`. Cordis exports the consumer types; Loader commits volatile-only changes into the running references without restarting and notifies the owning fiber through `loader/volatile-update`. Direct `fiber.update()` retains its existing update waterfall and default restart.
