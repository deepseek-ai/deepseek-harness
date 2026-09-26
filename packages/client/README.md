---
description: "Package map for the web GUI browser half: shell boot, browser-host communication, shared client services, localization, development reload, and the UI feature plugins."
kind: "package-group"
---

# client/ — web-GUI browser half

English | [中文](README.zh.md)

## Summary

The `client/` group provides the browser experience for the dsh web GUI, including conversation, navigation, settings, approvals, file access, and other interactive features. Choose packages from this family when adding browser-visible behavior; use [`host/`](../host/README.md) for server-side page delivery and host integration. Packages cover both the shared browser foundation and focused UI features, while each child README owns its configuration and behavior. Authoring rules live in [AGENTS.md](AGENTS.md), and the related documentation below explains cross-package composition.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The kernel packages boot and serve the page; the UI feature packages present it. Each package README owns its contract and configuration.

| Package | Role | ctx key |
|---|---|---|
| [`web/`](web/README.md) | Boots the browser shell | — |
| [`modules/`](modules/README.md) | Loads browser-side client modules | `ctx.clientModules` / `ctx.modules` |
| [`connection/`](connection/README.md) | Maintains browser-host RPC communication and event delivery | `ctx.connection` |
| [`file-upload/`](file-upload/README.md) | Sends raw Blob and byte-stream request bodies outside the page thread | `ctx.fileUpload` |
| [`shortcuts/`](shortcuts/README.md) | Registers application keyboard commands | `ctx.shortcuts` |
| [`ui-shortcuts/`](ui-shortcuts/README.md) | Presents the keyboard shortcut reference | — |
| [`store/`](store/README.md) | Provides React-free observable and snapshot-store primitives | — |
| [`hmr/`](hmr/README.md) | Refreshes client plugins during development | — |
| [`locale/`](locale/README.md) | Provides localization preferences and message dictionaries | `ctx.locale` |
| [`test-runtime/`](../test-support/client-runtime/README.md) | Shared repository test support for client feature packages | — |
| [`ui-renderer/`](ui-renderer/README.md) | Binds slot data to React and mounts the assembled application | `ctx.uiRenderer` |
| [`ui-slots/`](ui-slots/README.md) | Defines typed extension Slots and reusable Component Factories | — |
| [`ui-session/`](ui-session/README.md) | Adapts Session Controller state into standard Slot sources and hooks | — |
| [`ui-theme/`](ui-theme/README.md) | Applies the selected color theme | — |
| [`ui-primitives/`](ui-primitives/README.md) | Provides shared React controls, icons, and content renderers | — |
| [`ui-attachment/`](ui-attachment/README.md) | Registers composer and message-image attachment presentation | — |
| [`ui-layout/`](ui-layout/README.md) | Arranges the main application regions | — |
| [`ui-dockkit/`](ui-dockkit/README.md) | Provides docking layout operations and React components | — |
| [`ui-sidebar/`](ui-sidebar/README.md) | Presents workspace and session navigation | — |
| [`ui-sidebar-right/`](ui-sidebar-right/README.md) | Owns the right Sidebar and its tab types | `ctx.sidebarRight`, `ctx.sidebarRightTabs` |
| [`ui-sidebar-documentpreview/`](ui-sidebar-documentpreview/README.md) | Displays documents in right Sidebar tabs | `ctx.documentPreviews` |
| [`ui-sidebar-browser/`](ui-sidebar-browser/README.md) | Browses sandboxed HTTP(S) pages, including loopback services, in right-Sidebar tabs | — |
| [`resources/`](resources/README.md) | Unified resource model: protocol providers behind the `useResource` session standard hook | `ctx.resources` |
| [`ui-sidebar-files/`](ui-sidebar-files/README.md) | Right-Sidebar workspace file tree tab type | — |
| [`ui-brand-official/`](ui-brand-official/README.md) | Fills the generic browser-brand slots with the official name and marks | — |
| [`ui-workspace/`](ui-workspace/README.md) | Provides workspace selection and creation surfaces | — |
| [`ui-conversation/`](ui-conversation/README.md) | Presents the active conversation and its input surface | — |
| [`ui-chat/`](ui-chat/README.md) | Projects and renders the Chat conversation target | — |
| [`ui-approval/`](ui-approval/README.md) | Presents approval requests and returns user decisions | — |
| [`ui-tool/`](ui-tool/README.md) | Composes Tool call trees and keyed per-Tool views | — |
| [`ui-workflow-run/`](ui-workflow-run/README.md) | Replays durable workflow runs as nested chat disclosures | — |
| [`ui-goal/`](ui-goal/README.md) | Presents and manages the current goal | — |
| [`ui-trajectory/`](ui-trajectory/README.md) | Presents alternate views of agent activity | — |
| [`ui-commands/`](ui-commands/README.md) | Provides session-aware command discovery and dispatch | — |
| [`ui-input-trigger/`](ui-input-trigger/README.md) | Coordinates inline command and reference suggestions | — |
| [`ui-skill/`](ui-skill/README.md) | Adds skill references to inline suggestions | — |
| [`ui-reference/`](ui-reference/README.md) | Unified Web `@file` / `@session` reference source | — |
| [`ui-subagent/`](ui-subagent/README.md) | Provides subagent navigation, child transcript states, and inline references | — |
| [`ui-jobs/`](ui-jobs/README.md) | Lists this session's background jobs with on-demand streaming record panels | — |
| [`ui-schedule/`](ui-schedule/README.md) | Lists the current Session's active reminders in a read-only header catalog | — |
| [`ui-model-selection/`](ui-model-selection/README.md) | Provides model selection in conversation surfaces | — |
| [`ui-permission-presets/`](ui-permission-presets/README.md) | Configures default permissions and switches the current session's access | — |
| [`ui-plan/`](ui-plan/README.md) | Presents active plan-mode status and its exit control | — |
| [`ui-settings-plugins/`](ui-settings-plugins/README.md) | Owns the Built-in plugins settings section shell and its tab extension point | — |
| [`ui-user-questions/`](ui-user-questions/README.md) | Presents interactive questions requested by the agent | — |
| [`ui-agent-preset/`](ui-agent-preset/README.md) | Selects a session's agent preset and authors preset compositions | — |
| [`ui-settings/`](ui-settings/README.md) | Hosts the settings interface and its extension areas | — |
| [`ui-settings-general/`](ui-settings-general/README.md) | Provides the general settings section | — |
| [`ui-settings-models/`](ui-settings-models/README.md) | Provides model-provider configuration and DeepSeek onboarding | — |
| [`ui-settings-shell/`](ui-settings-shell/README.md) | Provides the shell settings page on the Plugins page | — |
| [`ui-settings-agent-loop/`](ui-settings-agent-loop/README.md) | Provides the agent-loop settings page on the Plugins page | — |
| [`ui-settings-subagent/`](ui-settings-subagent/README.md) | Provides the Subagent settings page on the Plugins page | — |
| [`ui-settings-web-search/`](ui-settings-web-search/README.md) | Provides the web-search settings page on the Plugins page | — |
| [`ui-plugin-manager/`](ui-plugin-manager/README.md) | Contributes the sidebar Plugins panel: install, enable, disable, retry, and compose installed packages | — |
| [`ui-settings-plugin-inventory/`](ui-settings-plugin-inventory/README.md) | Contributes the read-only Host Loader inventory tab to Plugins settings | — |
| [`ui-deliverables/`](ui-deliverables/README.md) | Produces the changed-files card with its comparison tabs, delivery cards, and clickable final-response file references | — |
| [`ui-message-feedback/`](ui-message-feedback/README.md) | Provides message ratings and feedback dialogs opened from ratings, `/feedback`, or the Session Header menu | `ctx.feedbackUi` |
| [`ui-directory-picker-browse/`](ui-directory-picker-browse/README.md) | In-app directory browsing surface for the workspace directory flow | — |
| [`ui-directory-picker-native/`](ui-directory-picker-native/README.md) | Native directory-picker surface driving the local Desktop or Host OS chooser | — |
| [`ui-open-in-app/`](ui-open-in-app/README.md) | Session-header split button opening the workspace directory in an installed application, and the document preview's default-application controls for one file | — |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference and the two notes that own the cross-package composition decisions, then the host half that serves this page.

- [Client modules subsystem](../../docs/subsystems/client-modules.md) — the web plugin table: `dsh.client` declarations, the boot graph wire, and the bundle route.
- [Slot system standard](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the definitive slot model: registration, props shares, and stores.
- [Web client architecture note](../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — the loading chain, object layer, and client services.
- [Host group map](../host/README.md) — the host half that serves this browser half.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
