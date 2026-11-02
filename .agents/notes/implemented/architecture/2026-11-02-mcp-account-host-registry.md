# Agent Note: Host registry for MCP connector accounts

Status: implemented

English | [中文](2026-11-02-mcp-account-host-registry.zh.md)

## Problem

Connector plugins such as Linear, Notion, and Tencent Docs register an OAuth MCP server with the MCP manager on the Host and show its account on the Plugins page: a section with status and actions, a title tag, activation guidance, a sign-out confirmation, and notices. The manager already owns the authorization attempt, the grant, and the server status, and every connector needs the same surfaces. Registering each account in the browser makes each connector ship a browser half with a 41-key dictionary, 26 of whose strings are identical across connectors, and a registration that restates the server name its Host half already registered.

## Decision

The Host service `ctx.mcpAccounts` in [`@deepseek-ai/dsh-client-ui-mcp-account`](../../../../packages/client/ui-mcp-account/README.md) holds the accounts. A connector's Host row registers its server name, its bundle package, and the copy that names its service as `LocalizedText`. It registers inside `ctx.inject(['mcpAccounts'], …)`, so a profile without the registry, such as headless, loads the connector without the page. The Web app composition loads the registry.

The registry serves every account with the manager's view of its server through one `mcpAccounts` Remote; authorization, cancellation, sign-out, and restart stay on the manager's Remote, which already takes the server name. One browser half renders the surfaces of every account and keeps the state that belongs to one browser: it opens an authorization page only in the browser that started the attempt, reports notices only there, and ignores clicks while its own action is pending. The 26 shared strings live in the kit dictionary.

## Alternatives considered

**Browser registration.** Each connector's browser half registers with a browser `ctx.mcpAccounts` under its own dictionary namespace and follows the manager stream itself. That needs one browser package per connector, which only restates what its Host half registered, and one manager stream per account in each browser.

**Connector copy from a shared template.** One dictionary with the service name as a placeholder would remove the 15 connector-specific strings, but those strings differ in more than the name, such as what signing out removes, and Chinese spacing around a Latin name depends on its position. Each connector supplies them as `LocalizedText` instead.

**Actions through the registry.** The registry could route `startAuthorization` and the other actions by package. The manager's Remote already takes the server name, so routing would add a second action surface without a new check.

**A base shared with CLI accounts.** The CLI account registry also registers Host accounts for the Plugins page, but MCP accounts follow the manager's fixed authorization states while CLI accounts present each vendor's own states. A shared base would couple the two registries without removing code from either.

## Consequences

A connector ships no browser code for its account; its Host row registers the account and the kit renders it. Each browser opens one stream for all accounts, which follows one manager stream on the Host. A connector whose Host row fails to load shows no account section, while the Plugins page still lists the bundle with its load failure.

Host specs pin registration, the refusal of a second account per package or server, the merge with the manager's stream, its failure and end, and unload. Client specs pin authorization page opening in the starting browser, notices, the pending-action guard, and each account's slot registrations and their removal.
