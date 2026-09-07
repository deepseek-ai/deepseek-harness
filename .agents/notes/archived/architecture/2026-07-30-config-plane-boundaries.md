# Agent Note: what the configuration plane exposes, and who may overwrite what

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-config-plane-boundaries.zh.md)

> Scope: boundary hardening of the [web configuration plane](2026-07-30-web-config-plane.md) — which namespaces reach the wire, which callers reach them, and how an editor holding a partial, possibly stale view writes without destroying what it cannot see.

> The caller boundary, the redaction, and the revision fencing remain current. Restricting which namespaces reach the wire to the configurable-provider directory is superseded by the [plugin-owned settings surface](2026-08-12-plugin-owned-settings-surface.md), which serves every registered namespace.

## Problem

The plane worked and was reachable by more callers, and with more authority, than its design claimed.

`trustedHosts` gated only writes, so a declared LAN client could call `settings.describe` — every exposed namespace's configuration — and `credentials.describe`, which reports whether an arbitrary environment-variable name is configured and where it resolves from. That fence is a DNS-rebinding defense and says so; treating it as an authorization boundary for reads was a category error. Separately, the proxy served every registered namespace: the settings seam is deliberately general, so the first plugin to call `settings.register()` for its own configuration would silently become remotely readable and writable, without passing anywhere near a review of the web surface.

The editor was worse than reachable — it was destructive. It reads the redacted descriptor, which by construction omits `role('secret')` fields. Clearing one field rebuilt the whole user section from that redacted copy and sent `settings.replace`, so a stored literal `apiKey` the wire had never returned was deleted as a side effect. Reproduced directly: `{baseURL, reasoning}` in, `apiKey` gone. Row removal took the same path. And nothing carried a version, so two tabs editing one namespace silently overwrote each other; the seam's per-namespace write queue orders writes but cannot tell a fresh writer from one replaying a stale snapshot.

Three smaller defects sat beside them. `llm/adapters-updated` documented contained observer failures but only caught synchronous ones, so an async listener's rejection escaped as an unhandled rejection. llm-deepseek's retry-policy swap disposed its registration before re-registering, publishing an empty route set between the two — an observer saw the provider disappear and come back, despite a comment claiming no such window. And a transport rejection during the page's credential enrichment escaped `load()`, stranding the page in `loading` with no error shown.

## Decision

**Reading configuration is as privileged as writing it.** `settings.describe`, `credentials.describe`, the model catalog, and every other Host operation require one browser session. The configuration plane still redacts secrets independently of authentication. The boundary is asserted over a real HTTP server rather than a hand-assembled request, proving that a forged loopback `Host` value never establishes identity.

**The plane serves exactly the namespaces a registered model provider addresses.** `ctx.llm.listConfigurableProviders()` is the allow-list, so the product boundary is enforced rather than inferred from the installed plugin set, and a future namespace becomes web-configurable only by joining that directory. An unregistered namespace and an unexposed one answer identically (`settings-not-exposed`), so probing cannot enumerate the registry.

**A caller with a partial view names the field it means.** `SettingsProvider.mutate(ns, ops)` applies `set`/`unset` path ops to the section as it stands at the front of the write queue. The client builds ops by diffing its opening snapshot against its draft, so it mentions only fields it can see: a secret absent from both sides produces no op and survives by construction, not by care. `replace` remains the deliberate wholesale reset.

**Staleness is detected, not ordered away.** Each namespace carries a monotonic `revision` over its RAW section; writes may carry `expectedRevision`, and a mismatch rejects with `SettingsConflictError` → `settings-conflict` on the wire, both revisions attached. The editor captures the revision it opened at and, on conflict, tells the user to reopen rather than replaying its snapshot.

**The raw layer gets its own event.** `settings/updated` stays gated on the resolved value — that is what a consumer means by change. `settings/document-updated (ns, revision)` fires on any raw-section change, because a configuration surface must learn that a field went from inherited to overridden (same resolved value, different meaning) and that its held revision is stale. The event is forwarded verbatim, and model consumers subscribe to it alongside `llm/adapters-updated`, because provider settings hold catalog data that no route change announces.

## Alternatives considered

- **A deployment-declared namespace allowlist on the proxy config** — more general, but it moves the product boundary to whoever writes cordis.yml, and an empty default would break the shipped page until every deployment opted in. The provider directory already states exactly which namespaces are model configuration.
- **Opt-in metadata at `settings.register()`** — the most honest semantics (the namespace's owner declares its own exposure), and the largest change: the seam's public interface, both LLM plugins, and their docs. Recorded as the shape to adopt if a non-LLM namespace ever needs the plane.
- **Distinguishing "unregistered" from "registered but unexposed"** — better diagnostics, and a namespace-enumeration oracle. The uniform answer is deliberate.
- **Detecting conflicts by diffing instead of a revision** — comparing the submitted base against storage would work for whole-section writes, but the editor holds a REDACTED section: it cannot produce a comparable base, which is the same reason it cannot safely `replace`. A counter needs neither.
- **Fixing the redaction gaps here** — `redactSecrets` walks only `object`/`dict`/`array`, so a secret behind a union, intersection, or transform is returned verbatim with an empty `secrets` list; `schema.toJSON()` carries a secret field's `.default(...)`; write-rejection messages return schema text that may quote the input; the client rehydrates the envelope through schemastery's `new Function`; and pi-ai's plain-string `headers` dict can legitimately hold `Authorization`. All real, all deliberately left for a fail-closed `describeForWire()` that refuses a schema it cannot prove safe. They are recorded as `TODO(settings-wire-redaction)` and in the owning READMEs' Known Limitations rather than half-fixed here.

## Consequences

A LAN client on a `trustedHosts` deployment can no longer render the settings page at all; loopback is the configuration surface. A plugin that registers a settings namespace is not web-configurable until it also registers a configurable provider — deliberate, and the reason `settings-not-exposed` names the boundary in its message. `SettingsDescriptor` gained a required `revision`, so any programmatic constructor of a descriptor-shaped value must supply it, and `settings/document-updated` is a new event any provider-side listener may now observe. Clients that ignore `expectedRevision` keep last-write-wins semantics unchanged. Deferred: the fail-closed wire describe (with the `headers` and envelope-sanitization work it carries), and a non-executable browser schema protocol.
