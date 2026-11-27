---
description: "Register a connector plugin's account on the Host with `ctx.connectorAccounts` and show its section, title tag, activation prompt, confirmations, and notices on the Plugins page through one `connectorAccounts` Remote, with the registrant's own text and the shared copy of this package."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-connector-account

English | [中文](README.zh.md)

## Summary

Connector plugins register their account on the Host with `ctx.connectorAccounts` to show it on the Plugins page: CLI app plugins register the account their vendor CLI keeps, and MCP connectors their OAuth server's account. The Host decides what the page shows and does: each registrant maps its account to a display, and the registry starts or cancels only the operations the account lists. The browser half renders each bundle's section, title tag, and activation prompt, and opens authorization pages and reports notices only in the browser that started the operation. The Web and Desktop compositions load both halves through [`dsh-web-app`](../../bundle/web-app/README.md).

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

A registrant's Host row registers its account once; the registrant ships no browser code for the account.

### Register an account

The registrant's Host row registers its account source while the registry runs, so a composition without the registry, such as a headless profile, skips the registration:

```ts ignore-check
import type {} from '@deepseek-ai/dsh-client-ui-connector-account'

export function apply(ctx: Context): void {
  const account = new AcmeAccount(options)
  ctx.effect(() => () => account.dispose(), 'acme: account')
  ctx.inject(['connectorAccounts'], (scope) => {
    scope.effect(() => scope.connectorAccounts.register({
      key: '@acme/cli', packageName: '@acme/cli', source: account, copy,
      operations: [{ kind: 'check' }, { kind: 'connect', notice: { en: 'Acme connected', zh: 'Acme 已连接' } }],
      present: presentAccount,
    }), 'acme: Plugins page account')
  })
}
```

- `key` identifies the account in the Remote; the page passes it back to start and cancel operations. A second registration with the same key throws.
- `packageName` is the npm package whose bundle page carries the section and tag; a package carries at most one account. An account without one, such as the account of an MCP server row, appears on no bundle page.
- `source` is the account: its current view, change observation, a check, and starting and cancelling operations.
- `operations` lists the kinds a page button may start, each with the optional text its success reports in the browser that started it; the registry rejects any other kind.
- `copy` holds the section title, the hint under it, and the activation prompt's title, body, and Connect label.

The registrant imports the registry's types with `import type` from the package root or `./types`. The returned disposer withdraws the account from every page.

### Present the section

`present(view)` maps the account view to a `ConnectorAccountDisplay`: the phase, the status line, the optional title tag, buttons, the operation Connect starts in the activation prompt, detail, notes, and failure with its untranslated diagnostic items. The registry calls it for every stream on each change, so it only maps the view. Every string is `LocalizedText`, which each browser resolves in its active language. A button carries a command: `start` with one of the registered operation kinds, `cancel` for the operation in progress, which the source ignores in a phase that is not cancellable, or `open` to reopen its authorization page. A button with `confirm` asks first and runs only after the user accepts.

| Surface | Behavior |
|---|---|
| Section | Title, status, buttons, detail, notes, failure, and hint. Buttons, including a confirmation's, are disabled while a call the section made is pending or the Host stream is down. A failure shows the registrant's text, then its diagnostic items |
| Title tag | The display's `badge`, shown only on the enabled bundle's page or one of its row pages, and only while the display has one |
| Activation prompt | Open while the phase is `disconnected` after the bundle is switched on; Connect opens the bundle page and starts the display's `connect` operation, if it names one, and is disabled while the Host stream is down. It waits while the account is checking or connecting and dismisses itself once the account is connected or unavailable |
| Notice | The latest outcome in this browser, outside the Plugins panel's lifetime: the operation's success text, or the shared failure copy with a warning icon |

An account without a package, or a surface outside the bundle page, renders the `connector.account` Factory with `{ account, presentation }`: `section` shows the account's whole section, and `status` only its state dot and status line, as in a list row. It renders nothing until the Host lists the account. The [Connectors tab](../../experimental/client-ui-connectors/README.md) uses it for MCP server rows that use OAuth.

### Following operations

Each browser opens one stream when the Web app loads, and the Host checks every account that runs no operation for each new stream; an account registered while a stream is open is checked at once. A browser follows the operation its latest start returned, from that answer until the stream delivers the operation's result. Each page the followed operation offers opens once in a new tab, over HTTPS or over HTTP on a loopback address; other browsers show the same section but open no page and report no notice. A second click before the first call answers starts nothing. The stream reconnects after a lost connection; when it fails for good, the sections keep the last accounts with their buttons disabled until the page reloads. Unloading the browser half closes the stream; Host-owned operations keep running.

### Shared copy

The `connectorAccount` dictionary holds the copy every account shares: Close, Cancel, Later, the diagnostic label, and the failure notice. Every other string comes from the registrant.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half, `ConnectorAccounts`, is a Remote service. `register()` observes the account's source, and each `watch` stream reads every account's entry after each change, coalescing changes that arrive before the next read: the key and package, the copy, `present(view)`, the operation in progress, and the latest result with its success text. `start` and `cancel` route by key to the account's source.

[`dsh-api-remotes`](../../api/remotes/README.md) mounts the generated `connectorAccounts` Remote. The browser half opens one `watch` stream through `BrowserAccounts`, whose one store holds the Host's accounts by key, whether the stream is delivering, and the latest notice; it also remembers the operations this browser started. It registers one `plugins.detail.badge` entry and one `shell.overlay` notice for the page, and for each account with a package, `plugins.bundle.config` and `plugins.bundle.activation` keyed by the package name, all under the `connectorAccount` namespace, and the `connector.account` Factory with the same face. The surfaces receive `start` and `cancel` callbacks that call the Remote and return its result; the buttons report the operation of a successful start to `BrowserAccounts`, and a failed result or a rejected call as the failure notice. An account the Host drops loses its bundle entries, and unloading withdraws every entry and the stream.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `ctx.connectorAccounts` registry and its Remote |
| [`src/types.ts`](src/types.ts) | Registration, source, view, display, and entry types |
| [`src/client/index.ts`](src/client/index.ts) | The browser entry: the dictionary and the slot registrations |
| [`src/client/state.ts`](src/client/state.ts) | The stream store, the operations this browser started, and their pages and notices |
| [`src/client/components.tsx`](src/client/components.tsx) | The slot entries of each surface and the buttons' Remote calls |
| [`src/client/locales.ts`](src/client/locales.ts) | The shared dictionary |
| [`src/client/types.ts`](src/client/types.ts) | Browser state, notice, and face types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Plugin manager page](../ui-plugin-manager/README.md) — the Plugins page and its bundle slots.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the registry and its surfaces are Plugins page UI and add no model input. Each registrant documents the tools and skills its account enables.

#### KV Cache effect

None; registering or removing an account changes no model-visible text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The five display phases are fixed; a registrant maps any further account state onto one of them.
- A registrant whose Host row fails to load shows no account section; the Plugins page still lists the bundle with its load failure.
- Each browser that loads the Web app starts a check of every idle account.
- The Web and Desktop compositions load the registry whether or not a connector plugin is installed.
- An authorization page that opens after the call answers can be blocked by the browser; the section's open button shows it again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Host specs drive the registry with fake account sources. Client specs drive `BrowserAccounts` with a fake Remote stream, render the surfaces with the Chinese dictionary and a fake Remote, and mount the browser half against a real slot registry and locale runtime.

</details>
