# Agent Note: Share Host preferences with every authenticated browser

Status: implemented

English | [中文](2026-09-15-authenticated-browser-host-preferences.zh.md)

## Problem

[Persist Web user preferences through Host settings](../../archived/bug-fix/2026-08-06-host-backed-web-preferences.md) chose the preference store by page locality, so a non-loopback page kept Appearance, Language, busy-Enter, and the welcome acknowledgement in a process-local copy. A trusted remote host, and a deployment published behind the configured public URL, therefore lost every choice on reload even though Connection authenticates the complete settings API. The second mode also split the shared runtime: theme, locale, the settings shell, the Models page, and the welcome notice each rendered a durable row that could never persist for a remote page.

## Decision

Locality selects nothing. One `settings.describe` mirror, one `ctx.configForms.get(entryId)` per namespace derived from it, and the `settings.mutate` write path serve every authenticated browser. Browser token authentication of the Connection API is the identity boundary; the fixed `remote.$host` locality facts are request-routing evidence that no store selector consults. The mirror's state space is `idle`, `loading`, and `ready`, a form snapshot carries no mode, and a form reports `unavailable` only for a namespace the Host did not register.

The settings shell keeps one locality-dependent UI element: it builds its document controller from `ctx.remote.$host.isLoopback`, so only a loopback page renders **Open configuration file** and issues the `hasDocument` read behind it. The `settings/openSettingsDocument` Remote itself stays browser-authenticated like every other Host method; the omission is a presentation choice for pages that cannot see the Host's native editor, not a persistence rule.

## Alternatives considered

**Keep the memory-branch locality gate.** Rejected: browser token authentication already covers every Host method for remote pages, so the gate protected nothing, and locality is request-routing evidence rather than identity. It also made every Host-backed row inert on trusted remote and public deployments.

## Consequences

Every authenticated browser reaching one Host shares one preference document. Two browsers on the same deployment observe each other's Appearance, Language, busy-Enter, and welcome-acknowledgement choices, and a value written remotely is the value a loopback browser loads next. Preference access is governed by API authentication and `settings.describe.writable`.

A remote page omits the **Open configuration file** action, the one locality-dependent UI element that remains. Concurrent writers on one document resolve through the namespace revision each form sends as `expectedRevision`.

## Testing

Focused unit coverage pins the contract: the ui-settings mirror and configuration-form suites construct both objects with no persistence selector, the theme apply spec persists from a non-loopback bench and asserts the Host write, the ui-settings-general apply spec keeps the shared describe read and the Host write path off-loopback while asserting the native document action stays unregistered, and the welcome store retains its acknowledgement across a settings-plugin recreation. The keyless Web settings scenario `apps/web/tests/remote-settings.e2e.ts` acknowledges the welcome notice, configures a model provider, and selects the dark Appearance from a trusted remote page, reloads after each, and re-asserts the welcome, model, and Appearance state from the Host settings document.
