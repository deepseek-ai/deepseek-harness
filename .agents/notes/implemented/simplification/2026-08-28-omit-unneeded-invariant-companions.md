# Agent Note: Omit invariant companions without independent observations

Status: implemented

English | [中文](2026-08-28-omit-unneeded-invariant-companions.zh.md)

## Problem

The package invariant rule required every workspace package to publish `./invariant`, including packages with no runtime relationship to check. The current workspace had 209 explained-empty companions, each carrying a source file, public export, publication entry, invariant-only dependencies or TypeScript references, build wiring, and registration tests. That machinery expressed a negative conclusion without adding a runtime assertion.

The `dsh-host-webserver` companion exposed the same problem in executable form. It registered and disposed synthetic reserved routes on plugin lifecycle events, then called the same service operations again to detect residue. The probe had no independently produced observation: it mutated and inspected one route table through the implementation it claimed to verify, while real route and HMR tests already covered duplicate rejection and disposer symmetry.

## Decision

### Independent observations justify publication

A package publishes `./invariant` only when it can compare observations that may independently diverge. Qualifying relationships include cross-event lifecycle, ordering, identity, or pairing protocols; events compared with authoritative mutable state; output assembled from multiple producers or adapters; and durable data later folded or consumed by a different operation.

Service or method presence, plugin metadata or effects, fixed pure examples, and probes that call the same mutation they claim to verify remain type, load, unit, or integration-test concerns. Parser and config input, model or tool JSON, durable files, worker and process messages, and wire input remain validated at their owning input operation.

The `dsh-time-context` companion remains published. Its check compares the plugin-produced context message with independently owned current-turn user-message provenance and durable event time, so attribution, turn position, and elapsed-time relations can diverge even when the formatter itself is correct.

### Omission is explicit in the package README

A package without a qualifying relationship omits `src/invariant.ts`, the `./invariant` export, `lib/invariant.js` publication, invariant-only dependencies and TypeScript references, build entries, and companion-only tests. Its English and Chinese package READMEs state that no companion is published and give the package-specific reason. Empty installers are rejected because source absence plus the README explanation now expresses the decision directly.

`verify-package-invariants` scans every package. It requires a package-specific omission reason in the English README, rejects partial export, publication, or companion build wiring, rejects empty installers, and applies the registration, Loader namespace, reporter-use, dependency, reference, and build checks to every published companion. The Vitest host mounts the current package companion only when one exists, while topology and built-artifact checks enumerate the published set.

### Audit result

The repository-wide audit removed the 209 explained-empty companions and the synthetic `dsh-host-webserver` companion, leaving 39 checks with independent observations. The retained set includes cross-event protocols such as session, command, approval, workflow, and hook lifecycles; event-to-state checks such as settings, storage-domain, Workspace, client modules, and slots; multi-producer assembly such as system prompt and time context; and durable data consumed by projections or policy state such as todo, plan mode, and sandbox mode.

Existing package behavior tests remain responsible for omitted relationships, including webserver route registration and HMR disposal. Product behavior and root package entrypoints do not change; the omitted `./invariant` subpaths are removed under the repository's pre-release compatibility stance.

## Alternatives considered

- **Keep explained empty companions.** Rejected because a source file, public subpath, dependency edges, build output, and tests are disproportionate machinery for saying that no check exists; the package README records that conclusion directly.
- **Keep the webserver probe as a teardown sentinel.** Rejected because it mutates a reserved route on unrelated lifecycle events and verifies only the service method it invokes. Real routing and HMR tests exercise the behavior without production diagnostic effects.
- **Treat every producer-format parser as self-validation.** Rejected because a parser can compare independent provenance, timing, or durable history even when one producer owns the text. `dsh-time-context` qualifies because its message is checked against current-turn user messages and durable event time; a same-writer payload round trip alone would not qualify.
- **Require every package with mutable private state to publish a companion.** Rejected because private state without an independent event or second data source cannot be checked without duplicating the implementation or exposing new API solely for diagnostics.

## Consequences

- Packages with meaningful checks retain independently loadable, filterable, package-attributed companions.
- Packages without checks have no invariant source, public subpath, build artifact, or invariant-only dependency burden, and their READMEs preserve the reason.
- Adding a mutable relationship or consumed event protocol requires revisiting omission, updating the README, and adding a focused companion with a negative test.
- The invariant service configuration, ownership uniqueness, child-fiber lifecycle, filtering, rollback, disposal, and HMR contracts remain unchanged.
- The earlier [meaningful runtime-contract decision](../architecture/2026-07-19-package-invariant-runtime-contracts.md) remains authoritative for semantic check quality; this decision supersedes its exhaustive publication and explained-empty form.
