# Agent Note: Declarative Agent presets and retained revisions

Status: implemented

English | [中文](2026-09-18-declarative-agent-presets.zh.md)

## Problem

Preset directories duplicate Cordis configuration ownership. Separate discovery, metadata, copying and editing APIs cannot express the same composition through an ordinary profile patch. Disposing a definition during a save must also preserve plugins still used by running Agents.

## Decision

`dsh-agent-preset-registry` owns selection and runtime revisions; `dsh-agent-preset` declares an identity, display metadata and child plugin list in ordinary Cordis YAML. Definitions activate eagerly. Activation failures remain in the roster and reject new bindings without preventing the application from starting.

The registry owns each revision's scope and Loader tree. Agents link their own scopes to the selected revision, and children inherit their parent's exact revision. Updates retire the former revision; Agents and temporary cold readers retain references until disposal. The final release disposes a retired tree. Host registries and the Agent loop remain shared; preset service providers and consumers require an isolated realm.

The Web editor and `agent_preset` tool accept only child plugin YAML. Saving writes the active profile's user patch, preserving display metadata and unrelated configuration. Revision checks and profile locking prevent overwriting concurrent saves; validation rejects a higher-priority override that would defeat the edit. Persistence and activation outcomes are reported separately. Tool writes require approval or full access because configuration executes in the Host.

Session data continues to record the preset identity. Restart resolves that identity against current configuration and rejects a missing definition. Old executable revisions are process-local, not serialized. The saved user default and blank-session selection remain; `selectedDefault` is what an unnamed new session resolves, and the Client's Developer tools preference decides only whether the choice is shown.

## Alternatives considered

**Keep directory presets alongside declarations.** Two writable sources would compete for an identity and require precedence, migration and editing rules. Ordinary profile configuration supplies the required persistence and layering, so presets have no separate paths.

**Let each declaring plugin own its live child tree.** Loader disposal during an edit would revoke tools from running Agents. Registry ownership gives retained revisions an explicit lifetime independent of the declaration.

**Load only on first selection.** Lazy activation delays diagnostics and adds pending-first-use state. Eager activation is acceptable for these compositions and exposes failures before selection.

**Reject application startup for a broken preset.** A failed optional capability set should remain repairable in Web. Healthy definitions and Host services remain available.

## Consequences

One process can run Agents with different capabilities while sharing each selected revision. Retired revisions remain in memory while referenced. Presets do not provide a security sandbox, and a user override replaces the entire child list rather than merging future builtin changes.

The former directory and per-session-mount decision is preserved as [historical context](../../archived/architecture/2026-08-03-per-session-agent-presets.md). Host service ownership remains documented in [the Host-plane note](2026-08-10-host-plane-ownership-after-presets.md).

## Testing

Registry tests cover retained parent and child scopes, cold-reader leases, selection logging and failed activation. Editor tests cross real profile patches, check conflict rejection and preserve nested expressions. The shipped Web composition test checks activation, scoped tools, Creator skills and profile edits against built packages.
