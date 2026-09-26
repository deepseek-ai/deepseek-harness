# Agent Note: Plugin management moves to the Web sidebar

Status: implemented

English | [中文](2026-09-09-plugin-management-in-the-web-sidebar.zh.md)

## Problem

Installed packages belong to the running profile, while Settings is a modal over a Session. The management page needs room for package details and installation output. The layout's [global main panels](2026-09-08-global-main-panels.md) provide that lifetime and space.

## Decision

**Management is a sidebar entry.** `ui-plugin-manager` registers a `sidebar.panellist` entry and the `main` panel it opens under `plugins`. The page manages the profile's bundles and their rows through the [plugin manager](2026-09-14-current-profile-plugin-management.md) Remote, displays install output and confirms uninstalls. It lists installed bundles and installation-provided optional bundles. Settings keeps the read-only plugin inventory, including the installation's own bundles (`dsh-base`, `dsh-web-app`); both inventory groups start collapsed, and the inventory carries no management controls. Configuration placement follows the [plugin configuration decision](2026-09-16-plugin-configuration-on-the-plugins-page.md).

**One store follows Host state.** The manager controller joins `listBundles` with `listPlugins` into one view per bundle, decides availability from the inventory's `managementAvailable`, refreshes after management operations, on `plugin-manager/changed`, and on reconnect, and keeps installation progress under the owning job. Configuration forms use the existing global settings bindings.

**Installation results belong to a request.** The dialog generates a fresh request id for every install or retry and filters Host progress, logs, and responses by that id. A cancellation acknowledgement can arrive before the original add response, so that response cannot settle a subsequent retry. Cancellation uses the manager's explicit cleanup acknowledgement; local RPC cancellation and connection loss never imply that pnpm has stopped. The application phase closes the cancellation window.

## Alternatives considered

**A settings section that opens the management page.** Rejected: the dialog covers the main column, so such an entry would have to close Settings to show the page.

**Configuration placement.** The [plugin configuration decision](2026-09-16-plugin-configuration-on-the-plugins-page.md) owns this choice and its alternatives; sidebar navigation and installation-request ownership remain independent of it.

## Consequences

The web bundle's **Plugins** sidebar entry opens profile management. Settings exposes the read-only inventory, while plugin forms live on the Plugins page. `apps/web/tests/plugin-manager.e2e.ts` reaches the manager through the sidebar; `plugin-config` and `settings-chrome` exercise the forms and read-only inventory respectively.

## Testing

`packages/client/ui-plugin-manager/tests` pin the two registrations under one id and the page's rendering; `packages/client/ui-settings-plugins/tests` the tab-less single contribution; the web e2e scenarios above drive the panel and the section over a scaffold.
