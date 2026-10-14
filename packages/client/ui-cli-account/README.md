---
description: "Give a CLI app plugin's Plugins page its account section, title tag, activation prompt, confirmations, and notices, mirrored from the plugin's Host account Remote with copy the plugin translates."
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-cli-account

English | [中文](README.zh.md)

## Summary

CLI app plugins such as Feishu and WeCom build their Plugins page from these shared pieces. `CliAccountConnection` follows the plugin's account stream, opens an authorization link once in the browser that started the operation, and reports outcomes. The section, tag, activation prompt, confirmation, and notice components render one of six display phases with copy the plugin translates. The Web shell links this library statically and shares one copy through its module table, so plugins import it like `ui-primitives`. Each plugin keeps its own presentation and dictionary.

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

A plugin page imports this library, creates one connection over its Remote, maps the Host view to a display phase, and renders the shared components.

### When to choose it

Choose it for the page half of a plugin built on [`@deepseek-ai/dsh-cli-account`](../../connector/cli-account/README.md), whose Remote streams a `CliAccountView`. A plugin that connects a hosted service over MCP uses the MCP account surfaces instead.

### Import it

A plugin page imports `@deepseek-ai/dsh-client-ui-cli-account` and lists it in its `devDependencies`. The package is one of the Web shell's `PLATFORM_MODULES`, so a plugin bundle resolves the import against the shell's copy without `dsh.client.external`, and the client bundle purity gate rejects a bundle that inlines it instead. This package is a Web-shell build input: its static ESM keeps its CSS module for Vite, and it has no Loader row or configuration fields.

### Connection mirror

`new CliAccountConnection(ctx, { name, follow, cancel, notices })` opens the plugin's `follow` stream through `ctx.remote.$stream` and publishes a snapshot with the Host view, whether the stream is delivering or has stopped, whether a page action is pending, and the latest notice. `start(call)` runs one Remote start at a time and ignores clicks while one is pending; a rejected start or cancel reports the `action-failed` notice once. Each new link of an operation this browser started opens once in a new window, over HTTPS only. A successful operation this browser started reports the notice `notices` maps its kind to. A stream that fails for good marks the snapshot stopped, and `retry()` reopens it. `actions` binds `cancel`, `openAuthorization`, `retry`, and `dismissNotice` for a plugin's face.

### Shared dictionary keys

The components read these keys through the plugin's translator, so every plugin dictionary defines them and TypeScript rejects one that omits a key: `section.title`, `hint`, `close`, `action.cancel`, `action.connect`, `activation.title`, `activation.body`, `activation.later`, `failure.details` (with `{details}`), `failure.exitCode` (with `{code}`), `badge.<phase>` for every phase but `checking`, and `status.<phase>` for every phase but `connecting`. The notice also reads `notice.<kind>` for each kind the plugin maps and for `action-failed`.

### Components

| Component | Behavior |
|---|---|
| `CliAccountSection` | Title, status, buttons, detail, extra rows, failure, and hint; the status defaults to the phase's `status.*` copy. Buttons are disabled while a page action is pending or the Host stream is down, except while stopped so retry can reopen it. A failure shows the plugin's guidance, then the classified command, exit code, and allowlisted details |
| `CliAccountBadge` | The tag beside the title, only on the enabled bundle's own page and only once the phase settles |
| `CliAccountActivation` | The prompt after the bundle is switched on, open while disconnected; it dismisses itself once the phase settles elsewhere |
| `CliAccountConfirm` | A confirmation that closes before it confirms |
| `CliAccountToast` | The latest notice, with a warning icon for `action-failed` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) exports the mirror and the components and has no plugin entry. The Web shell seeds the package into its module table, so every plugin page shares one copy instead of inlining its own. The components receive translated text and display phases only; deriving the phase from a plugin's account states stays in the plugin.

| File | Role |
|---|---|
| [`src/connection.ts`](src/connection.ts) | The Host view mirror, link opening, notices, and pending-action guard |
| [`src/components.tsx`](src/components.tsx) | The shared components, display phases, and dictionary keys |
| [`src/index.ts`](src/index.ts) | The library entry the shell's module table serves |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CLI account library](../../connector/cli-account/README.md) — the Host half that streams the view.
- [Web shell](../web/README.md) — `PLATFORM_MODULES`, the shared module table that supplies this library.
- [Plugin manager page](../ui-plugin-manager/README.md) — the Plugins page and its bundle slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The six display phases are fixed; a plugin maps any further account state onto one of them.
- The shared dictionary keys are the same for every plugin; a plugin cannot rename them.
- The library registers no slots; each plugin registers its own section, tag, activation, and notice entries.
- The Web shell carries the library whether or not a CLI app plugin is installed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
