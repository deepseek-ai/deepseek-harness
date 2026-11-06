# Agent Note: Stable API policy

Status: proposed

English | [中文](2026-11-05-stable-api-policy.zh.md)

## Problem

Every public DSH API is pre-stable: root `AGENTS.md` tells contributors to update every consumer when an API changes. That rule works inside the repository, but external plugins now install from npm and the plugin market, and their authors cannot tell which APIs they can rely on. All released packages share one lockstep version, so a package version says nothing about which API changed. The only compatibility check, `evaluatePluginCompatibility` in [plugin-compatibility.ts](../../../../packages/boot/app-boot/src/plugin-compatibility.ts), compares a plugin's `engines.dsh` or `@deepseek-ai/dsh-*` peer ranges with the whole runtime version.

Nothing in the source marks stability today. Package exports carry no `@public`, `@beta`, `@stable`, or `@since` tags, and `@deprecated` appears only about a dozen times. The only rigorous compatibility rules cover data formats ([Session format status](../../../../docs/session-format-status.md), SQLite schema versions, persistence type acknowledgements) and [upgrade guides](../../../skills/dsh-create-upgrade-guide/SKILL.md).

The policy must start from this state. Contributors must not have to classify every API before the policy takes effect, and code that nobody marks must keep today's workflow.

## Proposal

Stability markers in source are the only input. A generated API report turns them into a versioned list of stable APIs for each release. The unit of versioning is the [capability seam](../../../../docs/glossary.md#capability-seam). Anything not marked stays unstable, so adoption proceeds one seam at a time.

### Stability levels

| Level | Meaning | Change rule |
|---|---|---|
| internal | Marked `@internal`; used only inside this repository, and excluded from the published API report | Change freely and update every consumer |
| unstable (default) | Every public export, service, event, and config field without a stable marker | Change freely, update every consumer, and record externally perceptible breaks in an upgrade guide |
| stable | Promoted explicitly as part of a versioned seam API | Backward-compatible additions only; a removal or incompatible change requires prior deprecation and a major seam version |
| deprecated | Stable API scheduled for removal | Removable only after the deprecation period has elapsed since its dated `@deprecated` marker; names its replacement or states that none exists |

Packages under [`packages/experimental/`](../../../../packages/experimental/README.md#status) cannot contain stable APIs; a package is promoted out of the experimental group before any of its APIs are promoted.

### Unit: one capability seam

Each capability seam has its own API version, independent of the lockstep package version. A seam's API covers its Service Definition, the types and events the Service Definition package declares, waterfall calling conventions, and the config fields of the Service Definition package. Config fields of Service Providers follow the level of their provider package. Exports that belong to no seam, such as utilities, CLI options, and the SDK wire protocol, stay unstable until a later proposal assigns them.

The package that declares a Service Definition records the seam in its manifest. One package can declare several seams, so the field is a list:

```json
{ "dsh": { "apis": [{ "name": "agent", "version": "1.0.0", "stability": "stable" }] } }
```

The field name and position are not settled yet. JSDoc tags override the seam level for individual members: `@unstable` keeps a member of a stable seam unstable, and `@deprecated YYYY-MM-DD <replacement or "no replacement">` starts the deprecation period. Members of declaration-merged interfaces such as `Context` and `SessionEventMap` are marked one by one.

### What stable covers

Stable covers type signatures, event order, and waterfall calling conventions, including whether a listener must call `next()`. Default config values are not covered. CI detects signature changes from the generated report. Behavior changes cannot be detected reliably, so the author declares them in the PR, following the pattern of [persistence type acknowledgements](../../../../docs/cookbook/reviewing-persistence-type-changes.md). This keeps changes that do not break callers from being reported as breaks.

### API report and CI

A script generates one checked-in API report covering exports, Cordis services, and events, with each entry's seam, level, and version. The deferred [API extractor reports](2026-06-11-api-extractor-reports.md) proposal is the first phase of this report. CI checks stable entries against the previous report and fails when:

- a stable entry is removed or changed incompatibly without a major seam version bump and an upgrade guide;
- a removed entry was not deprecated, or its deprecation period has not elapsed;
- a stable entry is added without a minor seam version bump;
- a stable signature references an unstable type.

Changes to unstable entries appear in the report diff without failing CI. CI also posts a summary of stable API changes to the PR. Promotion and breaking changes are approved in ordinary PR review; no dedicated API owner or committee is named.

### Plugin author warnings

A type-aware lint rule reports uses of unstable APIs, working the same way as `typescript/no-deprecated`, which [.oxlintrc.json](../../../../.oxlintrc.json) already enables: it resolves the called symbol and reads its level. Plugin authors run it in their own builds; the repository runs it on stable Service Definition packages. Subpath export isolation (`…/unstable` entry points) was rejected; see [Alternatives considered](#alternatives-considered).

### Plugin requirements

A plugin may declare the seam versions it needs, for example `"dsh": { "requires": { "agent": "^1.0.0" } }`; the field name follows the `apis` decision. When the field is present, `evaluatePluginCompatibility` checks each listed seam range against the installed seam versions. By convention the plugin also lists the unstable seams it uses; the Host cannot verify that list, and the plugin manager shows it as a risk. When it is absent, the current `engines.dsh` and peer range check applies unchanged and the plugin is treated as depending on unstable APIs. The declaration does not restrict what a plugin can import or access: Cordis plugins run in the Host process and can import any package or reach any service on `ctx`.

### Compatibility layer

Serving an old major seam version to old plugins is deferred. It becomes worthwhile once a stable seam takes a major version bump while external plugins still require the previous major. The Host then keeps one current implementation, and an adapter plugin provides the old Service Definition on top of it for a fixed support period.

### Rollout

1. Policy only: land this note, change the root `AGENTS.md` pre-stable rule to "unmarked APIs are unstable", and define the deprecation period. No code changes.
2. Baseline report: generate and check in the first API report; CI only checks that it is current.
3. Pilot: promote the agent seam. Its stable API is the Service Definition in `dsh-agent`: `ctx.agents`, the `Agent` handle, the `agent/*` events, and the `agent/pre-step` waterfall. The `dsh-agent-loop` Service Provider stays unstable. The already deprecated `agent/request` waterfall receives a dated marker stating that no replacement exists for other per-request controls, and exercises the deprecation and removal checks. The lint rule and the `requires` check ship in this phase.
4. Promote further seams when the maintainers of a seam choose to; publish the stable API list on the documentation website.
5. Add compatibility adapters for specific seams when the condition above holds.

### Open questions

- Name and position of the `dsh.apis` and `dsh.requires` manifest fields.
- Length of the time-based deprecation period before DSH 1.0.
- Whether the Python SDK methods, the SDK JSON-RPC protocol, and `cordis.yml` config fields join the same levels, and whether the protocol needs its own version.
- Report generator: API Extractor or a dump built on the export walker in [scripts/verify-export-jsdoc.ts](../../../../scripts/verify-export-jsdoc.ts) and the tag parser in [scripts/jsdoc.ts](../../../../scripts/jsdoc.ts).

## Alternatives considered

**`@stable` markers without versions.** Cheapest and incremental, but a plugin cannot state which stable API it was built against, the Host cannot check it, and a deprecation period has no unit. Kept as the input format; the generated report supplies the versions.

**A hand-maintained versioned list per release.** Gives plugin authors a clear reference, but maintaining it by hand for over a thousand export subpaths and more than a hundred services is not practical, and one version for the whole list forces every plugin to react to any seam's break. Kept as the generated report rather than a maintained artifact.

**One API version for the whole platform** (Android API level, VS Code `engines`). Simplest for plugin authors, but DSH releases often and its seams evolve independently; a single number would either grow with every break or discourage necessary breaks.

**Grouping by package directory instead of seam.** Groups such as `fs/` mix Service Definitions, providers, and tools that evolve separately. The seam is already the unit the architecture uses, so it costs the least to maintain.

**Subpath export isolation for unstable APIs.** Making the import path the opt-in is a more explicit opt-in than a lint warning, but it restructures the exports of every package and breaks every current consumer at once, which contradicts incremental adoption.

**Shipping a compatibility layer from the start.** Each retained old version needs its own conversion code and tests. Before any seam is stable and before external plugins depend on an old major, that cost buys nothing.

**Counting the deprecation period in releases.** DSH release frequency varies, so a release count gives plugin authors an unpredictable amount of time. A dated marker lets CI compute the period mechanically.

## Acceptance criteria

- Root `AGENTS.md` states that unmarked APIs are unstable, and the deprecation period is defined.
- A checked-in API report covers exports, services, and events; CI fails when it is stale.
- The agent seam is declared stable at version 1.0.0; CI rejects an incompatible signature change or an early removal of a deprecated member in it, and posts a stable API change summary on PRs that touch it.
- The lint rule reports a plugin's use of an unstable member.
- A plugin that declares `requires` is accepted or rejected per seam range; a plugin without it behaves as it does today.

## Risks

- Seam membership of shared types is not always clear; a type used by two seams needs one owner before either seam is promoted.
- Behavior changes rely on author declarations, which review can miss.
- Seam versions and the lockstep package version are two numbering systems, which plugin authors may confuse.
- Promoting the agent seam constrains a core part of the loop that still changes often; promotion trades that flexibility for plugin stability.
- The manifest declaration cannot stop a plugin from using undeclared APIs; it informs checks and users, not enforcement.
