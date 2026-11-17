# Agent Note: MCP connector accounts in the connector account registry

Status: implemented

English | [中文](2026-11-08-mcp-connector-accounts.zh.md)

## Problem

Connector plugins such as Linear, Notion, and Tencent Docs register an OAuth MCP server with the MCP manager on the Host and show its account on the Plugins page. The manager already owns the authorization attempt, the grant, and the server status, and every connector shares the same states, buttons, and 23 strings. The [connector account registry](2026-11-06-connector-account-registry.md) shows each account from a Host source and presenter, so MCP needs one adapter that turns the manager's view of a server into that source and presenter.

## Decision

[`@deepseek-ai/dsh-mcp-account`](../../../../packages/mcp/mcp-account/README.md) provides `ctx.mcpAccounts`. A connector's Host row registers its server name, its bundle package, and the copy that names its service; the service registers the account with `ctx.connectorAccounts` under the key `mcp:<server>`.

| Part | Choice |
|---|---|
| Source | Reads the manager's `list()` entry for the server and observes `mcp-manager/status`; `refresh` does nothing, because the manager publishes every change |
| Operation | A running authorization attempt is the operation and its identity is the operation's, so the browser that started it follows the manager's own attempt; a finished attempt is the result |
| Page operations | `connect` starts authorization, also while connected, so the user changes the account or workspace without deleting the grant first; `sign-out` and `retry` sign out and restart through the manager and report their own result once they finish |
| Phases | Waiting for the browser and authorizing are connecting; a server that needs authorization again is disconnected, with the reason in its detail; a closed, waiting, disabled, or failed server is unavailable, with Retry only where a restart recovers it |
| Copy | The 23 strings every connector shares are Host dictionaries in eight languages; each connector supplies only the strings that name its service |

The manager's `startAuthorization`, `cancelAuthorization`, and `signOut` are Host methods without a Remote, so no browser names a server to authorize.

## Alternatives considered

**Keep the manager's authorization operations on its Remote.** Rejected: the page would pass a server name the Host already holds, and two paths would start the same attempt.

**Track an adapter-owned operation for each authorization.** Rejected: the manager already tracks the attempt's identity, phases, and authorization page, so a second tracker would restate it. The registry lets a source answer `start` once the manager has created the attempt.

**Key each connector's account by its package.** Rejected: the server name is unique among MCP accounts, so the key also refuses a second account for one server, and a server configured in Settings, which no bundle owns, uses the same form.

## Consequences

A connector ships no browser code and no page rules; the shared page renders its account. An account that needs reconnection shows as disconnected without a separate warning color, and its status and detail name the reason. Each browser follows the one registry stream, and the Host follows the manager through its status event.
