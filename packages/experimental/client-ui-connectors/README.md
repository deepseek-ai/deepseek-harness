---
description: "Enable the Connectors tab of the Plugins page to list, install, and open the official connectors and manage custom MCP servers."
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-connectors

English | [中文](README.zh.md)

## Summary

Enable Connectors to add a Connectors tab beside Installed on the Web or Desktop Plugins page. The tab lists the official connectors with their brand icons, installs a missing one at the running DSH version, switches an installed one on or off, and opens its page, where its account is connected. Below them, it lists, adds, edits, tests, and removes custom MCP servers and shows an OAuth server's account. Custom servers stay in the MCP manager's settings and keep running while the bundle is off. Shipped profiles leave the bundle disabled, and the Plugins page lists it under Experimental plugins.

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

The custom servers section appears below the official connectors when the profile runs the [MCP manager](../../mcp/mcp-manager/README.md), Settings, and a credentials provider. Each row shows the server's name, URL or command, and switch; an enabled OAuth server also shows its account status. **Add MCP server** beside the section's heading and a row's **Settings** open the server's page in place of the tab's lists, below **Back**. The page edits a remote server, with its URL, no authentication, a bearer token, or OAuth with an optional client ID and scope, and extra headers; or a local command, with one row per argument, environment variables, and an optional working directory. A new server is saved enabled. A bearer token and every header or environment row marked as secret are stored with the credentials service and written as `${credential:MCP_<NAME>_<FIELD>}` references, so the settings never hold the value. Saving an enabled local command first asks for confirmation that it runs on this computer with the person's permissions, outside the sandbox. A saved server's page shows its account section, with **Connect**, **Sign out**, and **Retry**, when it is enabled and uses OAuth, and **Test connection** runs the manager's probe of the saved entry, so it waits until the form has no changes, and shows the tool count or the failure. A server inherited from the profile's composition can be edited or switched off but not removed. **Delete** on the page signs the server's OAuth grant out and deletes its secrets; an edit that drops OAuth signs out first, and every saved edit deletes the secrets the entry no longer references; neither deletes a secret another entry still references. The Host runs each save, removal, and switch as one operation that stops at the first refused step.

The `mcpManagerNamespace` configuration field, `mcp-manager` by default, names the manager's Settings namespace, which is the manager row's id.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle patch inserts this package's own row. The Host entry provides the `connectors` service, and the browser entry registers the tab into `plugins.tab`. `ConnectorsController` reads `pluginManager.listBundles` when the tab first renders and again on `plugin-manager/changed` and `connection/reset`; only the latest read publishes. An installed connector's switch calls `pluginManager.setBundleEnabled` and stays disabled through the read that follows the write; a refused answer or a `failed` application names the connector in the failure line until another switch starts. **Install** calls the owner's `install` with the spec `<package>@<DSH_CLIENT_VERSION>`, and an installed connector's name button, stretched over its row, calls `openPackage`. Each connector's brand icon is a copy of the `icon.svg` its bundle declares, under `src/client/assets/`. The connector list and each connector's title, description, and icon live in this package, so the tab shows connectors the profile does not hold.

The browser entry mounts the generated `connectors` Remote, and the custom servers section registers into the tab's `connectors.custom` child slot once `remote.connectors` and `remote.mcpManager` exist. The tab keeps the section's view, which is the list, a new server's form, or one server's page, in its own state, so the view starts from the list whenever the tab mounts again. The tab passes the view with its setter as owner props and renders **Back** itself, so **Back** stays even if the section leaves. `CustomServersController` reads the servers through `connectors.listServers()` when the section first renders and after each `settings/document-updated`, and sends each change as one call: `saveServer(draft, revision)`, `removeServer(name, revision)`, or `setServerEnabled(name, enabled, revision)`. The Host service refuses a stale revision with `connectors/conflict`, which the section reports and reads again; it validates a draft with the form's own rules, signs a dropped or removed OAuth grant out through the manager, writes the entry through Settings, stores the secrets, and deletes the secrets the entry stopped using, answering the first refused step with `connectors/refused`; a refused write stores nothing, and the manager connects the written entry again once a secret it references is stored. While the MCP account service runs, the Host service registers each configured OAuth server with `ctx.mcpAccounts` under the key `mcp:<name>`, with copy that names the server, and follows the namespace's changes; each enabled OAuth row renders the `connector.account` Factory of [`ui-connector-account`](../../client/ui-connector-account/README.md) in its `status` presentation, and a saved OAuth server's page renders its `section` presentation. Server names and row keys that differ only in case, `-`, or `_` would share a credential reference and are refused, as are secret rows that would store their values under one reference and a save whose own `MCP_<NAME>_` references another server's entry uses.

- [Bundle patch](cordis.patch.yml)
- [Host source](src/index.ts)
- [Browser source](src/client/index.ts)
- [Tests](tests/)

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Plugins page](../../client/ui-plugin-manager/README.md) — page tabs and the install dialog.
- [MCP manager](../../mcp/mcp-manager/README.md) — the server entries the custom section writes and the probe it runs.
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
- A custom server named like a connector's server keeps that connector from loading while the entry exists, and both use the OAuth grant `mcp-client/<name>`.
- A server that authorizes with OAuth needs a name of lowercase letters, digits, and `-` that starts with a letter, because the name forms its grant's credential key.
- A local command runs on the Host with the person's permissions, outside the sandbox.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
