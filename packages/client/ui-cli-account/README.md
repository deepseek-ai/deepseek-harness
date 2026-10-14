---
description: "Give a CLI app plugin's Plugins page its account section, title tag, activation prompt, confirmations, and notices, mirrored from the plugin's Host account Remote with copy the plugin translates."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cli-account

English | [中文](README.zh.md)

## Summary

CLI app plugins such as Feishu and WeCom build their Plugins page from these shared pieces. `CliAccountConnection` follows the plugin's account stream, opens an authorization link once in the browser that started the operation, and reports outcomes. The section, tag, activation prompt, confirmation, and notice components render one of six display phases with copy the plugin translates. The web app mounts this row once, and plugins import it from the module table. Each plugin keeps its own presentation and dictionary.

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

A plugin page requests this module, creates one connection over its Remote, maps the Host view to a display phase, and renders the shared components.

### When to choose it

Choose it for the page half of a plugin built on [`@deepseek-ai/dsh-cli-account`](../../connector/cli-account/README.md), whose Remote streams a `CliAccountView`. A plugin that connects a hosted service over MCP uses the MCP account surfaces instead.

### Minimal configuration

The web app bundle mounts the row once; plugins never add it:

```yaml
- id: ui-cli-account
  name: '@deepseek-ai/dsh-client-ui-cli-account'
```

A plugin page requests the module in its `package.json` and imports it from `@deepseek-ai/dsh-client-ui-cli-account/client`; the client bundle purity gate rejects a plugin bundle that inlines it instead:

```json
{ "dsh": { "client": { "platform": "web", "external": ["@deepseek-ai/dsh-client-ui-cli-account/client"] } } }
```

The row has no configuration fields.

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

The row's client entry exports the mirror and the components; its `apply` does nothing, and its Host entry is an empty marker. Plugins request the client entry as a module-table row, so every plugin page shares one copy instead of inlining its own. The components receive translated text and display phases only; deriving the phase from a plugin's account states stays in the plugin.

| File | Role |
|---|---|
| [`src/client/connection.ts`](src/client/connection.ts) | The Host view mirror, link opening, notices, and pending-action guard |
| [`src/client/components.tsx`](src/client/components.tsx) | The shared components, display phases, and dictionary keys |
| [`src/client/index.ts`](src/client/index.ts) | The client entry the module table serves |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CLI account library](../../connector/cli-account/README.md) — the Host half that streams the view.
- [Client modules](../../../docs/subsystems/client-modules.md) — module-table rows and `dsh.client.external` requests.
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
- The row registers no slots; each plugin registers its own section, tag, activation, and notice entries.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
