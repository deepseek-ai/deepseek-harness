---
description: "Connect Notion's hosted MCP server through the shared MCP manager, authorize it with OAuth, and use its tools in conversations."
kind: "package-bundle"
---

# @deepseek-ai/dsh-notion

English | [中文](README.zh.md)

## Summary

The Notion plugin registers Notion's hosted MCP server, `https://mcp.notion.com/mcp`, with the Host's shared [MCP manager](../../mcp/mcp-manager/README.md) for as long as the plugin is loaded. The user connects a Notion account from the plugin's page on the Web sidebar's **Plugins** page; afterwards every conversation on that Host can use the server's tools, and the model is told to call the integration the Notion plugin. The manager owns the connection, OAuth authorization, the saved grant, and sign-out; the page reads and drives them through the manager's Remote and adds no account interface of its own. It runs in the Web and Desktop compositions.

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

### Install into a profile

Install the package as a bundle, for example from the Web sidebar's **Plugins** page or with the CLI:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-notion
```

The bundle patch inserts the `notion` row after the profile's other layers. The plugin requires the `mcpServers` and `systemPrompt` services, which the Web and Desktop compositions provide through [`dsh-web-app`](../../bundle/web-app/README.md). In a profile without the MCP manager, such as `headless`, the plugin does not activate, and startup prints a warning that names the missing `mcpServers` service.

### Authorize and sign out

The plugin registers the server `notion` with the fixed OAuth credential key `mcp-client/notion`. Without a saved grant the server waits for authorization and exposes no Notion tools. With a saved grant the manager connects at startup and refreshes tokens as needed. Notion's tools load [on demand](../../mcp/mcp-client/README.md#on-demand-tool-loading) by default: the system prompt lists them, and each agent loads the ones it needs with `mcp__notion__load_tools`.

While the plugin is on, its page on the **Plugins** page shows a **Notion account** section, and a tag beside the title reads Not connected, Connecting, Connected, Reconnect, or Unavailable. Switching the plugin on from the list while no account is connected offers **Connect Notion**, which opens the plugin's page and starts authorization.

| Section state | Action |
|---|---|
| Not connected, or the grant expired, no longer matches the settings, was rejected, or lacks permissions | **Connect Notion** or **Connect again** starts an authorization attempt |
| Waiting for you to confirm in the browser | The browser that started the attempt opens Notion's authorization page once; **Open authorization page** opens it again, and **Cancel** ends the attempt |
| Connected | **Sign out** asks for confirmation, then deletes the local grant |
| Cannot connect right now | **Retry** restarts the server and keeps the existing grant |

Authorization must be completed in a browser on the Host machine. After the user approves access in Notion, the callback page says DSH received the authorization; the section then shows the result. Leaving the page does not cancel an attempt, which the Host owns. A failed attempt shows **Authorization was not completed. Try again.**; a failed page action shows a toast. Sign-out keeps the client registration and does not revoke the connection on Notion's side.

The page calls the manager's [OAuth operations](../../mcp/mcp-manager/README.md#oauth-authorization) through Remote: `watch` reports the entry, `startAuthorization('notion')` returns an attempt whose `authorizationUrl` the stream reports, `cancelAuthorization('notion', id)` cancels it, `signOut('notion')` deletes the grant, and `restart('notion')` retries. Other Remote clients can use the same operations.

### Turn off and uninstall

Turning the row off in Plugin Manager, or uninstalling the package, ends the registration: the Notion tools leave the model's tool set, and the saved grant stays in the credentials store, so reinstalling reuses it. To remove the grant, sign out while the plugin is loaded, or delete the `mcp-client/notion` record from `$DSH_HOME/.credentials.yaml` as the [local credentials provider](../../credentials/credentials-local/README.md) documents.

### Configure

| Field | Default | Meaning |
|---|---|---|
| `url` | `https://mcp.notion.com/mcp` | Streamable HTTP MCP endpoint of the Notion server |
| `toolLoading` | `on-demand` | `on-demand` keeps Notion's tools hidden from each agent until it loads them; `eager` sends every tool definition with every request |

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-notion) is the exhaustive source of supported fields. Connection and authorization budgets use the manager and mcp-client defaults. The saved grant is bound to `url`; changing it requires connecting the account again.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts one row with id `notion` naming this package, so the package is both the bundle and its only row; `config` overrides target that id. The Host half, [`src/index.ts`](src/index.ts), makes two registrations, both effects of the plugin's fiber: `ctx.mcpServers.register('notion', …)` adds a Streamable HTTP entry with the configured `url` and OAuth credential key, and `ctx.systemPrompt.section()` adds the naming guidance at the `MCP_SERVERS` order. The server name fixes the `mcp__notion__` tool namespace, and the credential key fixes the grant address, so a reloaded or reinstalled plugin reaches the same tools and grant. The manager validates the entry when it is registered; a configured or registered server that already uses the name or key makes the plugin fail to load before the guidance is added.

The browser half, [`src/client/index.ts`](src/client/index.ts), attaches to the `notion` row, so its registrations exist while that row is on. It registers the `notion` dictionary and calls `ctx.mcpAccounts.register({ server: 'notion', packageName: '@deepseek-ai/dsh-notion', locale: 'notion' })`; [`ui-mcp-account`](../../client/ui-mcp-account/README.md) then mirrors the `notion` entry and contributes the section, guidance, tag, and toast described above.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [MCP manager](../../mcp/mcp-manager/README.md) — registration lifetime, status, OAuth authorization, and sign-out.
- [MCP client](../../mcp/mcp-client/README.md) — connection, tool naming, OAuth grant refresh, and redaction.
- [MCP subsystem](../../../docs/subsystems/mcp.md) — how the MCP packages fit together.
- [Plugin Manager](../../boot/plugin-manager/README.md) — installation and enablement.
- [MCP account surfaces](../../client/ui-mcp-account/README.md) — the section, tag, guidance, and notices the browser half registers.
- [Plugins page](../../client/ui-plugin-manager/README.md#use-this-package) — the bundle page those surfaces occupy.

-----

<a id="model-experience"></a>
## Model Experience

### Naming and connection guidance

#### What the model sees

While the plugin is loaded, the system prompt contains the text below after the MCP server sections, whether or not Notion is authorized.

##### Guidance text

```markdown
Tools named `mcp__notion__*` come from the Notion plugin. In user-facing replies, call it the Notion plugin (Notion 插件 in Chinese), not MCP. If no `mcp__notion__*` tool appears in your tool list, Notion is not connected yet; ask the user to connect it on the Notion plugin page in Plugins.
```

#### Token effect

The two fixed sentences add about 70 tokens to every request while the plugin is loaded.

#### KV Cache effect

The sentence is prefix-stable: it changes only when the plugin loads or unloads, not when authorization or the connection changes.

### Notion server tools and instructions

#### What the model sees

After authorization, the model sees Notion's server instructions under `### MCP server: notion` and, with the default `toolLoading: on-demand`, the loader `mcp__notion__load_tools` and a [catalog of Notion's tools](../../mcp/mcp-client/README.md#model-experience) in the system prompt; each tool it loads then appears as `mcp__notion__<tool>` with Notion's description and input schema. With `eager`, every tool appears from the start, as the [MCP client](../../mcp/mcp-client/README.md#model-experience) documents. With `on-demand`, the loader and the catalog appear only once Notion is connected. While the plugin is loaded, including before authorization, the [shared resource tools](../../mcp/mcp-resources/README.md#model-experience) and their server-name prompt list `notion`.

#### Token effect

Notion's server defines the tool set and instructions, and their size can change without a DSH update. With `on-demand`, a connected Notion costs its instructions, the loader, and a catalog of about 6,400 characters for its 46 tools, plus the definitions an agent has loaded; with `eager`, all definitions, about 214,500 characters, repeat on every request.

#### KV Cache effect

Notion's instructions (or, with `eager`, its tools) appear when the connection succeeds and disappear when authorization is withdrawn or the plugin unloads; each change can invalidate reuse from the first changed token. With `on-demand`, the catalog changes only when Notion's tool list does, and each load changes the agent's next tool list, as the [MCP client](../../mcp/mcp-client/README.md#model-experience) documents. The shared resource tools stay unchanged across connection changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Notion account section exists only while the plugin is on. To sign out after turning the plugin off, turn it on again or delete the grant record.
- Only the Web and Desktop compositions mount the MCP manager; other profiles leave the plugin inactive.
- The authorization callback is `http://127.0.0.1:<port>` on the Host, so the browser that completes authorization must run on the Host machine. A Web Host reached from another machine cannot finish authorization.
- Desktop listens on an OS-assigned port for each launch. Authorizing again after a restart registers a new OAuth client and keeps the earlier registration record; saved grants refresh normally across restarts.
- Before the account is connected, the shared resource prompt still lists `notion` as a server name, and resource calls to it fail until the user connects.
- One Notion authorization serves the whole Host; there is no account or workspace picker.
- Turning the plugin off or uninstalling it keeps the local grant. Signing out deletes the local grant but leaves the connection authorized on Notion's side until the user removes it there.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Host specs run the plugin against the MCP manager and the mcp-client loopback OAuth server fixture; a client spec checks that the browser half registers the dictionary and account and removes both with the row. The `notion-plugin` session snapshot replays the Notion row without a saved grant, so it pins the naming guidance and verifies that no request reaches the server.

</details>
