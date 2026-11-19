---
description: "Connect Tencent Docs' hosted MCP server through the shared MCP manager, authorize it with OAuth, and use its tools in conversations."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tencent-docs

English | [中文](README.zh.md)

## Summary

The Tencent Docs plugin registers Tencent Docs' hosted MCP server, `https://docs.qq.com/openapi/mcp`, with the Host's shared [MCP manager](../../mcp/mcp-manager/README.md) while the plugin is loaded. The user connects a Tencent Docs account from the plugin's page on the Web sidebar's **Plugins** page; afterwards every conversation on that Host can use the server's tools, and the model is told to call it the Tencent Docs plugin. The manager owns the connection, OAuth authorization, saved grant, and sign-out, which the shared [MCP account service](../../mcp/mcp-account/README.md) shows on the Plugins page. It runs in the Web and Desktop compositions.

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
dsh plugin --profile web add @deepseek-ai/dsh-tencent-docs
```

The bundle patch inserts the `tencent-docs` row after the profile's other layers. The plugin requires the `mcpManager` and `systemPrompt` services: the [base bundle](../../bundle/base/README.md) provides `systemPrompt`, and the Web and Desktop compositions add the MCP manager through [`dsh-web-app`](../../bundle/web-app/README.md). In a profile without the MCP manager, such as `headless`, the plugin does not activate, and startup prints a warning that names the missing `mcpManager` service.

### Authorize and sign out

The plugin registers the server `tencent-docs` with the fixed OAuth credential key `mcp-client/tencent-docs`. Without a saved grant the server waits for authorization and exposes no Tencent Docs tools. With a saved grant the manager connects at startup and refreshes tokens as needed. Tencent Docs' tools load [on demand](../../mcp/mcp-client/README.md#on-demand-tool-loading) by default: the system prompt lists them, and each agent loads the ones it needs with `mcp__tencent-docs__load_tools`.

While the plugin is on, its page on the **Plugins** page shows a **Tencent Docs account** section, and a tag beside the title reads Not connected, Connecting, Connected, Reconnect, or Unavailable. Switching the plugin on from the list while no account is connected offers **Connect Tencent Docs**, which opens the plugin's page and starts authorization.

| Section state | Action |
|---|---|
| Not connected, or the grant expired, no longer matches the settings, was rejected, or lacks permissions | **Connect Tencent Docs** or **Connect again** starts an authorization attempt |
| Waiting for you to confirm in the browser | The browser that started the attempt opens Tencent Docs' authorization page once; **Open authorization page** opens it again, and **Cancel** ends the attempt |
| Connected | **Sign out** asks for confirmation, then deletes the local grant |
| Cannot connect right now | **Retry** restarts the server and keeps the existing grant |

Authorization must be completed in a browser on the Host machine. After the user approves access in Tencent Docs, the callback page says DSH received the authorization; the section then shows the result. Leaving the page does not cancel an attempt, which the Host owns. A failed attempt shows **Authorization was not completed. Try again.**; a failed page action shows a toast. Sign-out keeps the client registration and does not revoke the tokens Tencent Docs issued.

The page follows the account through the [`connectorAccounts` Remote](../../client/ui-connector-account/README.md) under the key `mcp:tencent-docs`, and its buttons start `connect`, `sign-out`, or `retry` or cancel the attempt there. On the Host, [`dsh-mcp-account`](../../mcp/mcp-account/README.md) runs them through the manager's [OAuth operations](../../mcp/mcp-manager/README.md#oauth-authorization): `startAuthorization('tencent-docs')` returns an attempt whose `authorizationUrl` the stream reports, `cancelAuthorization('tencent-docs', id)` cancels it, `signOut('tencent-docs')` deletes the grant, and `restart('tencent-docs')` retries. Other Remote clients can use the same operations.

### Turn off and uninstall

Turning the row off in Plugin Manager, or uninstalling the package, ends the registration: the Tencent Docs tools leave the model's tool set, and the saved grant stays in the credentials store, so reinstalling reuses it. To remove the grant, sign out while the plugin is loaded, or delete the `mcp-client/tencent-docs` record from `$DSH_HOME/.credentials.yaml` as the [local credentials provider](../../credentials/credentials-local/README.md) documents.

### Configure

| Field | Default | Meaning |
|---|---|---|
| `url` | `https://docs.qq.com/openapi/mcp` | Streamable HTTP MCP endpoint of the Tencent Docs server |
| `toolLoading` | `on-demand` | `on-demand` keeps Tencent Docs' tools hidden from each agent until it loads them; `eager` sends every tool definition with every request |

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-tencent-docs) is the exhaustive source of supported fields. Connection and authorization budgets use the manager and mcp-client defaults. The saved grant is bound to `url`; changing it requires connecting the account again.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts one row with id `tencent-docs` naming this package, so the package is both the bundle and its only row; `config` overrides target that id. The Host half, [`src/index.ts`](src/index.ts), makes two registrations, both effects of the plugin's fiber: `ctx.mcpManager.register('tencent-docs', …)` adds a Streamable HTTP entry with the configured `url` and OAuth credential key, and `ctx.systemPrompt.section()` adds the naming guidance at the `MCP_SERVERS` order. The server name fixes the `mcp__tencent-docs__` tool namespace, and the credential key fixes the grant address, so a reloaded or reinstalled plugin reaches the same tools and grant. The manager validates the entry when it is registered; a configured or registered server that already uses the name or key makes the plugin fail to load before the guidance is added. The entry sets no `scope`, so authorization requests the `docs:read docs:write docs:manage` scopes listed in the protected-resource metadata that Tencent Docs' 401 challenge names, and the authorization page keeps the `authType=2` query of Tencent Docs' authorization endpoint.

While the account registry runs, the plugin also calls `ctx.mcpAccounts.register({ server: 'tencent-docs', packageName: '@deepseek-ai/dsh-tencent-docs', copy })`, where [`src/locales.ts`](src/locales.ts) holds the text that names Tencent Docs in every shipped language; [`dsh-mcp-account`](../../mcp/mcp-account/README.md) then registers the account with the connector account registry, which renders the section, guidance, tag, and toast described above. A composition without the registry, such as a headless profile, loads the plugin without the account section.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [MCP manager](../../mcp/mcp-manager/README.md) — registration lifetime, status, OAuth authorization, and sign-out.
- [MCP client](../../mcp/mcp-client/README.md) — connection, tool naming, OAuth grant refresh, and redaction.
- [MCP subsystem](../../../docs/subsystems/mcp.md) — how the MCP packages fit together.
- [Plugin Manager](../../boot/plugin-manager/README.md) — installation and enablement.
- [MCP account service](../../mcp/mcp-account/README.md) — how the manager's status and authorization map to the account section.
- [Connector account surfaces](../../client/ui-connector-account/README.md) — the section, tag, guidance, and notices the account registration shows.
- [Plugins page](../../client/ui-plugin-manager/README.md#use-this-package) — the bundle page those surfaces occupy.

-----

<a id="model-experience"></a>
## Model Experience

### Naming and connection guidance

#### What the model sees

While the plugin is loaded, the system prompt contains the text below after the MCP server sections, whether or not Tencent Docs is authorized.

##### Guidance text

```markdown
Tools named `mcp__tencent-docs__*` come from the Tencent Docs plugin. In user-facing replies, call it the Tencent Docs plugin (腾讯文档插件 in Chinese), not MCP. If no `mcp__tencent-docs__*` tool appears in your tool list, Tencent Docs is not connected yet; ask the user to connect it on the Tencent Docs plugin page in Plugins.
```

#### Token effect

The three fixed sentences add about 80 tokens to every request while the plugin is loaded.

#### KV Cache effect

The guidance is prefix-stable: it changes only when the plugin loads or unloads, not when authorization or the connection changes.

### Tencent Docs server tools and instructions

#### What the model sees

After authorization, the model sees Tencent Docs' server instructions under `### MCP server: tencent-docs` and, with the default `toolLoading: on-demand`, the loader `mcp__tencent-docs__load_tools` and a [catalog of Tencent Docs' tools](../../mcp/mcp-client/README.md#model-experience) in the system prompt; each tool it loads then appears as `mcp__tencent-docs__<tool>` with Tencent Docs' description and input schema. Many Tencent Docs tool names contain a dot, such as `doc.create_with_markdown`; the catalog lists them unchanged, and their loaded names replace the dot and add a hash suffix, such as `mcp__tencent-docs__doc_create_with_markdown_ff0986999909`, as the [MCP client](../../mcp/mcp-client/README.md#model-experience) documents. With `eager`, every tool appears from the start, as the [MCP client](../../mcp/mcp-client/README.md#model-experience) documents. With `on-demand`, the loader and the catalog appear only once Tencent Docs is connected. While the plugin is loaded, including before authorization, the [shared resource tools](../../mcp/mcp-resources/README.md#model-experience) and their server-name prompt list `tencent-docs`.

#### Token effect

Tencent Docs' server defines the tool set and instructions, and their size can change without a DSH update. With `on-demand`, a connected Tencent Docs costs about 3,000 characters of instructions, the loader, and a catalog of about 37,900 characters for its 225 tools, plus the definitions an agent has loaded; with `eager`, all 225 definitions repeat on every request.

#### KV Cache effect

Tencent Docs' instructions (or, with `eager`, its tools) appear when the connection succeeds and disappear when authorization is withdrawn or the plugin unloads; each change can invalidate reuse from the first changed token. With `on-demand`, the catalog changes only when Tencent Docs' tool list does, and each load changes the agent's next tool list, as the [MCP client](../../mcp/mcp-client/README.md#model-experience) documents. The shared resource tools stay unchanged across connection changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Tencent Docs account section exists only while the plugin is on. To sign out after turning the plugin off, turn it on again or delete the grant record.
- Only the Web and Desktop compositions mount the MCP manager; other profiles leave the plugin inactive.
- The authorization callback is `http://127.0.0.1:<port>` on the Host, so the browser that completes authorization must run on the Host machine. A Web Host reached from another machine cannot finish authorization.
- Desktop listens on an OS-assigned port for each launch. Authorizing again after a restart registers a new OAuth client and keeps the earlier registration record; saved grants refresh normally across restarts.
- Before the account is connected, the shared resource prompt still lists `tencent-docs` as a server name, and resource calls to it fail until the user connects.
- One Tencent Docs authorization serves the whole Host; there is no account or workspace picker.
- Turning the plugin off or uninstalling it keeps the local grant. Signing out deletes the local grant, but DSH does not revoke the tokens Tencent Docs issued; Tencent Docs' authorization server publishes no revocation endpoint.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Host specs run the plugin against the MCP manager and the mcp-client loopback OAuth server fixture; another checks that the account registry serves the Tencent Docs account with its text and withdraws it with the plugin. The `tencent-docs-plugin` session snapshot replays the Tencent Docs row without a saved grant, so it pins the naming guidance and verifies that no request reaches the server. The Web e2e fixture follows the hosted metadata layout: the challenge names resource metadata under the MCP path, that metadata lists the `docs:*` scopes, and the authorization endpoint carries its own query.

</details>
