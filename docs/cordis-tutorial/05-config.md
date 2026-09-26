# 5. Configuration

English | [中文](05-config.zh.md)

Each `cordis.yml` entry can carry a `config` block, and the plugin declares a schema that validates it before `apply` runs. Bad config fails the load with a precise error — the plugin never starts half-configured.

## A configurable plugin

Create `config-demo.ts` in `tmp/cordis-tutorial`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'config-demo'

export interface Config {
  greeting: string
  targets: string[]
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  targets: Schema.array(String).default(['world']),
})

export function apply(ctx: Context, config: Config) {
  for (const target of config.targets) {
    console.log(`${config.greeting}, ${target}!`)
  }
}
```

The exported `Config` is both a TypeScript interface and a runtime schema with the same name — consumers get the type, Cordis gets the validator. This repo uses [Schemastery](https://github.com/shigma/schemastery) for schemas; Cordis itself accepts any [Standard Schema](https://standardschema.dev/) validator, so a plain object exported as `Config` will not work.

Configure it:

```yaml
- name: './config-demo.ts'
  config:
    targets: ['alpha', 'beta']
```

Run:

```
Hello, alpha!
Hello, beta!
```

`greeting` was omitted, so the schema default filled it in — `apply` always receives complete, validated config.

## Fail loud

Now feed it something invalid:

```yaml
- name: './config-demo.ts'
  config:
    targets: 'not-an-array'
```

```
ValidationError: invalid config:
  - $.targets expected array but got not-an-array (at targets)
```

The plugin's fiber goes to FAILED, and this tutorial's launcher exits with status 1 after printing the error. A plugin should also reject schema-valid config that names an unavailable resource or provider as soon as it can resolve that reference.

<a id="volatile-fields"></a>
## Volatile fields

Use `.volatile()` for a field that the plugin reads during each operation. A change to that field updates its stable reference without remounting the plugin. Read it with `.get()`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  greeting: Schema.string().default('Hello').volatile(),
})

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
  ctx.on('loader/volatile-update', () => {
    console.log(config.greeting.get())
  })
}
```

A direct `Config(raw)` call also returns references. An optional field without a default still has a reference; `.get()` returns `undefined` when it is absent. Keep the reference, or capture its value for one operation, including across `await`. Do not retain that value for later operations. Object and array values are detached, recursively frozen snapshots of plain data; functions, class instances, and cycles are rejected.

Loader compares raw config while ignoring schema-declared volatile fields. A volatile-only change is parsed through the plugin’s `internal/config` hook and validated; when every ordinary effective value still matches, Loader commits the new values into the running references and emits one instance-local `loader/volatile-update` with the changed paths as arrays of keys, bypassing the target plugin’s `internal/update`. Equal values do not notify. An invalid candidate is logged and leaves the running references unchanged until the next activation. A changed ordinary effective value, including a changed expression result, and simultaneous ordinary-field changes retain the existing update flow, leaving old references unchanged and unnotified. Group/Include still dispatch child updates. Direct `fiber.update()`, code replacement, and dependency replacement retain their lifecycle; `noSave` still controls direct-update persistence. Notifications use ordinary `emit` without awaiting resource reconfiguration.

Declare volatile fields at fixed object paths, or mark an entire object or array volatile. Independent references inside arrays, dictionaries, union or intersect branches, lazy schemas, transforms, or another volatile value are rejected. Configuration files store ordinary values; `simplify()` unwraps references. Serialized schemas preserve their field types, defaults, roles, and volatile marker for schema-driven forms. Existing settings consumers continue to use their own settings interfaces.

## Computed config values

The loader used in this repo supports a `!!js` tag for config values that must be computed at load time:

```yaml
- name: './config-demo.ts'
  config:
    greeting: !!js process.env.DEMO_GREETING ?? 'Hello'
```

`!!js` works only inside `config` and in an entry's `disabled` field. `disabled: !!js ...` evaluates against the loader context at every mount decision (this repo's extension), so a row can gate itself on platform or environment; the other metadata (`name`, `id`, `inject`, ...) stays static, where an expression is ordinary truthy data. See [loader configuration](../cordis-primer.md#loader-configuration).

Next: [Composition and HMR](06-composition-and-hmr.md) — treating `cordis.yml` as the application.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
