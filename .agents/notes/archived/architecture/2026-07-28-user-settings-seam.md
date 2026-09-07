# Agent Note: user-settings seam (`ctx.settings`) and the file provider

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-28-user-settings-seam.zh.md)

> Scope: the `packages/settings/` capability family — the Service Definition, the file-backed provider, and the composition boundary between user settings and `cordis.yml`. The [web config-tree note](2026-07-24-web-config-tree-boot-and-transport-layering.md) recorded "the profile write path" as a deferral; this seam is that write path's owner. Consumer migrations (theme, locale, default model route) and the web `settings.*` RPC surface are follow-ups, not part of this note's shipped scope.

## Problem

User-editable configuration had no owner: `dsh web` read a cwd-anchored profile json through a static whitelist with no write path, the TUI read `$DSH_HOME/config.yaml` raw loader patches, and both froze at boot. A personal-settings page (web GUI) needs one cross-surface user layer with schema validation, a write path, and hot propagation — and peer products (Codex, Claude Code, Kimi, OpenCode, Pi) all converged on separating user preferences from extension composition. Loader-reactive config updates cannot carry this: `fiber.update` swaps entry config in place, so a plugin that read config at construction observes nothing and no callback tells it otherwise.

## Decision

**Two planes with a litmus test.** `cordis.yml` (+ Include patches) stays the composition plane: which plugins exist, wiring, deployment config, owned by the orchestrator and upgraded with the product. A settings namespace carries only the user-editable subset; the test is "should the personal config page edit it?" Values live in both planes without ambiguity because layering is the contract: schema defaults, then the registrant's composition `base` (its entry-config subset), then the user document section.

**Three-package boundary mirroring `session-persistence/`.** `dsh-settings` owns the abstract `SettingsProvider` service: namespace registry, layered resolution, schema validation, per-namespace deep-equal change detection, and the `settings/updated` commit event. Providers implement only `writable`/`load()`/`persist(ns, section)` and push externally observed documents through the protected `publish(doc)` — so hot-update semantics are identical across providers, and a network configuration-center backend (nacos-style, possibly read-only) is a sibling package away. `dsh-settings-file` is the file provider: YAML/JSON under `resolveSpec` (explicit defaulting to `<DSH_HOME>/settings.yaml`), chokidar watch, read-modify-write persists under a cross-process writer lock with atomic `0600` tmp+rename commits, leaf-level diff patching of the written namespace (comments survive untouched nodes), and content-equality self-write suppression ([write-path integrity note](2026-07-30-settings-write-path-integrity.md)).

**Registrations are caller-fiber effects.** `register()` runs through the service proxy, so `this.ctx` is the registrant's context and the registration rides `ctx.effect`: disposing the registrant removes the namespace and its watchers (proven by the HMR disposal test), while the user's section keeps living in storage for the next owner.

**Fail loud at rest, last-good in motion.** Boot-time and registration-time validation throw (invalid stored section fails the registering plugin; an existing-but-unparsable document fails provider load). Once live, a bad external edit warns and keeps the last good state per namespace — a hot reload must never take the process down. This asymmetry mirrors `Include.refresh()` and Kimi's safe runtime reload.

**Consumers stay optional-by-construction.** A consumer registers inside `ctx.inject(['settings'], …)`; without a mounted provider it keeps resolving entry config alone, so every existing composition, demo, and snapshot works unchanged and migration is per-plugin.

## Alternatives considered

- **Include write-back as the user layer** (per-plugin config pages writing loader entry files, cordis-webui style): write-back would target per-composition files, binding user preferences to one `cordis.yml`; a per-user layer must survive template upgrades and serve TUI and web from one document.
- **Loader-reactive `fiber.update` as the propagation channel**: constructor-time reads observe nothing; the seam's explicit `watch()` makes hot-update a consumer contract instead of framework magic.
- **A domain-aware settings service** (getters per product area): rejected as coupling; the service stores, validates, and publishes — domain meaning stays with the registrant that owns the schema.
- **Multi-layer precedence now** (system/managed/project tiers à la Codex/Claude Code): deferred until a real second layer exists; the resolve step is the single place layering would extend.
- **A cross-process lockfile now** (Pi's proper-lockfile): initially deferred as "atomic replace plus watcher convergence until real contention shows up" — but convergence loses unobserved sibling namespaces, so the deferral is superseded by the [write-path integrity note](2026-07-30-settings-write-path-integrity.md)'s hand-rolled writer lock.

## Consequences

Deferred, in dependency order: the web `settings.raw`/`settings.describe`/`settings.update` RPC surface (which must redact `role('secret')` fields before exposure); first consumer migrations (`ui-theme`, locale, api-gateway default route) retiring `PROFILE_MAPPINGS` and the profile json; `${env:VAR}` value indirection for secrets; provider-side layering. The keyless snapshot obligation lands with the first model- or product-user-visible consumer, not with this infrastructure step.
