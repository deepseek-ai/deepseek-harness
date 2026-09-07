# Agent Note: Settings describe mirror

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-17-settings-describe-mirror.zh.md)

## Problem

A cold web boot issued `settings.describe` fifteen times inside ~200ms, and the count grew by two with every client plugin that owned a preference. Two mechanisms stacked: `SettingsScopeBinder.bind()` started a full-document read per bound scope (six scopes in the product composition, plus the plugin-directory tab, the welcome gate, and the models onboarding join), and `onConnected` emits `connection/reset` on the FIRST connection too, so every one of those readers immediately re-read the answer it had fetched milliseconds earlier. Each reader also carried its own invalidation subscriptions and its own `refreshIfLoaded`-style guard, and fifteen independent reads could in principle land on fifteen different document revisions.

## Decision

**One reader, many derivations.** `dsh-client-ui-settings` owns `SettingsDescribeMirror`, the single `settings.describe` reader in the browser: one snapshot store holding the whole answer, refreshed by the owning plugin's two subscriptions (`settings/document-updated`, `connection/reset`). Concurrent `load()` calls fold into the in-flight read plus at most one rerun. The in-flight slot owns a run before its loading publication can synchronously reenter `load()`, then clears inside the run's own try/finally in the same synchronous segment that observes the rerun flag; a `.finally()` on the returned promise would run one microtask later and let a refresh landing in that gap mark a rerun nobody reads.

`bind()` still returns the unchanged `SettingsScope<T>` face, but the controller is now a selector over the mirror: no read path of its own, the same decode rules, and the write queue kept. A committed write folds its answered view back into the mirror (`acceptView`), so sibling scopes see the new revision with no re-read; the fold invalidates any older in-flight answer, and a write before the first held document reruns that read instead of publishing a partial document. A failed latest write triggers one mirror recovery read. Cross-namespace surfaces — the plugin-directory tab, the permission row (its dynamic enum lives in the namespace schema, which scopes deliberately do not carry), the models join, the agent-preset row's writability, and `hasDocument` — consume `ctx.settingsScope.describe()`, the shared read/fold face (`getSnapshot`/`subscribe`/`ensure`/`acceptView`).

This decision updates the browser read and invalidation mechanics recorded by [Host-backed Web preferences](../bug-fix/2026-08-06-host-backed-web-preferences.md) and [plugin-owned settings surface](2026-08-12-plugin-owned-settings-surface.md), while preserving their preference-ownership and namespace-exposure decisions. It also replaces the direct settings-read description in [official DeepSeek first-run credential setup](../feature/2026-07-30-deepseek-onboarding-credential-setup.md); that join now derives its settings half from this mirror.

The cold-boot budget is pinned at two reads by `apps/web/tests/startup-rpc-budget.e2e.ts`: the mirror's eager bind-time read, plus the first-connection reset read, which is kept deliberately — it closes the window where a document commit lands between the eager HTTP read and the SSE subscription and its invalidation is lost. The plan's original target of one read is unreachable without either accepting that lost-invalidation window or delaying the first read until after the SSE stream opens.

## Alternatives considered

- **Single-flight sharing inside `bind()` only** — deduplicates the concurrent bursts but keeps N direct readers, N subscription sets, and the revision skew; readers outside the binder (welcome, models, tab, permission) gain nothing. Rejected as treating the symptom.
- **Boot-payload embedding** (host inlines the describe answer into the page boot) — saves the first read but adds a second acquisition path with its own staleness rules on top of the mirror it would still need. Deferred; it composes with the mirror if ever wanted.
- **Per-namespace `settings.describe(ns)`** — shrinks each answer but keeps one read per consumer, so the fan-out and the growth rate stay. Rejected.
- **One read (no first-reset re-read)** — reachable only by accepting the lost-invalidation window between the eager HTTP read and the SSE subscription, or by delaying the first read until the stream opens; both trade correctness or first-paint freshness for one loopback request. Rejected in favor of the pinned two.

## Consequences

- Startup `settings.describe` went 15 → 2, and a new preference-owning plugin adds zero reads.
- Every derived surface shows the same document revision at any moment; the per-reader guards (`refreshWelcomeIfLoaded`, `refreshPermissionIfLoaded`, `refreshDocumentIfLoaded`) and their subscriptions are gone.
- The mirror refreshes on every document commit regardless of namespace, so an external settings edit now costs one background read even while no settings surface is open — the price of surfaces that open already fresh. The per-namespace `ns !== spec.namespace` filters are gone with the per-scope subscriptions.
- `credentials/describe` (3 startup calls), `agentPresets/list` (2), `llm/listProviders`, and `llm/listConfigurableProviders` are separate sources and stay direct; the same mirror pattern fits them if they ever need it.
- A new direct `settings.describe` caller in client code is a budget regression; the e2e's failure message says to grep for callers outside `ui-settings`.
