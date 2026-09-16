# 6. Composition and HMR

English | [中文](06-composition-and-hmr.zh.md)

Every capability built so far is a plugin, and `cordis.yml` selects the application's plugin tree. This chapter changes that composition, hot-reloads a plugin, and diagnoses a plugin that never loads.

## Entries are more than a name

A config entry accepts metadata beyond `name` and `config`:

```yaml
- id: greeter          # stable identity for this entry
  name: './greeter.ts'
- id: consumer
  name: './consumer.ts'
  disabled: true       # keep the entry, skip mounting it
```

`id` gives the entry a stable identity so the loader can tell an edit to an existing entry apart from a removal plus an addition. `disabled: true` unmounts a plugin without deleting its entry — flip it back and the plugin (and everything PENDING on its services) loads again.

Groups nest a sub-list of entries that load and unload as one unit, and `isolate` gives a group its own instance of a service name — two groups can each see a differently configured `shell` provider without affecting each other. The [Cordis primer](../cordis-primer.md) and the [service isolation example](../user/develop/framework/service.md#service-isolation) cover the details.

## Hot module replacement

Because unloading releases effects ([chapter 2](02-lifecycle-and-effects.md)) and loading follows dependencies ([chapter 3](03-services.md)), HMR can replace a running plugin by unloading and loading it. The `@deepseek-ai/dsh-hmr` plugin watches your files and does exactly that on save.

In `tmp/cordis-tutorial`, write `cordis.yml`:

```yaml
- id: logger
  name: '@deepseek-ai/cordis-plugin-logger-console'
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    root: ['.']
- id: hello
  name: './hello.ts'
```

Two support plugins joined the list: HMR logs through the Cordis logger service, so without a console exporter you would not see its messages, and it `inject`s the `timer` service for debouncing — without `@deepseek-ai/cordis-plugin-timer` it sits in PENDING forever, silently. That silence is the subject of the next section.

HMR reads Node's loader internals through the Loader's native helper. Run Cordis under tsx:

```sh
node --import tsx ../../vendor/cordis/bin.js
```

Now edit `hello.ts` — change the log message — and save:

```
hello from my first plugin
2026-07-22 15:44:36 [I] hmr watching [ '.' ]
2026-07-22 15:44:39 [I] hmr reload plugin at hello.ts
hello from my EDITED plugin
```

The old instance unloaded (all its effects unwound), the new code loaded, `apply` ran again. Stop the process with Ctrl-C. Editing `cordis.yml` itself is also picked up: the loader diffs entries by `id` and mounts, unmounts, or reconfigures only what changed. This is why the entries above carry explicit `id`s — an entry without one gets a generated id on every read, so after any config-file edit it counts as removed-plus-added and remounts even if its own lines did not change.

## Diagnosing a plugin that never loads

The flip side of dependency-driven loading: a plugin whose `inject` names a service nobody provides waits forever, printing nothing. No error — PENDING is a legitimate state, since the provider may be mounted later.

You can see the states directly. Every context can enumerate the plugin registry; create `diagnose.ts`:

```ts
import { FiberState, type Context } from '@deepseek-ai/cordis'

export const name = 'diagnose'

export function apply(ctx: Context) {
  setTimeout(() => {
    for (const runtime of ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (fiber.state === FiberState.PENDING) {
          console.log(`${fiber.name} is PENDING — a required service is missing`)
        }
      }
    }
  }, 500)
}
```

And a plugin with an unsatisfiable dependency, `needs-timer.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'needs-timer'
export const inject = ['timer']

export function apply(ctx: Context) {
  console.log('needs-timer loaded')
}
```

```yaml
- name: './needs-timer.ts'
- name: './diagnose.ts'
```

Run it (plain `node --import tsx ../../vendor/cordis/bin.js`; stop with Ctrl-C):

```
needs-timer is PENDING — a required service is missing
```

`inject: ['timer']` has no provider. Add `- name: '@deepseek-ai/cordis-plugin-timer'` to the list and the plugin loads. When a plugin does nothing and reports nothing, inspect its fiber state. Iterating without the PENDING filter also shows the loader's own plugins (Loader, Include) as ACTIVE fibers because plugins mount the config file itself.

Next: [Into the harness](07-into-the-harness.md) — the same patterns against real harness services.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
