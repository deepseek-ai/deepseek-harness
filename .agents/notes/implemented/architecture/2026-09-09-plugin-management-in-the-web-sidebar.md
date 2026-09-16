# Agent Note: Plugin management moves to the Web sidebar

Status: implemented

English | [中文](2026-09-09-plugin-management-in-the-web-sidebar.zh.md)

## Problem

Installed packages belong to the running profile, while Settings is a modal over a Session. The management page needs room for package details and installation output. The layout's [global main panels](2026-09-08-global-main-panels.md) provide that lifetime and space.

## Decision

**Management is a sidebar entry; configuration stays in Settings.** `ui-plugin-manager` registers a `sidebar.panellist` entry and the `main` panel it opens under `plugins`. The page manages the profile's bundles and their rows through the [plugin manager](2026-09-14-current-profile-plugin-management.md) Remote, displays install output and confirms uninstalls. The page lists installed bundles only. The Settings Plugins section keeps the global configuration cards beside the read-only Plugin list tab, where the installation's own bundles (`dsh-base`, `dsh-web-app`) are inspected; both of that tab's groups start collapsed, and the tab carries no management controls of its own.

**One store follows Host state.** The manager controller joins `listBundles` with `listPlugins` into one view per bundle, decides availability from the inventory's `managementAvailable`, refreshes after management operations, on `plugin-manager/changed`, and on reconnect, and keeps installation progress under the owning job. Configuration cards use the existing global settings bindings.

**Installation results belong to a request.** The dialog generates a fresh request id for every install or retry and filters Host progress, logs, and responses by that id. A cancellation acknowledgement can arrive before the original add response, so that response cannot settle a subsequent retry. Cancellation uses the manager's explicit cleanup acknowledgement; local RPC cancellation and connection loss never imply that pnpm has stopped. The application phase closes the cancellation window.

## Alternatives considered

**A settings section that opens the management page.** Rejected: the dialog covers the main column, so such an entry would have to close Settings to show the page.

**Configuration on the plugin's page.** Rejected for now, for the reasons in the decision; it becomes a link from the plugin's page once Settings can be opened on one section.

## Consequences

The web bundle's panel list is no longer empty: the **Plugins** entry sits between New Session and the workspaces. The Settings Plugins section keeps two tabs: the configuration page and the read-only Plugin list. `apps/web/tests/plugin-manager.e2e.ts` reaches the manager through the sidebar, and the `plugin-config` and `settings-chrome` scenarios and goldens follow.

## Testing

`packages/client/ui-plugin-manager/tests` pin the two registrations under one id and the page's rendering; `packages/client/ui-settings-plugins/tests` the tab-less single contribution; the web e2e scenarios above drive the panel and the section over a scaffold.
