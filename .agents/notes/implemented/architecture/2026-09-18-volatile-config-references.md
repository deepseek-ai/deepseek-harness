# Agent Note: Volatile configuration references

Status: implemented

English | [中文](2026-09-18-volatile-config-references.zh.md)

## Problem

Replacing an entire plugin to change a value also disposes its services and effects. Separate settings subscriptions require each consumer to implement another source of live configuration.

## Decision

Schemastery declares live fields with `.volatile()`, preserving node types and form metadata while returning stable references to immutable snapshots. Cosmokit owns the shared protocol. General comparison treats two volatile references as equal. Loader calculates raw config differences using schema-declared volatile paths and retains raw config for subsequent activation. When the raw diff reports no ordinary change but the raw config differs, Loader parses and validates the candidate through the fiber's `internal/config` hook, compares ordinary effective values, commits references when those values still match, and notifies the owning fiber; every update path, including profile reconciliation, HMR Include refreshes and direct `entry.update()` calls, reaches this step through `Entry.update`. Fiber does not own this update policy, and HMR supplies file watching.

Only volatile changes preserve the instance. Ordinary-field changes use the existing remount lifecycle and do not update the old references. An instance-local `loader/volatile-update` event reports paths after the complete candidate is validated and all references are committed. It uses ordinary `emit`; listener completion is not a configuration commit condition. References can be retained, while values may only be captured for one operation. Missing optional values retain a readable reference.

Config schemas own the field types, defaults, roles, and live-update declaration needed by schema-driven settings forms. Existing settings consumers remain unchanged; automatic form generation and their migration are separate work. The [configuration guide](../../../../docs/cordis-tutorial/05-config.md) owns plugin-author usage.

## Alternatives considered

**Restart for every configuration change.** This releases resources that remain valid when only operation-time parameters change.

**Add another settings-specific live-value API.** It duplicates runtime update semantics and makes plugins depend on settings to consume ordinary configuration.

**Wrap values only during mounting.** Direct schema parsing would return a different kind of value from the plugin's config, requiring separate consumer types.

## Consequences

Schemas reject independent volatile references inside dynamic containers; entire objects and arrays can be volatile values. Immutable snapshots accept plain data. Simplification unwraps references, and shared symbols support ESM/CJS copies. Group/Include retain dispatch while volatile-only target updates bypass `internal/update`. Direct `fiber.update()` retains its semantics, including custom handling, saving and `noSave`. Loader commits live volatile updates itself; no separate plugin is required.

Schema metadata keeps comparison independent of parsing: the diff does not execute expressions, validators or config hooks. Object nodes compare missing or null values using their declared defaults, even without volatile descendants; this avoids remounts for equivalent object defaults. Ordinary expression edits retain raw comparison even when they resolve to equal values. Loader compares parsed ordinary values, including URLs by normalized address. If an ordinary expression produces a different value, Loader applies the ordinary remount instead of committing; strict comparison treats class instances other than URL, Date and RegExp by identity, so an ordinary transform that builds a fresh instance per parse always remounts. Listener failures during the notification are logged and do not fail the update. Loader validates volatile candidates before committing; invalid edits remain in raw config but leave running references unchanged until a later activation.

The schema and lifecycle regression suite covers direct updates, invalid candidates, instance isolation, dependency replacement, real file watching, and save/reload behavior. The HMR module suite covers replacement after live config updates. These tests do not claim settings migration or automatic form rendering.
