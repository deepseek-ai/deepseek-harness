# Agent Note: Custom MCP servers in the Connectors tab

Status: implemented

English | [中文](2026-11-04-connectors-custom-mcp-servers.zh.md)

## Problem

People add MCP servers by editing the profile's composition, and the Plugins page shows none of the servers declared there. Each server is one [server row](../architecture/2026-11-24-mcp-manager-server-rows.md) of the [MCP manager](../../../../packages/mcp/mcp-manager/README.md), which resolves secrets through credential references, probes a server, and authorizes OAuth servers; what is missing is a page that adds, edits, switches, and removes those rows and shows an OAuth server's account. A local stdio server runs a command on the Host with the person's permissions, so letting a browser define one needs an explicit decision.

## Decision

The [Connectors tab](../../../../packages/experimental/client-ui-connectors/README.md) lists the MCP server rows of the profile's composition and changes them through its Host service's `connectors` Remote. A server added in the tab is a row of the profile patch, the declaration a hand edit writes, so the tab keeps no store of its own. The service runs each save, removal, and switch as one operation that stops at the first refused step. It writes a row with the [configuration editor](../../../../packages/boot/config-editor/README.md)'s `insert()`, `editRow()`, and `remove()` and switches one with the [plugin manager](../../../../packages/boot/plugin-manager/README.md)'s `setPluginEnabled`, so the profile lock, the precedence of higher layers, and the reconciliation of the running composition apply unchanged.

A save of a server that is switched on must leave its row running. When the row does not start with the saved config, the editor restores the profile patch and the save reports the row's failure, so whatever the manager refuses at registration reaches the form. A server that is switched off is validated with the row plugin's `Config` and written without starting; what only the manager refuses shows when the server is switched on.

The list is read from the composition, because the manager's `list()` holds registered servers only: it omits a row that is switched off or did not start, and it includes each connector's server, which has no row. Each listed row carries whether it is off, runs, or did not start, with the reason. The Host service streams the list with a revision, a digest of the rows, at subscription and after each `app-boot/config-reload`, each `plugin-manager/changed`, and each change of its own. A change names the revision it was made on, and a stale one is refused.

Bearer tokens and secret header or environment rows go to the credentials service under `MCP_<NAME>_<FIELD>` references, and the row stores only the `${credential:REF}` template. Removing a server removes its OAuth grant and deletes the secrets it owned, and a saved edit writes the row before storing the secrets entered in it and deletes the references the row stopped using; neither deletes a reference another row still uses, whether that row is on or off. The manager signs out a server that is on. For a server that is off or did not start, which the manager does not hold, the service deletes the record that the row's `oauth.credentialKey` names from credentials, unless another row names the same record or the name of a server the manager holds forms its key: a connector's server keeps its grant under `mcp-client/<name>`. Test connection and the account section need the manager's server, so they appear only while the server is on.

The tab offers stdio servers. Before a local command starts, a risk confirmation names the command and states that it runs on this computer with the person's permissions, outside the sandbox: when a local command is saved, unless its server is switched off, and when a local command is switched on. Custom servers are not connectors: they are rows of the profile and keep running while the Connectors bundle is off.

The Host service registers each OAuth server row that is on with [`dsh-mcp-account`](../../../../packages/mcp/mcp-account/README.md) under the key `mcp:<name>`, without a bundle package, and with copy that names the server, so its account's display and operations come from the Host like a connector's. Its status in its list row, and its account section on its page, render through the `connector.account` Factory of [`ui-connector-account`](../../../../packages/client/ui-connector-account/README.md).

## Alternatives considered

**A store or a patch writer of the tab's own.** A second store of servers needs a precedence rule against the rows of the composition. A second writer of the profile patch repeats the configuration editor's lock, its refusal of a write that a higher layer overrides, and its reconciliation of the running composition, so the row operations are the editor's.

**A validation method on the manager.** It would have one caller, and a row could still be refused between the validation and its registration. Writing the row, waiting for it to start, and restoring the file when it does not start reports the refusal of the registration itself.

**Listing from the manager.** `list()` would need the switched-off rows, which the manager does not hold, and a field that tells a row's server from a plugin's, both for this one caller.

**Registering the accounts from the row plugin.** The manager package would depend on `dsh-mcp-account`, which depends on the manager, and the copy that names the server belongs to Connectors.

**No stdio from the browser.** Local servers are a main reason to add a custom server, and Desktop runs its page on the Host computer; the confirmation names the command instead.

**Writing from the browser.** The browser would need the configuration editor's row operations as Remote methods and would run them in turn with the secret writes and the removal of the grant. Removing a grant is account logic, the manager offers sign-out only to Host callers, and the order and the first refusal belong in one operation.

**A browser mirror of the manager's servers.** Mapping each manager view to an account in the browser repeats the Host's account presentation and needs the manager's authorization methods as Remote operations; registering the accounts on the Host reuses the MCP account service and the connector account registry.

**Accounts for servers without OAuth.** Their rows could show the manager's connection status as an account with only Retry, but such a server has no account; its page's connection test shows whether it connects.

**A separate account block in the Connectors tab.** It would duplicate the attempt handling, authorization page opening, and notices of the connector accounts.

## Consequences

A browser that reaches the owner-only `connectors` Remote can make the Host run a command; the Connectors tab is the page that offers it, and it confirms first. The list sends each row's config to the owner's browser as written, so a secret that a composition file holds as a plain value appears in the form. The Loader evaluates a `!!js` expression in a row's config when the row starts, so the service refuses a header or environment row named `__jsExpr`, the key that marks an expression, and lists a row that holds an expression as one the form cannot read.

A row that a layer other than the profile patch adds, such as a bundle, can be edited and switched off but not removed, because a patch has no item that removes another layer's row. A custom server cannot share its name with a server that a loaded connector registers: the manager refuses the second registration of a name, so a save under that name is refused, and when such a connector loads beside an existing custom server, whichever of the two registers second does not start. Both would keep their OAuth grant under `mcp-client/<name>`. An OAuth server whose row names no credential key gets `mcp-client/<name>`, so its name must fit a credential key segment: lowercase letters, digits, and `-`, starting with a letter. A row that names its credential key keeps it through an edit, and its name is not limited that way. Server names that differ only in case, `-`, or `_` are refused, because they would share a credential reference, as are header or environment names of one server that map to one reference; so is a save whose own `MCP_<NAME>_` references another row uses.
