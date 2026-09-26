# Agent Note: Developer tools default on after preference resolution

Status: implemented

English | [中文](2026-09-20-developer-tools-default-on.zh.md)

## Problem

New installations need access to developer views, preset selection, change summaries and interactive HTML previews without first finding a Settings switch. A saved disabled preference must still prevent those features from activating during startup, including script execution that cannot be undone after it occurs.

## Decision

The Host schema defaults `ui-developer-tools.enabled` to `true`. Remote browsers with process-local preferences also start enabled. Saved Host values take precedence, including `false`. This supersedes only the initial default-off choice in [Shared developer-tool settings](2026-09-17-developer-tools-settings.md); that note retains ownership of shared persistence and rendering policy.

Host-backed clients publish disabled until an accepted schema-resolved value arrives. Loading, failed initial reads and an unavailable namespace do not grant interactive-preview capabilities. The Host supplies the default for an absent stored field; the client does not interpret an absent response as consent to enable scripts. An accepted value remains authoritative during later refreshes.

Only the Trajectory tab follows the developer-tools preference; third-party Views remain available. The conversation shell retains the explicit Trajectory id because the requested rule names that View. No current requirement makes arbitrary diagnostic Views share the switch.

## Alternatives considered

**Keep the default off.** This minimizes the initial interface but requires a separate opt-in for the features new installations now expose. Users can still save the disabled preference.

**Default the Host client to enabled before settings arrive.** This makes rendering immediate, but briefly activates features for users who disabled them. Unmounting a scripted HTML iframe cannot undo scripts or requests already executed.

**Add a generic developer-tool flag to View registration.** This expands the plugin API and allows other Views to join a switch whose current requirement is specific to Trajectory. A future requirement can justify that API separately.

## Consequences

Fresh profiles expose developer features after settings resolve; users with a saved disabled choice retain the simpler presentation. New users also receive interactive HTML previews with the capabilities documented by the [filesystem-read authority](../architecture/2026-09-09-workspace-file-read-authority.md). Host initialization can briefly withhold developer controls even when the eventual preference is enabled.

Settings tests cover initial withholding, unavailable namespaces, explicit disabled values and process-local defaults. HTML renderer coverage checks that pending and disabled preferences neither read related files nor create script-enabled frames. Browser settings coverage verifies the default and a disabled choice across reload; document-preview replay pins the explicitly disabled scenario.
