---
description: "Show a CLI app plugin's account section, title tag, activation prompt, confirmations, and notices on the Plugins page through `ctx.cliAccounts`, following the plugin's Host account Remote with copy the plugin translates."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cli-account

English | [中文](README.zh.md)

## Summary

CLI app plugins such as Feishu and WeCom show their account on the Plugins page by registering it with `ctx.cliAccounts`. The registry follows the plugin's account stream, opens an authorization link once in the browser that started the operation, and renders the section, title tag, activation prompt, confirmations, and notices. Each plugin keeps its own Remote operations, presentation, and dictionary. The Web and Desktop compositions mount the registry through [`dsh-web-app`](../../bundle/web-app/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

A plugin's browser half registers its account once, with its Remote operations, its dictionary, and a presenter that maps the page snapshot to what the section shows.

### When to choose it

Choose it for the page half of a plugin built on [`@deepseek-ai/dsh-cli-account`](../../connector/cli-account/README.md), whose Remote streams a `CliAccountView`. A plugin that connects a hosted service over MCP uses the MCP account surfaces instead.

### Register an account

The plugin's browser half injects `locale` and `cliAccounts`, registers its dictionary, and registers its account for its own lifetime:

```ts ignore-check
export const inject = ['remote', 'locale', 'cliAccounts']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'acme: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.cliAccounts.register({
    packageName: '@acme/cli', locale: NS,
    follow: signal => ctx.remote.acme.follow(signal),
    cancel: id => ctx.remote.acme.cancel(id),
    notices: { connect: () => t('notice.connected') },
    present: (snapshot, page) => presentAccount(snapshot, page, t),
  }), 'acme: account')
}
```

`packageName` is the npm package whose bundle page carries the section and tag. `locale` names the plugin's dictionary namespace, which must translate every [shared key](#shared-dictionary-keys); TypeScript rejects a namespace that lacks one. `follow` and `cancel` call the plugin's Remote. `notices` maps an operation kind to the translated notice its success reports in the browser that started it; unlisted kinds report none. The plugin lists `@deepseek-ai/dsh-client-ui-cli-account` in `dsh.client.inject` and imports its types with `import type`. The returned disposer removes the surfaces and closes the account's Host stream. A registration whose package is already registered throws and leaves none of its surfaces behind.

### Present the section

`present(snapshot, page)` runs while a surface renders and returns a `CliAccountDisplay`: the phase, an optional status label, buttons, detail, extra rows, and failure, with every string translated. It reads only the snapshot, so translating through `ctx.locale.bind` follows a language switch. Button callbacks use `page`: `start(call)` runs one Remote start at a time, and `cancel`, `openAuthorization`, and `retry` act on the followed operation and the Host stream. The snapshot carries the Host view, whether the stream is delivering or has stopped, whether a page action is pending, and the latest notice.

| Surface | Behavior |
|---|---|
| Section | Title, status, buttons, detail, extra rows, failure, and hint; the status defaults to the phase's `status.*` copy, with `connecting` labelled as checking. Buttons are disabled while a page action is pending or the Host stream is down, except while stopped so retry can reopen it. A button with `confirm` asks first and runs only after the user accepts. A failure shows the plugin's guidance, then the classified command, exit code, and allowlisted details |
| Title tag | Shown only on the enabled bundle's page or one of its row pages, and only once the phase settles |
| Activation prompt | Open while the phase is `disconnected` after the bundle is switched on; Connect opens the bundle page and runs the section's first primary button that asks no confirmation. It dismisses itself once the phase settles elsewhere |
| Notice | The latest outcome, outside the Plugins panel's lifetime: the plugin's success copy, or the shared failure copy with a warning icon |

### Following operations

The page follows the operation its latest start returned, from that answer until the stream delivers the operation's result; each start attempt first drops the operation followed before, so a rejected start leaves none and reports the `action-failed` notice once. Clicks while a page action is pending are ignored. Each link the followed operation offers opens once in a new window, over HTTPS only, and a later operation that offers the same link opens it again. A result that a later operation replaces before the stream delivers it reports nothing. A stream that fails for good marks the snapshot stopped, and `retry` reopens it once, however often it is called. Removing the registration closes the stream; afterwards the page opens no link and reports no notice, while Host-owned operations keep running.

<a id="shared-dictionary-keys"></a>
### Shared dictionary keys

The surfaces read these keys from the plugin's namespace: `section.title`, `hint`, `close`, `action.cancel`, `action.connect`, `activation.title`, `activation.body`, `activation.later`, `failure.details` (with `{details}`), `failure.exitCode` (with `{code}`), `notice.action-failed`, `badge.<phase>` for every phase but `checking`, and `status.<phase>` for every phase but `connecting`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`register()` creates one `CliAccountConnection` per account. It mirrors the plugin's `follow` stream and keeps the Host view, whether the stream is delivering, whether a page action is pending, and the latest notice. The registration contributes `plugins.bundle.config` and `plugins.bundle.activation` keyed by the package name, a `plugins.detail.badge` entry with id `<package>.account`, and a `shell.overlay` notice with id `<package>.account-toast`. Each entry declares the plugin's namespace, so the renderer supplies its `t`, and all four inject one face that shares one snapshot and calls the plugin's presenter. The registration is one effect of this plugin's fiber: a setup failure disposes what it already added, and teardown removes the slot entries before closing the stream, whichever of the plugin's disposer and this plugin's unload runs first.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | The `ctx.cliAccounts` registry and the four slot registrations |
| [`src/client/types.ts`](src/client/types.ts) | Registration, display, snapshot, and dictionary types |
| [`src/client/connection.ts`](src/client/connection.ts) | The Host view mirror, link opening, notices, and pending-action guard |
| [`src/client/components.tsx`](src/client/components.tsx) | The surfaces and the slot entries that read the face |
| [`src/index.ts`](src/index.ts) | The empty Node half |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CLI account library](../../connector/cli-account/README.md) — the Host half that streams the view.
- [Plugin manager page](../ui-plugin-manager/README.md) — the Plugins page and its bundle slots.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the account surfaces are browser UI and add no model input. Each plugin documents the CLI and skills its account enables.

#### KV Cache effect

None; registering or removing an account changes no model-visible text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The six display phases are fixed; a plugin maps any further account state onto one of them.
- The shared dictionary keys are the same for every plugin; a plugin cannot rename them.
- Each account opens its own Host stream.
- The Web and Desktop compositions load the registry whether or not a CLI app plugin is installed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Client specs drive `CliAccountConnection` with a fake Remote stream, render the surfaces with a key-echo translator, and register accounts against a real slot registry.

</details>
