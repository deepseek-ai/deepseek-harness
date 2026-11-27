# Agent Note: One Host registry and one browser half for connector accounts

Status: implemented

English | [中文](2026-11-06-connector-account-registry.zh.md)

## Problem

Connector plugins show an account section on the Plugins page. CLI app plugins keep the account in their vendor CLI; MCP connectors keep an OAuth grant through the MCP manager. Both kinds need the same surfaces: a bundle's section, title tag, and activation prompt, a confirmation before an action that changes the account outside DSH, and a notice in the browser that started the operation. A client plugin cannot share runtime code with another feature plugin ([packages/client/AGENTS.md](../../../../packages/client/AGENTS.md) rule 3), so one browser half per connector kind duplicates the same code and lets the copies drift. When the browser decides an account's state or relays an identifier from one Remote to another, the Host can no longer run the flow without the browser.

## Decision

[`@deepseek-ai/dsh-client-ui-connector-account`](../../../../packages/client/ui-connector-account/README.md) provides one Host registry, `ctx.connectorAccounts`, one `connectorAccounts` Remote, and one browser half for every connector kind.

| Part | Contract |
|---|---|
| Registration | `register({ key, packageName?, source, operations, copy, present })` returns the disposer that withdraws the account |
| Key | Unique among registered accounts and independent of the package, so an account that no bundle owns, such as the account of an MCP server row, registers too |
| Package | Decides which bundle page carries the section and tag; a package carries at most one account |
| Source | The registrant's account: `snapshot`, `observe`, `refresh`, `start`, and `cancel` |
| Display | `present(view)` on the Host gives the phase, status text, title tag, buttons and their commands, confirmations, failure, and the operation the activation prompt starts |
| Remote | `watch`, plus `start(key, operation)` and `cancel(key, id)`, which route by key to the account's source |

The Host decides everything except opening the authorization page. The browser never learns how an account connects: it receives only the display, the operation in progress with its authorization page, and the latest result with its success text. The browser half keeps only what belongs to one browser: the operations it started, so their authorization pages open and their success is reported only there; the latest notice; and whether its stream is delivering. Buttons call `start` and `cancel` on the Remote themselves, and each surface keeps its own pending state.

The page registers one title tag entry and one notice entry. It also registers a section and an activation prompt for each account that names a package, because those two slots are keyed by package.

## Alternatives considered

**Two registries behind one browser half.** Rejected: the browser would follow both Remotes and choose which one each button calls, which relays between Host services again, and the two Host registries would hold the same code.

**One browser half per connector kind.** Rejected: client plugins cannot import each other's values, so the shared surfaces would be written twice and diverge.

**Share the browser half through `PLATFORM_MODULES` or a browser-side service.** Rejected: new shared runtime code does not enter the module table's baseline, and a browser-side service would keep the registrations in the browser, which only repeat what the Host knows.

**Let the browser derive an account's phase and actions from the registrant's raw state.** Rejected: the rules for which actions apply would live where the Host cannot test or run them, and the browser would need the registrant's own Remote.

## Consequences

The registry and browser half exist once. A new connector kind writes a source and `present` on the Host and needs no browser code. The account rules live beside the services that own them, and the Host can run every operation without a browser.

Registrants map their account states onto five phases (checking, connecting, connected, disconnected, unavailable); a state outside them shows through its status text and detail. The Web and Desktop compositions load the registry whether or not a connector plugin is installed. An authorization page that opens after the start call answers can be blocked by the browser; the section's open button shows it again.
