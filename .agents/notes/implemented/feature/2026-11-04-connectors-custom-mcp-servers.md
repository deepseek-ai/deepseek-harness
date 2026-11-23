# Agent Note: Custom MCP servers in the Connectors tab

Status: implemented

English | [中文](2026-11-04-connectors-custom-mcp-servers.zh.md)

## Problem

People add MCP servers by editing the profile's composition, and the Plugins page shows none of the servers configured there. The [MCP manager](../../../../packages/mcp/mcp-manager/README.md) already reads its `servers` from Settings, resolves secrets through credential references, probes a server, and authorizes OAuth servers; what is missing is a page that edits those entries and shows an OAuth server's account. A local stdio server runs a command on the Host with the person's permissions, so letting a browser define one needs an explicit decision.

## Decision

The [Connectors tab](../../../../packages/experimental/client-ui-connectors/README.md) lists the servers of the manager's Settings namespace and edits them through its Host service's `connectors` Remote. The service runs each save, removal, and switch as one operation that stops at the first refused step, and writes the entry with `settings.mutate`, so the manager's validation, revision checks, and composition layering apply unchanged. Bearer tokens and secret header or environment rows go to the credentials service under `MCP_<NAME>_<FIELD>` references, and the entry stores only the `${credential:REF}` template. Removing a server signs its OAuth grant out through the manager and deletes the secrets it owned, and a saved edit writes the entry before storing the secrets entered in it and deletes the references the entry stopped using; neither deletes a reference another entry still uses.

The tab offers stdio servers. Saving an enabled local command first shows a risk confirmation that names the command and states that it runs on this computer with the person's permissions, outside the sandbox; the entry is written only after the person acknowledges it. Custom servers are not connectors: they stay in the manager's settings and keep running while the Connectors bundle is off.

The Host service registers each configured OAuth server with [`dsh-mcp-account`](../../../../packages/mcp/mcp-account/README.md) under the key `mcp:<name>`, without a bundle package, and with copy that names the server, so its account's display and operations come from the Host like a connector's. An enabled OAuth server's status in its list row, and its account section on its page, render through the `connector.account` Factory of [`ui-connector-account`](../../../../packages/client/ui-connector-account/README.md).

## Alternatives considered

**A write method on the manager.** It would repeat the revision checks, layering, and persistence of Settings, and add a second path that writes the same entries.

**No stdio from the browser.** Local servers are a main reason to add a custom server, and Desktop runs its page on the Host computer; the confirmation names the command instead.

**Writing from the browser.** The browser could store the secrets, sign out, and write Settings in turn, as other settings pages write; but signing out is account logic, the manager offers sign-out only to Host callers, and the order and the first refusal belong in one operation.

**A browser mirror of the manager's servers.** Mapping each manager view to an account in the browser repeats the Host's account presentation and needs the manager's authorization methods as Remote operations; registering the accounts on the Host reuses the MCP account service and the connector account registry.

**Accounts for servers without OAuth.** Their rows could show the manager's connection status as an account with only Retry, but such a server has no account; its page's connection test shows whether it connects.

**A separate account block in the Connectors tab.** It would duplicate the attempt handling, authorization page opening, and notices of the connector accounts.

## Consequences

A browser that may write Settings, or that reaches the owner-only `connectors` Remote, can make the Host run a command; the Connectors tab is the surface that offers it, and it confirms first. A custom server named like a connector's server keeps that connector from loading while the entry exists, and both use the grant `mcp-client/<name>`. An OAuth server's name must fit a credential key segment: lowercase letters, digits, and `-`, starting with a letter. Names and row keys that differ only in case, `-`, or `_` are refused, because they would share a credential reference; so is a save whose own `MCP_<NAME>_` references another server's entry uses.
