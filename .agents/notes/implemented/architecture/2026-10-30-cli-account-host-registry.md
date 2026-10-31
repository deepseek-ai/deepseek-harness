# Agent Note: Host registry for CLI app accounts

Status: implemented

English | [中文](2026-10-30-cli-account-host-registry.zh.md)

## Problem

CLI app plugins such as Feishu, WeCom, DingTalk, and Tencent Meeting show the account their vendor CLI keeps on the Plugins page: a section with status and buttons, a title tag, an activation prompt, confirmations, and notices. Each plugin's account runtime already runs on the Host, and every plugin needs the same surfaces. Registering each account in the browser makes each plugin ship a browser package with its own account Remote, stream, presentation, and dictionary, although that package knows nothing the Host does not.

## Decision

The Host service `ctx.cliAccounts` in [`@deepseek-ai/dsh-client-ui-cli-account`](../../../../packages/client/ui-cli-account/README.md) holds the accounts. An app plugin's Host row registers its `CliAccountRuntime` as the source, the operations a page button may start with their success text, the copy, and a presenter that maps the account view to a display whose text is `LocalizedText`. It registers inside `ctx.inject(['cliAccounts'], …)`, so a profile without the registry, such as headless, loads the plugin without the page. The Web app composition loads the registry.

The registry serves every account through one `cliAccounts` Remote: `watch` streams every account's entry, and `start` and `cancel` route by package and accept only registered operations. One browser half renders the surfaces of every account and keeps the state that belongs to one browser: it opens an authorization link only in the browser that started the operation, reports notices only there, and ignores clicks while its own action is pending. The copy every account shares lives in the kit dictionary; every other string comes from the plugin as `LocalizedText`, which the browser resolves in its active language.

## Alternatives considered

**Browser registration.** Each plugin's browser half registers with a browser `ctx.cliAccounts` and follows its own account Remote. That needs one browser package and one Remote per plugin, and the browser half only restates what the Host knows. Listing the kit in `PLATFORM_MODULES`, so that those packages can import it at run time, makes a feature package part of the shell baseline.

**Presentation in the browser.** The Host could stream the raw account view and a browser presenter per plugin could map it. That keeps one browser package per plugin. Producing `LocalizedText` on the Host keeps each plugin's text in its Host row, and the browser still resolves the language without a Host round trip.

**Per-browser state on the Host.** Publishing links and notices to every browser would open the authorization link in every open window and report one user's action to all of them. Keeping that state in the browser opens a link only where the user asked for it and reports an outcome only to that browser.

## Consequences

A CLI app plugin ships no browser code for its account and serves no account Remote; its Host row registers the account and the kit renders it. Each browser opens one stream for all accounts when the Web app loads, and the Host checks each idle account for every new stream. A plugin whose Host row fails to load shows no account section, while the Plugins page still lists the bundle with its load failure. The display vocabulary is fixed at five phases, buttons whose command is `start`, `cancel`, or `open`, notes, and a failure with classified diagnostics; a plugin that needs another control extends the kit.

Host specs pin registration, the check for each new stream, coalescing, operation routing, and unload. Client specs pin link opening in the starting browser, notices, the pending-action guard, and each account's slot registrations and their removal.
