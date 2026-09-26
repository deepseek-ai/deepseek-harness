# Agent Note: Keep live configuration in the owning profile

Status: implemented

English | [中文](2026-09-19-profile-owned-live-configuration.zh.md)

## Problem

Separate settings registrations duplicated schemas, defaults, persistence, and notifications. They also placed stored user settings above deployment overlays without preserving which composition source supplied a value. Using the Loader's resolved Config gives validation and consumers one owner and preserves its lifecycle decisions.

## Decision

A plugin declares every configurable value in its Cordis Config. Fields that can change without remounting use `.volatile()`; consumers read their references during operations. Settings enumerates those fields for forms and never supplies business configuration. The profile editor writes `cordis.patch.yml` and applies the ordinary Loader reconciliation path.

Form writes target the active profile. Home patches and command-line overlays remain higher-priority deployment inputs; an edit they would shadow fails before persistence. Two plugin instances are addressed by their distinct profile entry ids. Nested Includes retain independent ownership and are not writable through the profile form.

Cordis config patches replace complete entry configs. An edit preserves ordinary fields and unedited secrets, including raw configuration expressions. A field reset restores the currently inherited value; resetting the complete entry removes its config overrides so later bundle changes are inherited. Other edits store the entry's complete config in the profile row: the ordinary fields as composed at write time plus every volatile field. Later bundle changes to those fields do not reach that profile until the entry's config override is removed. In the shipped bundles this pins `permission.presets` after a default-preset change, `agent-presets` after a preset choice, `agent-loop.agents` after a parallelism edit, and `web-search-deepseek.apiKeyEnv` after a Web Search edit, and the client marks every volatile field of such a row as overridden, not only the edited one. Narrowing a write to the edited fields needs merge semantics for patch `config`, which Include does not provide.

The removed `$DSH_HOME/settings.yaml` is imported once into the active profile when the Loader has settled every entry after Settings starts: section ids are entry ids, with `ui-developer-tools` → `ui-settings`, `ui-onboarding` → `ui-settings-general`, and `shell` → the platform's shell executor entry. The file is renamed to `settings.yaml.imported` before the first write, so the import never repeats; a rejected section is logged and stays in the renamed file.

## Alternatives considered

The rejected alternative is retaining settings as a second store behind a configuration adapter: that still requires reconciling two durable documents and deciding which wins after concurrent edits or restart. The removed global settings document offered cross-profile preferences; this design deliberately makes persisted form values profile-specific. Reintroducing shared preferences requires an explicit shared Cordis layer and a defined write destination.

## Consequences

This supersedes only the non-secret settings tier in [configuration source ownership](2026-08-04-configuration-source-ownership.md); its environment restrictions and credential ordering remain applicable. [Volatile references](2026-09-18-volatile-config-references.md) own reference lifetime and ordinary update behavior.

Real profile tests cover multiple instances, persisted restart, invalid edits, stale revisions, higher-layer rejection, secret redaction, and configuration expressions. Browser tests exercise form writes and reset through the assembled application. Runtime reference identity is checked across live edits.
