# Agent Note: Meaningful package invariant contracts

Status: implemented

English | [中文](2026-07-19-package-invariant-runtime-contracts.zh.md)

## Problem

The package-owned invariant service made publication and registration exhaustive, but its first generated baseline accepted empty installers. A follow-up then replaced those empties with generic assertions about plugin names, injections, effects, service methods, and fixed pure-library examples. Those assertions made every companion executable without making the system safer: TypeScript, Cordis startup, package tests, and module-load tests already enforce those shapes, while the invariant service should detect impossible runtime state.

A useful runtime invariant relates observations over time or across a mutable data structure. Examples include a terminal event without its start, an LLM delta for a block that is not open, or a durable result whose identity differs from its request. Merely confirming that a declared method exists, that a plugin has its expected name, or that a constant example still returns a known value is not such a relation.

Some packages genuinely own no continuously observable relation. Pure utilities, composition-only packages, thin adapters, binaries, and test-support packages may have important contracts, but those contracts are better enforced by types, load checks, focused unit tests, or integration tests. Requiring a synthetic runtime assertion for those packages would optimize for satisfying a gate instead of detecting corruption.

## Decision

### Published assertions must be meaningful

A workspace package publishes a separately built `./invariant` companion only when it owns an independently observable runtime relationship. A published companion:

- installs a package-owned check over an event stream or relevant mutable data structure and reports violations through its bound `fail(message)` reporter; and
- registers the package's exact npm name while keeping diagnostics outside the root entrypoint.

When no plausible relationship exists, the package omits the companion and publication wiring and records its package-specific reason in the README. A future change that introduces an independently observable relationship must replace the explanation with the corresponding check. The omission mechanics and current audit are owned by the [omit-unneeded-companions decision](../simplification/2026-08-28-omit-unneeded-invariant-companions.md).

The central `dsh-invariants` service owns only configuration, registration uniqueness, child-fiber lifecycle, rollback, disposal, and package-attributed failure. It exposes no generic plugin-shape, service-shape, or startup-assertion helpers and imports no product package.

### Representative implemented checks

Published companions are enumerated mechanically by `verify-package-invariants`; the current audit count is recorded in the [omit-unneeded-companions decision](../simplification/2026-08-28-omit-unneeded-invariant-companions.md). The table below samples representative runtime relationships rather than listing every companion.

| Owner | Runtime relationship |
|---|---|
| `dsh-session` | Strict sequence growth, turn/step enclosure, and same-step tool call/result pairing. |
| `dsh-agent` | Non-repeating agent status and terminal disposal transitions. |
| `dsh-scope` | Scoped-event carrier presence and routed-subject consistency. |
| `dsh-agent-loop` | Explicitly marked, frozen loop request reconstruction from the session event log. |
| `dsh-llm` | Stream block grammar, delta type/index matching, single usage, closed blocks, and terminal finish. |
| `dsh-llm-retry` | Durable retry records identify the open turn's latest closed step, remain unique per step, increase monotonically, and stay within retry and non-negative timer bounds. |
| `dsh-tools` | Monotonic pre/execute/post stages and immutable final execution/result snapshots. |
| `dsh-system-prompt` | Authoritative assembly section, tool, and variable data constraints. |
| `dsh-compaction` | Compaction start/summary/end pairing, range endpoints, token counts, and successful-summary presence. |
| `dsh-hook-protocol` | Hook invocation/result correlation, dialect, identity, and duration constraints. |
| `dsh-sandbox-policy` | Durable `sandbox/mode` events use the closed sandbox-mode vocabulary. |
| `dsh-fs` | Filesystem decision/observation events carry usable target and version identities. |
| `dsh-goal` | Durable goal snapshots preserve source attribution, rendered content, revisions, lifecycle and timestamp relationships, and sequential admitted rounds. |
| `dsh-goal-round-driver` | Goal-sourced continuation messages match the prompt reconstructed from the preceding durable goal state. |
| `dsh-subagent` | Provider add/remove and child start/end events preserve identity and pairing. |
| `dsh-permission-presets` | Durable permission decisions name a preset in the active permission table. |
| `dsh-user-approval` | Approval asked/decided records pair by call and use valid outcomes and policies. |
| `dsh-workflow` | Workflow and child-agent start/end events preserve run metadata, identity, outcome, count, and error relations. |
| `dsh-jobs` | Current and terminal task snapshots preserve id/kind, owner, status, and timestamp relationships. |
| `dsh-tool-todo` | Durable whole-list snapshots use unique trimmed items and closed statuses. |
| `dsh-time-context` | Plugin-attributed clock readings agree with the session's open turn, next pre-step position, and elapsed baseline; rendered time parses and does not postdate its event. |

Session-backed companions validate existing durable events when they load, using the prefix preceding each candidate where the relationship depends on event order. Other checks observe the authoritative live event boundary or mutable service result. Validation runs before publication where accepting an invalid event would otherwise commit bad state.

### Repository gate and tests

`verify-package-invariants` discovers every workspace package. It accepts clean omission, rejects stale or partial companion wiring, and enforces exact-name registration, named-only Loader shape, `./invariant` exports, publication files, dependencies, TypeScript references, and bundle entries for published companions. Its AST rule rejects generated markers, default exports, and empty installers. Every installer must accept and use the failure reporter, and registration must pass that checked local `install` function. The gate deliberately does not infer semantic quality from method names or helper calls.

Vitest mounts `InvariantRegistry` with `{ enabled: true }` for every package test topology and loads the owning companion when one is published. The invariant subpath path mapping resolves source companions instead of stale built output. Focused suites cover every published companion's valid and invalid observations, and the exhaustive topology runs every source companion through real Loader namespace normalization. After the structural gate validates each publication map, an artifact gate stages its manifest-declared `lib/` files, imports the compiled `./invariant` self-reference under plain Node, and repeats that Loader-shape check, so a companion that imports an undeclared runtime chunk fails before release. Tests that synthesize event streams must produce a valid surrounding lifecycle unless the test is intentionally asserting a violation.

## Alternatives considered

- **Keep explained empty companions.** Rejected because source, publication, dependency, and test wiring are disproportionate machinery for a negative conclusion that belongs in the package README.
- **Require an assertion from every package.** Rejected because method-presence, plugin-shape, and fixed-example assertions duplicate stronger type, load, and unit-test contracts without checking runtime consistency.
- **Keep generic shape helpers in the service.** Rejected because they blur compile-time API validation with runtime invariants and encourage centrally defined product assumptions.
- **Move the product checks into the service.** Rejected because product vocabulary, dependencies, tests, and change ownership belong with the package that emits the data.
- **Register companions implicitly from root entrypoints.** Rejected because composition order and optional service presence would create hidden effects.

## Consequences

- Packages with a plausible runtime relation have visible ownership and publication wiring; packages without one record the omission reason in their README.
- Empty companions fail the gate, and partial omission wiring fails before build or release.
- Type declarations, Cordis loadability, plugin metadata, service method APIs, and pure algebra remain covered by their owning compile, load, unit, or integration gates.
- Runtime failures identify the owning npm package and point to an inconsistent observation rather than restating a required API shape.
- The original selection, blocklist precedence, duplicate ownership, rollback, disposal, and HMR service contracts remain unchanged.
