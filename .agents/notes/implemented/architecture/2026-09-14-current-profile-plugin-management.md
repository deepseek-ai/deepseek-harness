# Agent Note: Current-profile plugin management shares CLI transactions

Status: implemented

English | [中文](2026-09-14-current-profile-plugin-management.zh.md)

## Problem

Web and agent controls need to change a running profile without creating an independent package installer or overwriting user-authored YAML. A file watcher can otherwise load the intermediate manifest written during package installation, or report success before removed plugins finish releasing resources.

## Decision

[Plugin Manager](../../../../packages/boot/plugin-manager/README.md) and `dsh plugin` call the same asynchronous package operations. The launcher supplies `ctx.profileContext` as data: profile and resolution locations, startup bundles and invocation overlays. Shared functions compose the current files; this interface contains no callbacks or mutation methods. CLI and service mutations hold the profile manifest's writer lock; [DSH HMR](../../../../packages/boot/hmr/README.md) serializes module replacement, Include refresh, profile recomposition and manager configuration changes through one queue. HMR registers the profile watches during its own initialization, then waits for application readiness before processing edits. Manifest notifications compare only the ordered bundle list; dependency-only changes do not trigger a configuration reload. The final YAML composition controls whether HMR runs; the launcher installs no fallback. Pnpm runs outside `hmr.runExclusive()`; only configuration changes and Loader updates enter that queue. HMR does not acquire the package writer lock, so installation cannot block unrelated file-driven configuration changes. Each generation re-reads the manifest, bundle layers and user patches while retaining invocation overlay precedence.

Configuration watches use Chokidar write stabilization by default. Its ordinary change handler discards a second event within 50 ms, so a write immediately after activation can leave the previous bundle running. Stabilized delivery observes the final file instead; file-driven updates pay the stability delay, while direct manager transactions do not. A regression feeds consecutive changes through Chokidar’s real normalization and verifies both applied states.

Profile files remain the persisted state: entry toggles edit only `disabled` in the last override matching the entry id and any module-name assertion, appending when none matches, and bundle toggles edit the ordered string list. Dependency updates do not reactivate retained disabled bundles. A service removal first applies the composition without the bundle and waits for old fibers to finish before deleting the dependency. Saved configuration, pnpm completion and runtime activation have separate outcomes; a failed removal preserves the actual partial state and a diagnostic path, while a failed or cancelled installation restores the profile files it snapshotted.

This extends the [profile bundle composition decision](2026-08-05-profile-plugin-bundles.md). Profiles without HMR keep their process composition, and Desktop package management remains shell-owned. Web controls and explicitly enabled agent tools call the same service. Management operations return results to callers without adding messages to live Agents. The agent tool is disabled by default in the base bundle and shipped presets. The browser-only worker preview has no host package installer; its module-proxy table refuses `execa` calls explicitly while retaining the management module for inventory discovery.

CLI calls inherit the terminal and authentication environment; service calls retain the subprocess credential scrub and bounded diagnostics. Management records carry error codes and parameters for locale-owned Web presentation. Reconciliation compares entry identity, fiber identity, configuration and diagnostics before and after updating: unchanged inactive entries remain warnings, while newly affected failures reject the operation. Explicit enablement targets must activate.

Build approvals update pnpm 11's unresolved `allowBuilds` entries under the same profile lock and preserve unrelated YAML. They persist by exact package name rather than applying an unrestricted script policy. The retry accepts only names still pending, so stale requests cannot override a subsequent denial. Package cleanup leaves the approval settings intact; a later retry can use them without retaining partially installed dependencies. The service reports policy-only changes. Agent tools may grant approval on the user's behalf; their instructions require explicit conversational consent, while the service validates only pending package names. Approval rejects anchors and aliases inside `allowBuilds` to prevent shared YAML nodes from changing unrequested permissions.

## Alternatives considered

**Spawning another dsh process from the service.** This duplicates lifecycle coordination and cannot establish that the current Loader finished unloading before pnpm removes files. Sharing the operation module retains one implementation while letting each caller own its presentation.

**Restoring existing packages after failure.** Package versions, dependency trees and install-script effects cannot be reconstructed reliably from the previous manifest, so existing dependencies and successful installations whose activation fails remain in place. A failed or cancelled installation restores only the manifest and lockfile text snapshotted before pnpm ran ([guided plugin installation](2026-09-15-guided-plugin-installation.md)); downloaded files stay until the next package operation prunes them.

**Source-module hot replacement for package updates.** Configuration changes can reuse the loaded module cache, whereas replacing installed JavaScript needs a new process generation. Replacing an existing dependency reports a required restart.

## Consequences

The same profile can be managed through CLI, Web and tools, with file-level coordination and preserved patch precedence. Operators must repair failed package operations using the reported files and diagnostics. A startup process must stop before its loaded packages can be removed through CLI. Management components remain protected against service-initiated removal.
