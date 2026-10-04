# Agent Note: Desktop-installed CLI runtime

Status: implemented
Archived: 2026-09-30

English | [中文](2026-09-27-desktop-cli-runtime.zh.md)

## Problem

Desktop contains dsh and its production dependencies. Users need terminal access to plugin management and other CLI functions without maintaining another installation.

## Decision

A shell script on macOS and a command script on Windows run the private Desktop CLI entry through the installed Electron executable in Node mode. The entry delegates to the ordinary CLI dispatcher and supplies bundled pnpm through its package-operation options. Desktop Host startup and ASAR packaging retain their existing behavior.

The Desktop-installed command can manage the initialized `desktop` profile while the application is quit. It uses the same profile write lock, package compatibility checks and reconciliation as existing plugin operations. Desktop owns profile initialization; the CLI refuses to initialize a missing Desktop profile as an ordinary CLI profile. npm-installed dsh cannot manage that reserved profile, and neither CLI boots it.

Windows registers a console callback through Koffi to deliver SIGINT and SIGBREAK to the CLI's JavaScript listeners for asynchronous shutdown. Electron's native default exits before those listeners run. The existing Office engine resolver supplies physical paths for Web attachment conversion; CLI profile startup does not inject Office authoring-skill configuration.

## Consequences

Users finish CLI commands before updating or uninstalling Desktop. Installers do not coordinate with CLI processes, and no runtime versions are retained for running commands. An overlapping update can interrupt commands or make their runtime files unavailable.

The command's runtime version follows Desktop. The [Electron runtime decision](../architecture/2026-09-11-desktop-electron-node-runtime.md) owns Electron/OpenSSL and third-party native-addon limitations. Desktop's existing Office resources are unchanged; the CLI does not automatically supply their authoring paths to user-enabled plugins.

## Command registration

The permanent **Manage dsh Command…** menu displays status and installation, repair, and removal actions. macOS uses a fixed `/usr/local/bin/dsh` link, with administrator authentication when needed, instead of editing shell startup files. Windows registers a dedicated directory containing only the public launcher in the current user's PATH. Registration and removal are optional menu actions after application installation; the installer and uninstaller do not perform them. Private installation helpers are outside that PATH directory.

Switching an existing command requires confirmation. The executor rechecks the displayed fingerprint and carries that exact command entry through withdrawal; a concurrent replacement is preserved. A receipt retains the previous macOS launcher. If another installation replaces the Desktop link before reinstallation, any older backup is preserved and reported; Remove restores only the current receipt’s backup. Windows inserts one owned PATH occurrence and records the count of identical pre-existing occurrences so removal preserves them. Other command locations are reported without being modified. Concurrent dialogs share one operation, and update preparation waits for it to finish.

The macOS worker reports operation failures in a JSON response with a successful process exit so AppleScript retains its error code and message. Cancelling administrator authentication ends the operation without an error dialog. Windows treats invalid PATH entries as unavailable candidates and preserves their text; environment-change notifications do not change the result of a committed registry write.

## Alternatives considered

**Another npm installation.** It duplicates dependencies and can drift from Desktop's runtime.

**Standalone Node for the CLI.** Ordinary Node cannot load the existing ASAR dependency tree. Moving or duplicating that tree expands the packaging change.

**Forward commands to the running Desktop Host.** This requires the GUI to be running and adds live-plugin lifecycle integration. Direct package operations support the documented quit-and-reopen workflow.

**Coordinate updates with every CLI process.** Native admission locks and installer handoff records add lifecycle behavior beyond the initial command integration. The CLI uses the existing application update policy.
