# Cookbook: live configuration forms

English | [中文](adding-a-settings-card.zh.md)

Declare live fields in the plugin Config schema and expose them through a product-owned settings card. The exported `Config` interface describes the values received by the plugin, including each `Volatile<T>` reference.

## 1. Declare live fields

```ts
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  endpoint: Volatile<string | undefined>
  retries: Volatile<number>
}

export const Config = z.object({
  endpoint: z.string().volatile(),
  retries: z.number().step(1).min(0).default(3).volatile(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.on('loader/volatile-update', () => {
    ctx.logger.info('Retry limit: %d', config.retries.get())
  })
}
```

Read `.get()` when starting an operation. A request that needs a consistent snapshot captures its values once. Use `.check()` for cross-field Config validation; these checks run on the Host before persistence and are omitted from serialized form schemas.

## 2. Compose the plugin

Give each instance a unique profile entry id. The base bundle mounts settings and config-editor. For custom profiles, see their package READMEs before mounting the same services.

`role('secret')` keeps a value out of form responses. Use credential references for values managed by the credentials domain. Ordinary fields stay out of the settings schema.

## 3. Verify editing

Change a field in Plugins and save. Verify the profile patch, the next consumer operation, unchanged plugin instance identity, and restoration after restart. Reject an invalid value and verify that neither the file nor the live value changed.

Custom plugin pages receive `form.state` and `form.mutate(operations, expectedRevision)` from the Plugins page owner. The Host validates full Config and applies edits through ConfigEditor and volatile HMR. The [plugin settings package](../../packages/client/ui-settings-plugins/README.md) owns the existing card examples.

## 4. Contribute to another plugin's page

A plugin with something to say about a bundle, a row, or an official plugin it does not own registers into `plugins.detail.actions` (a control at the head of the page), `plugins.detail.badge` (a tag beside the title), or `plugins.detail.section` (a section under the page's own content). Every entry is rendered with the page's `subject` — `{ kind: 'bundle', pkg }`, `{ kind: 'row', pkg, row }`, or `{ kind: 'item', id }` — and returns null for a subject it has nothing for:

```tsx ignore-check
ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
  name: 'plugins.detail.badge',
  id: 'acme-update',
  locale: 'acmeUpdate',
}, ({ t, subject }) => subject.kind === 'bundle' && hasUpdate(subject.pkg) ? <Tag tone="info">{t('update')}</Tag> : null))
```

## 5. Where the browser half rides

The browser half is served to the page by the [client module system](../../packages/client/modules), which scans the enabled Loader entries for packages declaring `dsh.client` and serves each one's built `./client` export — but it attaches a package's half to the Loader row whose specifier is the bare package name. A row mounted from a subpath export never carries a half, so a bundle that splits one package into several rows keeps its half on the root row, and every page it registers goes away when that row is switched off. A sub-plugin whose page must outlive the other rows ships as its own package.

The built `./client` file must be in the client module system's lazy-CJS factory format: one script that registers the package name and a `factory(require)` with the page's module loader, described in the [client module system's README](../../packages/client/modules/README.md). The `clientBundle` tsdown preset that emits it lives in `packages/client/tsdown.client.ts` rather than in a published package, so a package outside this repository reproduces that build itself.

```jsonc
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] } }
}
```

A companion package for a built-in namespace is the same browser half in a client-only package with an empty Host `apply`, listed in the web composition's plugin roster ([`packages/bundle/web-app/cordis.patch.yml`](../../packages/bundle/web-app/cordis.patch.yml)) and registering into `plugins.item` through `ctx.configForms.whileServed`, so the page exists exactly while the Host serves the namespace.
