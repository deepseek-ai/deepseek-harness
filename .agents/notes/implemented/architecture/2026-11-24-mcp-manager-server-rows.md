# Agent Note: Server rows beside the MCP manager's `servers` dictionary

Status: implemented

English | [中文](2026-11-24-mcp-manager-server-rows.zh.md)

## Problem

Every MCP server that a deployment declared lived in one field: the `servers` dictionary in the config of the `mcp-manager` row. The entries of that dictionary are independent of one another, while the Loader composes, switches, and validates rows, so a composition layer could not handle one server alone:

- A patch that sets a row's `config` replaces the whole config of the layers before it. A bundle patch, a profile patch, or a `--patch` overlay that added or changed one server therefore restated every other server, and two layers that each added a server could not both take effect.
- `disabled` is a key of a row, and a dictionary entry has none. A layer switched one entry off only by restating the dictionary with `enabled: false` on that entry.
- The dictionary is validated as one value. One invalid entry fails the manager row at startup, so no server starts.

## Decision

A server can be declared as a row of its own, and the `servers` dictionary stays as it was.

- [`@deepseek-ai/dsh-mcp-manager/server`](../../../../packages/mcp/mcp-manager/src/server-row.ts) is a second plugin of the manager package. Its config is the server's name in `serverName` and the fields of one `servers` entry except `enabled`, built from the [entry schema](../../../../packages/mcp/mcp-manager/src/entry.ts) that the manager applies to dictionary entries and registrations.
- The row calls `ctx.mcpManager.register(serverName, entry)` and does nothing else. Connector plugins already registered their servers through that call, so the manager gains no code for rows: a row's server is validated, named, mounted, listed, and reconciled as every registered entry is.
- The Loader's handling of rows decides a row's server. A patch adds a server with `insert`, changes one by naming its row's `id` with a new `config`, and switches one off with `disabled: true` on that row; a composition that stops listing a row removes its server. The registration is an effect of the row's fiber, so a changed row restarts alone and its disposal waits for the server's unmount. An invalid row fails alone, and the Host reports it among the entries that did not activate.
- The dictionary, its Settings namespace, the entry field `enabled`, the `disabled` status, and every error text are unchanged, so no stored configuration is converted and no interface is removed.
- Rows and dictionary entries share one namespace of server names under the rule that registrations already followed: the declaration that holds a name keeps it. A row that names the server of a dictionary entry fails alone, a disabled entry included, and a dictionary write that names the server of a running row is refused.
- A row takes no `enabled` field and fails when its config carries one. A registration is enabled while it exists, so an `enabled: false` copied from a dictionary entry would otherwise start a server that its deployment switched off.

This partially supersedes [MCP server manager](../feature/2026-08-31-mcp-manager-plugin.md): its rejection of separate Loader entries. That note still owns the dictionary, its Settings writes, the manager's child instances, the MCP client host, status, credential templates, probing, the Remote methods, and OAuth.

## Alternatives considered

**Remove the `servers` dictionary.** Every server would then have one declaration form, and the manager would lose its config hook, its volatile listener, the entry field `enabled`, and the `disabled` status. Published packages accept `servers` and their README documents it, so a configuration that declares servers there would stop loading until someone rewrites it by hand, and a disabled server could no longer be listed, probed, or authorized. The [pi-ai provider rows](2026-11-23-pi-ai-deployment-provider-rows.md) keep their dictionary beside the rows for the same reason.

**Let the declaration that comes last win, as the pi-ai provider rows do.** pi-ai lets a row replace a dictionary entry of the same route because a deployment must be able to override a provider that the Models page stored for a person. No shipped surface stores servers in the manager's dictionary, connector plugins rely on a held name being refused, and a row that reports its failure is easier to notice than a server that another declaration replaced.

**A separate package for the row plugin.** The row is one call to `register()` with a config that the manager's entry schema validates. A separate package needs that schema exported from the manager's plugin entry, which exports only what the Loader loads and its Service and error classes, and adds a manifest, a README, a locale set, and gate entries for one `apply` function. A second entry of the manager package imports the schema as a sibling module.

**An `enabled` field on a row.** A row would then have two switches. `disabled` is the one that a patch sets without restating the row's `config`, and a row that is switched off through it reserves neither its server name nor its `oauth.credentialKey`.

## Consequences

- A layer adds, changes, switches off, or removes one server row without restating the others. An invalid row fails alone, and a changed row restarts alone.
- The manager has two declaration forms. The dictionary keeps its costs for the servers declared in it: a layer that sets `servers` replaces the dictionary, and one invalid entry fails the manager row, which leaves every server row waiting.
- The two forms switch a server off differently. A dictionary entry with `enabled: false` stays listed as `disabled` and can be probed and authorized. A switched-off row is not loaded, so the manager does not know its server.
- A layer moves a server from the dictionary to a row by deleting the entry and adding the row in one edit.
- The manager offers no way to edit server rows: a row is not a Settings namespace, and the manager's Remote has no method that adds or changes an entry. The experimental [Connectors tab](../feature/2026-11-04-connectors-custom-mcp-servers.md) edits rows in the composition instead: it adds, edits, and removes rows of the profile patch with `ctx.configEditor`'s `insert()`, `editRow()`, and `remove()`, switches a row through the plugin manager, and lists the rows from `ctx.configEditor.configuration()`, because `list()` holds neither a switched-off row nor which servers have a row.
- `ctx.configEditor.edit()` stores a schema-valid edit of a row before the manager validates the entry and restores the previous config when the manager refuses it. A hand-edited file is checked only when the row loads.
- The manager's refusals of a row's entry start with `servers.<name>`, as its refusals of every registered entry do.

## Testing

Composition tests boot server rows through the Loader from a bundle patch and a profile patch, beside the existing tests of the dictionary. They cover adding, editing, switching off, and removing a row, a row that fails alone, a duplicate server name, a row that carries `enabled`, a row and a dictionary entry that run together, a row refused for the name of a dictionary entry, a dictionary write refused for the name of a running row, a server moved from the dictionary to a row in one edit, and an invalid dictionary entry that leaves the rows waiting. A process-level test runs the shipped headless profile with one dictionary entry, one valid row, and three refused rows and checks the startup warning. Manager tests register and dispose a row on real Cordis and observe the server's removal.
