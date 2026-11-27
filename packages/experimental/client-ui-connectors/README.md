---
description: "Enable the Connectors tab of the Plugins page to list, install, and open the official connectors and manage custom MCP servers."
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-connectors

English | [中文](README.zh.md)

## Summary

Enable Connectors to add a Connectors tab beside Installed on the Web or Desktop Plugins page. The tab lists the official connectors with their brand icons, installs a missing one at the running DSH version, switches an installed one on or off, and opens its page, where its account is connected. Below them, it lists, adds, edits, tests, and removes custom MCP servers and shows an OAuth server's account. Custom servers are the profile's MCP server rows and keep running while the bundle is off. Shipped profiles leave the bundle disabled, and the Plugins page lists it under Experimental plugins.

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

Open **Plugins** and switch on **Connectors** under **Experimental plugins**. Alternatively, add `@deepseek-ai/dsh-client-ui-connectors` to `dsh.profile.bundles` in the target [profile](../../boot/app-boot/README.md#profiles)'s `package.json`. The Connectors tab then appears beside Installed; switching the bundle off removes the tab.

Each row shows the connector's brand icon, title, and description in the interface language. A connector the profile does not hold shows **Install**, which opens the Plugins install dialog at its check screen with the connector's package at the running DSH version; the dialog offers **Enable now** once the installation finishes. A build that carries no DSH version shows no Install. An installed connector shows a switch that is on while the connector is enabled; the switch enables or disables the connector, as the switch on its Installed card does. The rest of the row opens the connector's page, and that page's Back button returns to the tab. When the Host does not apply a change, a line under the heading names the connector, and the switch shows the state the Host reports. Installed connectors keep their cards and switches on the Installed tab and run whether or not this bundle is enabled.

The custom servers section appears below the official connectors when the profile runs the [MCP manager](../../mcp/mcp-manager/README.md), the [configuration editor](../../boot/config-editor/README.md), the [plugin manager](../../boot/plugin-manager/README.md), and a credentials provider. It lists every MCP server row of the profile's composition, whether the profile patch or another layer, such as a bundle, adds the row, and whether the row is switched on or off. A server that a connector registers has no row and is not listed. Each row shows the default plugin icon, the server's name, URL or command, and switch. A server that is on and uses OAuth also shows its account status, and a server that is switched on but did not start shows the reason. A row the form cannot read shows **Unrecognized entry** and can be neither opened nor switched: its config has no `serverName`, names a transport other than `stdio` and `streamable-http`, or holds a `!!js` expression.

**Add MCP server** appears with the section, at the end of the **Official connectors** heading's row at the top of the tab. It and a row's **Settings** open the server's page, which replaces the Plugins page's title and tabs along with the tab's lists; the **Connectors** crumb above it returns to the lists without saving. The page edits a remote server, with its URL, no authentication, a bearer token, or OAuth with an optional client ID and scope, and extra headers; or a local command, with one row per argument, environment variables, and an optional working directory. A new server becomes the row `mcp-server-<name>` of the profile patch, switched on, and its name is fixed from then on. Saving an existing server replaces the fields the form edits and keeps the row's other fields; an OAuth server also keeps the `oauth` fields other than the client ID and scope, among them the credential key of its grant. When the row names no credential key, the save writes `mcp-client/<name>`. A bearer token and every header or environment row marked as secret are stored with the credentials service and written as `${credential:MCP_<NAME>_<FIELD>}` references, so the row never holds the value.

A local command runs on this computer with the person's permissions, outside the sandbox, so the tab asks for confirmation before one starts: when a local command is saved, unless its server is switched off, and when a local command's switch is turned on. A save must leave a server that is switched on running: when its row does not start with the saved config, the Host restores the profile patch and reports the reason. A server that is switched off is saved without being started, so anything the MCP manager refuses in it shows when the server is switched on. A server that does not start after its switch is turned on stays switched on and shows the reason on its row and its page.

A saved server's page shows its account section, with **Connect**, **Sign out**, and **Retry**, while the server is on and uses OAuth. **Test connection** appears while the server is on; it runs the manager's probe of the saved row, so it waits until the form has no changes, and shows the tool count or the failure. When the server of an open page is removed elsewhere, or its row becomes one the form cannot read, a notice replaces the form and its unsaved changes, and the crumb returns to the tab's lists.

**Delete** on the page removes a row the profile patch adds, together with the server's OAuth grant and the secrets stored for it. A row another layer adds can be edited or switched off but not removed. An edit that drops OAuth removes the grant first, and every saved edit deletes the secrets the row no longer references. Neither a removal nor an edit deletes a secret another row still references, whether that row is on or off. The Host runs each save, removal, and switch as one operation that stops at the first refused step.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle patch inserts this package's own row. The Host entry provides the `connectors` service, and the browser entry registers the tab into `plugins.tab`. `ConnectorsController` reads `pluginManager.listBundles` when the tab first renders and again on `plugin-manager/changed` and `connection/reset`; only the latest read publishes. An installed connector's switch calls `pluginManager.setBundleEnabled` and stays disabled through the read that follows the write; a refused answer or a `failed` application names the connector in the failure line until another switch starts. **Install** calls the owner's `install` with the spec `<package>@<DSH_CLIENT_VERSION>`, and an installed connector's name button, stretched over its row, calls `openPackage`. Each connector's brand icon is a copy of the `icon.svg` its bundle declares, under `src/client/assets/`. The connector list and each connector's title, description, and icon live in this package, so the tab shows connectors the profile does not hold.

The browser entry mounts the generated `connectors` Remote. Once `remote.connectors` and `remote.mcpManager` exist, it registers the custom servers section into the tab's `connectors.custom` child slot and **Add MCP server** into the tab's `connectors.actions` child slot; both read one `CustomServersController`. The tab renders `connectors.actions`, a list slot, at the end of its first heading's row while it shows its lists. The section's view is the list, a new server's form, or one server's page. The form and a server's page are pages of the tab's own on the Plugins page: the tab opens them with the owner's `openPage`, under the key `new` or `server:<row id>`, returns to the list with `closePage`, and derives the view from the `page` key it receives. The Plugins page therefore draws the crumb, which stays even if the section leaves, and the view starts from the list after the person leaves **Plugins**. The tab passes the view with its setter as the section's owner props and the setter as each action's. `CustomServersController` opens the Remote's `watchServers` stream when the section first renders and sends each change as one call that names the revision of the list it was made on: `saveServer(draft, revision, id?)`, `removeServer(id, revision)`, or `setServerEnabled(id, enabled, revision)`. A stream that fails stays closed until **Retry**.

The Host service reads the rows from [`ctx.configEditor.configuration()`](../../boot/config-editor/README.md): every row whose module is `@deepseek-ai/dsh-mcp-manager/server`, with whether it is switched off, whether it runs or why it does not, whether the profile patch adds it, and its config as written when the form can read it. `watchServers` sends the list at subscription and again after each `app-boot/config-reload`, each `plugin-manager/changed`, and each change made through the service. The list's revision is a digest of the rows' ids, configs, and switches, and of which rows the profile patch adds. While the configuration editor, the plugin manager, credentials, or the MCP manager is absent, the service answers `{ available: false }` and the section renders nothing.

The Host service runs one change at a time. It refuses a stale revision with `connectors/conflict`, which the section reports before it reopens the stream, and answers the first refused step with `connectors/refused`. A save validates the draft with the form's own rules and with the row plugin's `Config`, removes a dropped OAuth grant, writes the row with the editor's `insert()` or `editRow()`, stores the secrets, and deletes the secrets the row stopped using. A refused write stores nothing, and the manager connects the written row again once a secret it references is stored. A removal removes the grant, calls the editor's `remove()`, and deletes the server's secrets. A switch calls `pluginManager.setPluginEnabled`, which writes it to the profile patch, and any answer other than `applied` is a refusal. The grant of a server that is on is removed with `mcpManager.signOut`. For a server that is off or did not start, the service deletes the record its `oauth.credentialKey` names from credentials, unless another server row names the same record or the name of a server the manager holds forms its key: a connector's server keeps its grant under `mcp-client/<name>`.

While the MCP account service and the configuration editor run, the Host service registers each OAuth server row that is on with `ctx.mcpAccounts` under the key `mcp:<name>`, with copy that names the server, and follows the same changes as the stream. Each such row renders the `connector.account` Factory of [`ui-connector-account`](../../client/ui-connector-account/README.md) in its `status` presentation, and its page renders the `section` presentation. Server names that differ only in case, `-`, or `_` would share a credential reference and are refused, as are header or environment names of one server that map to one reference. A save is also refused when two of its secret rows would store their values under one reference, when another row uses one of its own `MCP_<NAME>_` references, when its draft keeps a stored secret under a reference the saved row does not use, or when a header or environment row is named `__jsExpr`, which the Loader would evaluate as a `!!js` expression.

- [Bundle patch](cordis.patch.yml)
- [Host source](src/index.ts)
- [Browser source](src/client/index.ts)
- [Tests](tests/)

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Plugins page](../../client/ui-plugin-manager/README.md) — page tabs and the install dialog.
- [MCP manager](../../mcp/mcp-manager/README.md) — the server rows the custom section writes and the probe it runs.
- [Configuration editor](../../boot/config-editor/README.md) — the row operations that write the profile patch.
- [Plugin manager](../../boot/plugin-manager/README.md) — the switch of a row and how a profile applies it.
- [MCP accounts](../../mcp/mcp-account/README.md) — the account of a server that authorizes with OAuth.
- [Connector account surfaces](../../client/ui-connector-account/README.md) — the Factory that shows an account's section or status.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the connector bundles its Install adds, the ones its switches enable or disable, and the custom MCP servers it saves: each connector owns its model-facing contributions, each enabled custom server contributes its tools through the MCP manager, and the tab adds no tools or prompt content.

#### KV Cache effect

The tab adds no model context. Installing a connector, or switching it on or off, changes later requests as that connector documents. Adding, switching, or removing a custom server changes the tools of later requests as the manager documents.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The list names only connectors that DSH releases; a new connector adds its package name, copy, and icon here. A row's title and description are this package's copy and must follow the connector's own display title; no check compares the two.
- Rows show no account connection state; the connector's page shows it. The account guidance a connector offers after **Enable now** appears on the Installed tab.
- Switching a connector on from the tab shows no account guidance, and a change that waits for a restart shows no restart notice; the switch on the connector's Installed card shows both. The tab's switch sends no `plugin_toggle` analytics event.
- Installing needs the connector package published at the running DSH version; a development build installs connectors with `dsh plugin add` instead.
- A custom server cannot share its name with a server that a loaded connector registers, because the manager refuses the second registration of a name: a save under that name is refused, and when such a connector loads beside an existing custom server, whichever of the two registers second does not start. Both would keep their OAuth grant under `mcp-client/<name>`.
- The section shows a row's config as written, so a secret that a composition file holds as a plain value, instead of a credential reference, appears in the form.
- A row whose config a home patch or a command-line overlay overrides cannot be saved, and a switch that such a layer decides does not change.
- In a profile without hot reload, a switch is saved to the profile patch and takes effect at the next start; the tab reports that and keeps showing the running state.
- A server's page keeps the values it opened with: when the row changes elsewhere while the page is open, a save replaces the fields the form edits with the page's values.
- When a change made outside the tab, such as a hand edit of the profile patch, introduces a row that does not start, the Host applies the change but sends no list, because `app-boot/config-reload` follows only a reload that introduces no failed row. An open tab shows the change with its next list.
- An OAuth server whose row names no credential key needs a name of lowercase letters, digits, and `-` that starts with a letter, because the name then forms the credential key of its grant.
- A local command runs on the Host with the person's permissions, outside the sandbox.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
