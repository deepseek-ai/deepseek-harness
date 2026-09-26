# Agent Note: Persist Web user preferences through Host settings

Status: implemented

English | [中文](2026-08-06-host-backed-web-preferences.zh.md)

## Problem

The Web Appearance, Language, and busy-Enter preferences lived in browser `localStorage`. Browser storage is scoped to an origin, so reopening `dsh web` on another port selected a different partition and lost choices even though both processes used the same DSH home. These are user-level product preferences; session selection, drafts, disclosure state, and other transient browser state remain page-local.

The first theme implementation moved only Appearance to Host settings but awaited its initial RPC before providing `ThemeRuntime`. A slow or unavailable settings request therefore suspended the assembled page. It also subscribed after the read, could miss an invalidation in that window, did not carry namespace revisions on writes, and allowed queued writes from a disposed plugin to reach the Host.

## Decision

The owning Host Config schemas declare volatile locale, theme, and busy-Enter preferences. ConfigEditor stores explicit choices in the active profile patch. The authenticated settings API projects those Config fields and redacts secret roles.

`dsh-client-ui-settings` owns one browser-wide settings describe mirror and provides `ctx.configForms.get(entryId)` as a per-namespace selector over it. The mirror installs `settings/document-updated` and `connection/reset` listeners before starting its background read, so no settings transport can block plugin activation and an invalidation cannot fall into a read-before-subscribe gap. Each shared entry form publishes a snapshot store (status, section value, revision, writability, host/memory mode) the domain service subscribes to, without adding a wire read or listener of its own. The default decoder validates each incoming section against the namespace's own serialized wire schema, rehydrated through the colocated `ctx.settingsSchema` service, so domains carry no hand-written wire guards. Domain services take the scope as an ordinary constructor collaborator, publish their provisional defaults immediately—browser-derived locale, system theme, and Queue—then adopt an accepted Host section without writing it back; a service constructed without a scope (standalone dictionary or policy fixtures) simply stays process-local. The shared read and invalidation lifecycle is specified by the later [settings describe mirror decision](../../archived/architecture/2026-08-17-settings-describe-mirror.md).

User changes update the live preference immediately and queue a revision-fenced mutation through the shared entry form. The provider owns one write queue per entry; consumers release their subscriptions when they unload. Provider disposal skips queued work, suppresses late publication, and waits for the in-flight operation.

The Client keeps Host persistence disabled on non-loopback pages, so their preferences remain process-local even though Connection authenticates the complete API. Dynamic third-party theme ids remain in-process extensions outside the built-in Host schema; removing one resets the live registry without replacing the last durable built-in preference.

## Alternatives considered

**Keep `localStorage` and copy values between ports.** One origin cannot enumerate another origin's storage, and a Host relay would recreate the settings service around a browser-specific format.

**Mirror Host settings into `localStorage`.** A second authority requires boot and invalidation conflict rules while retaining the partition that caused the defect. The Host document is the sole durable source.

**Await the initial read to avoid a provisional render.** Configuration availability is not a prerequisite for drawing the page. A background read may cause one live convergence, but it keeps failure isolated and preserves the existing browser/system/default fallbacks.

**Give every domain its own settings controller.** The concurrency, revision, failure, invalidation, and disposal rules are identical; copying them already produced lifecycle drift in the theme implementation. Domain-owned schemas keep product policy out of the shared runtime.

**A per-field preference controller with paired sync/persist callbacks.** The first shared lifecycle synchronized one scalar field through a domain `sync` callback while the service wrote back through an injected `persist` callback. The mutual callbacks forced two-phase construction — a defaulted no-op writer later replaced via `bindPersistence` — every additional field of a namespace would have carried its own controller and whole-document read, and each domain re-declared a hand-written guard the registered wire schema already expresses. The namespace scope publishes a snapshot the service subscribes to and accepts writes directly, so the callback pair and the second construction phase do not exist.

**Move every `localStorage` entry into settings.** Current session, drafts, panel disclosure, trajectory display state, and similar entries are browser-instance state rather than user configuration. Promoting them would synchronize transient navigation state across tabs and ports without a product contract.

## Consequences

Appearance, Language, and busy-Enter choices follow the active profile across reloads, ports, and loopback origins. ConfigEditor and volatile HMR apply profile changes; the form mirror follows accepted values through settings invalidations. Legacy browser preference keys remain unused.

Boot may briefly show the domain default before the background read settles. A transient read failure keeps that default or the last good in-process value; reconnect retries. A write rejection can visibly restore the durable preference after the immediate local change.

Focused unit coverage pins schema registration, listener-before-read ordering, nonblocking activation, schema-validated section acceptance, revisioned ordered writes, stale-response containment, failure recovery, disposal quiescence, and remote memory mode. The namespace-granular scope also carries multi-field sections, so later configuration surfaces can ride the same lifecycle instead of hand-rolling describe/mutate synchronization. The keyless Web settings scenario writes all three preferences through the UI, verifies the YAML document and empty legacy storage, reloads, and boots another Host on a distinct port against the same DSH home.
