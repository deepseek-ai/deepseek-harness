---
description: "Register a CLI app plugin's account on the Host with `ctx.cliAccounts` and show its section, title tag, activation prompt, confirmations, and notices on the Plugins page through one `cliAccounts` Remote, with the plugin's own text and the shared copy of this package."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cli-account

English | [中文](README.zh.md)

## Summary

CLI app plugins such as Feishu and WeCom register their account on the Host with `ctx.cliAccounts` to show it on the Plugins page. The registry serves every account through one `cliAccounts` Remote and starts or cancels only the operations each account lists. The browser half renders each account's section, title tag, activation prompt, confirmations, and notices, and opens an authorization link once in the browser that started the operation. Plugins supply their text as `LocalizedText`; the shared copy comes from this package's dictionary. The Web and Desktop compositions load both halves through [`dsh-web-app`](../../bundle/web-app/README.md).

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

A plugin's Host row registers its account once; the plugin ships no browser code for the account.

### When to choose it

Choose it for a plugin built on [`@deepseek-ai/dsh-cli-account`](../../connector/cli-account/README.md), whose vendor CLI keeps the account. A plugin that connects a hosted service over MCP uses the MCP account surfaces instead.

### Register an account

The plugin's Host row registers its `CliAccountRuntime` while the registry runs, so a composition without the registry, such as a headless profile, skips the registration:

```ts ignore-check
import type {} from '@deepseek-ai/dsh-client-ui-cli-account'

export function apply(ctx: Context): void {
  const account = new AcmeAccount(options)
  ctx.effect(() => () => account.dispose(), 'acme: account')
  ctx.inject(['cliAccounts'], (scope) => {
    scope.effect(() => scope.cliAccounts.register({
      packageName: '@acme/cli', source: account, copy,
      operations: [{ kind: 'check' }, { kind: 'connect', notice: { en: 'Acme connected', zh: 'Acme 已连接' } }],
      present: presentAccount,
    }), 'acme: Plugins page account')
  })
}
```

`packageName` is the npm package whose bundle page carries the section and tag; a second registration for the same package throws. `source` is the account, which `CliAccountRuntime` implements. `operations` lists the kinds a page button may start, each with the optional text its success reports in the browser that started it; the registry rejects any other kind. `copy` holds the section title, the hint under it, and the activation prompt's title, body, and Connect label. The plugin imports the registry's types with `import type`. The returned disposer withdraws the account from every page.

### Present the section

`present(view)` maps the account view to a `CliAccountDisplay`: the phase, the status line, the optional title tag, buttons, detail, notes, and failure. The registry calls it for every stream on each change, so it only maps the view. Every string is `LocalizedText`, which each browser resolves in its active language. A button carries a command: `start` with one of the registered operation kinds, `cancel` for the operation in progress while the Host marks it cancellable, or `open` to reopen its authorization link. A button with `confirm` asks first and runs only after the user accepts.

| Surface | Behavior |
|---|---|
| Section | Title, status, buttons, detail, notes, failure, and hint. Buttons are disabled while an action this browser started is pending or the Host stream is down. A failure shows the plugin's text, then the classified command, exit code, and the plugin's details |
| Title tag | The display's `badge`, shown only on the enabled bundle's page or one of its row pages, and only while the display has one |
| Activation prompt | Open while the phase is `disconnected` after the bundle is switched on; Connect opens the bundle page and runs the section's first primary button that asks no confirmation. It dismisses itself once the phase settles elsewhere |
| Notice | The latest outcome in this browser, outside the Plugins panel's lifetime: the operation's success text, or the shared failure copy with a warning icon |

### Following operations

Each browser opens one stream when the Web app loads, and the Host checks every account that runs no operation for each new stream; an account registered while a stream is open is checked at once. A browser follows the operation its latest start returned, from that answer until the stream delivers the operation's result; each start attempt first drops the operation followed before, so a rejected start leaves none and reports the failure notice once. Clicks while an action is pending are ignored. Each link the followed operation offers opens once in a new window, over HTTPS only. Other browsers show the same section but open no link and report no notice. A stream that fails for good shows the account service as not running with Retry, which reopens the stream once however often it is pressed. Unloading the browser half closes the stream; Host-owned operations keep running.

### Shared copy

The `cliAccount` dictionary holds the copy every account shares: Close, Cancel, Retry, Later, the diagnostic templates, the failure notice, and the not-running status, tag, and detail. Every other string comes from the plugin.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half, `CliAccounts`, is a Remote service. `register()` observes the account's source, and each `watch` stream reads every account's entry after each change, coalescing changes that arrive before the next read: the copy, `present(view)`, the operation in progress, and the latest result with its success text. `start` and `cancel` route by package to the account's source.

The browser half mounts the `cliAccounts` Remote and opens one `watch` stream through `CliAccountsConnection`, which keeps one snapshot store per account: the Host entry, whether the stream is delivering or has stopped, whether an action this browser started is pending, and the latest notice. For each account the Host reports, it registers `plugins.bundle.config` and `plugins.bundle.activation` keyed by the package name, a `plugins.detail.badge` entry with id `<package>.account`, and a `shell.overlay` notice with id `<package>.account-toast`, all under the `cliAccount` namespace and injecting one face. An account the Host drops loses its four entries, and unloading withdraws the entries and the stream before the Remote.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `ctx.cliAccounts` registry and its Remote |
| [`src/client/index.ts`](src/client/index.ts) | The browser entry bound to the generated Remote |
| [`src/client/mount.ts`](src/client/mount.ts) | The Remote mount, the dictionary, and the slot registrations of each account |
| [`src/client/connection.ts`](src/client/connection.ts) | The stream mirror, link opening, notices, and pending-action guard |
| [`src/client/components.tsx`](src/client/components.tsx) | The surfaces and the slot entries that read the face |
| [`src/client/locales.ts`](src/client/locales.ts) | The shared dictionary |
| [`src/client/types.ts`](src/client/types.ts) | Snapshot, notice, and face types |

The registration, display, and entry types live in [`@deepseek-ai/dsh-cli-account/types`](../../connector/cli-account/src/types.ts).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CLI account library](../../connector/cli-account/README.md) — the account runtime and the page types.
- [Plugin manager page](../ui-plugin-manager/README.md) — the Plugins page and its bundle slots.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the registry and its surfaces are Plugins page UI and add no model input. Each plugin documents the CLI and skills its account enables.

#### KV Cache effect

None; registering or removing an account changes no model-visible text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The five display phases are fixed; a plugin maps any further account state onto one of them.
- A plugin whose Host row fails to load shows no account section; the Plugins page still lists the bundle with its load failure.
- Each browser that loads the Web app starts a check of every idle account.
- The Web and Desktop compositions load the registry whether or not a CLI app plugin is installed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Host specs drive the registry with fake account sources. Client specs drive `CliAccountsConnection` with a fake Remote stream, render the surfaces with the Chinese dictionary, and mount the browser half against a real slot registry and locale runtime. Source coverage excludes `src/client/index.ts`, which imports the generated Remote that exists only in `lib/`.

</details>
