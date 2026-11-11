# Agent Note: Stable API policy

Status: proposed

English | [中文](2026-11-05-stable-api-policy.zh.md)

## Problem

Every public DSH API is pre-stable: root `AGENTS.md` tells contributors to update every consumer when an API changes. That rule works inside the repository, but external plugins now install from npm and the plugin market, and their authors cannot tell which APIs they can rely on. All released packages share one lockstep version, so a package version says nothing about which API changed. The only compatibility check, `evaluatePluginCompatibility` in [plugin-compatibility.ts](../../../../packages/boot/app-boot/src/plugin-compatibility.ts), compares a plugin's `engines.dsh` range, or else its `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peer ranges, with the whole runtime version; `workspace:` peer ranges count as the running version.

No source marker distinguishes stable from unstable APIs. Exports carry no `@public`, `@beta`, `@stable`, or `@since` tags; `@internal` appears about ten times with differing meanings, and undated `@deprecated` about a dozen times. The only rigorous compatibility rules cover data formats ([Session format status](../../../../docs/session-format-status.md), SQLite schema versions, persistence type acknowledgements) and [upgrade guides](../../../skills/dsh-create-upgrade-guide/SKILL.md).

The policy must start from this state. Contributors must not have to classify every API before the policy takes effect, and code that nobody marks must keep today's workflow.

## Proposal

Stability markers in source are the only input. A generated API report turns them into a versioned list of stable APIs for each release. The unit of versioning is the [capability seam](../../../../docs/glossary.md#capability-seam). Anything not marked stays unstable, so adoption proceeds one member at a time.

### Stability levels

| Level | Marker | Change rule |
|---|---|---|
| unstable (default) | None | Change freely, update every consumer, and record externally perceptible breaks in an upgrade guide |
| stable | `@stable <seam>@<version>`, the seam version that added the member | Backward-compatible additions only; a removal or incompatible change requires a completed deprecation period and a major seam version |
| internal | `@internal` | Used only inside this repository; omitted from the API report; change freely |

Deprecation is a state of a stable member, not a fourth level: a member tagged `@deprecated <replacement or "no replacement">` stays stable until its deprecation period ends. `@internal` and `@deprecated` tags on unstable members keep their current meaning; the policy assigns no new meaning to existing tags.

Packages under [`packages/experimental/`](../../../../packages/experimental/README.md#status) cannot contain stable members; a package is promoted out of the experimental group before any of its members are promoted.

### Unit: one capability seam

Each capability seam has its own API version, independent of the lockstep package version. A stable member belongs to the seam of the Service Definition package that declares it; a member of a declaration-merged interface such as `Context` or `SessionEventMap` belongs to the seam of the package that adds it. Exports that belong to no seam, such as utilities, CLI options, and the SDK wire protocol, stay unstable until a later proposal assigns them. Members reachable only through `./src/*` export subpaths are unstable.

The package that declares a Service Definition records its seam version in the existing `package.json` `dsh` declaration, owned by the [public package manifest](../../implemented/architecture/2026-09-10-public-package-manifest.md) decision. One package can declare several seams, so the member is a list:

```json
{ "dsh": { "apis": [{ "name": "agent", "version": "1.0.0" }] } }
```

The new members are optional and do not change `manifestVersion`; their names are not settled. As that decision requires, the report generator and the compatibility check each validate the members they read.

### What stable covers

Stable covers type signatures, event order, and waterfall calling conventions, including whether a listener must call `next()`. Default config values and config fields are not covered in this proposal. CI detects signature changes from the generated report. Behavior changes cannot be detected reliably; the author declares them in the PR description, and ordinary review checks the declaration. Tests that pin stable event order and waterfall conventions belong to the Service Definition package and run against the shipped Service Provider.

A stable signature can reference types from other seams, such as `SessionId` or `Scoped`. Those referenced types become part of the referencing seam's promise: the report lists them under that seam, and an incompatible change to them fails the same checks as a change to the seam's own members.

### API report and CI

A script generates one checked-in API report covering exports, Cordis services, and events, with each entry's seam, level, and version; it replaces the per-package reports of the deferred [API extractor reports](2026-06-11-api-extractor-reports.md) proposal. Each release archives its report. CI compares stable entries, including referenced types, with the latest released report and fails when:

- a stable entry is removed or changed incompatibly without a major seam version bump and an upgrade guide;
- a removed entry was not deprecated in a released report, or its deprecation period has not elapsed since the first release whose report recorded the deprecation;
- a stable entry is added without a minor seam version bump;
- a stable signature references a member marked `@internal` or an unstable member of its own seam.

Measuring the period from the first release that recorded the deprecation keeps it independent of dates authors write. Changes to unstable entries appear in the report diff without failing CI. CI also posts a summary of stable API changes to the PR. Promotion and breaking changes are approved in ordinary PR review; no dedicated API owner or committee is named.

### Plugin author warnings

A type-aware lint rule reports uses of unstable members by resolving each used symbol and reading its level from the published declarations. Event and waterfall names are string literals passed to `ctx.on()` and similar calls, so the rule resolves them against the event map; `typescript/no-deprecated` in [.oxlintrc.json](../../../../.oxlintrc.json) does not cover this case. Oxlint offers no custom type-aware rules, so the rule ships as a published tool that plugin authors run in their own builds; the repository runs it on stable Service Definition packages. Subpath export isolation (`…/unstable` entry points) was rejected; see [Alternatives considered](#alternatives-considered).

### Plugin requirements

A plugin may declare the seam versions it needs, for example `"dsh": { "requires": { "agent": "^1.0.0" } }`. The seam check is additive: `evaluatePluginCompatibility` still evaluates `engines.dsh` or the DSH peer ranges, and also compares each listed seam range with the seam versions recorded in the running Host's API report. A plugin that declares seam ranges can widen its `engines.dsh` range to every runtime it supports. Plugin market index entries and registry update checks read the same declaration, so discovery, installation, and update reach the same result. By convention the plugin also lists the unstable seams it uses; the Host cannot verify that list, and the plugin manager shows it as a risk. The declaration does not restrict what a plugin can import or access: Cordis plugins run in the Host process and can import any package or reach any service on `ctx`.

### Compatibility layer

Serving an old major seam version to old plugins is deferred. It becomes worthwhile once a stable seam takes a major version bump while external plugins still require the previous major. The Host then keeps one current implementation, and an adapter plugin provides the old Service Definition on top of it for a fixed support period.

### Rollout

1. Policy only: land this note and define the deprecation period. Replace the pre-stable statement with "unmarked APIs are unstable" in root `AGENTS.md`, [packages/README.md](../../../../packages/README.md), [packages/experimental/README.md](../../../../packages/experimental/README.md), [apps/cli/reference/README.md](../../../../apps/cli/reference/README.md), and the generated package reference from [gen-plugin-packages.ts](../../../../scripts/gen-plugin-packages.ts). No code changes.
2. Baseline report: generate and check in the first API report; CI only checks that it is current.
3. Pilot: promote members of the agent seam declared by `dsh-agent`: `ctx.agents`, `AgentHandle`, `Agent`, the `agent/*` events other than the deprecated `agent/request`, and the `agent/pre-step` waterfall. Types they reference from session, scope, and llm packages join the promise as described above. The `dsh-agent-loop` Service Provider and its config stay unstable, so the pilot stabilizes no configuration. The lint tool and the `requires` check ship in this phase; [package-manifest README](../../../../packages/util/package-manifest/README.md) and the public package manifest note are updated to describe the enforced check.
4. Promote further members and seams when the maintainers of a seam choose to; publish the stable API list on the documentation website.
5. Add compatibility adapters for specific seams when the condition above holds.

### Open questions

- Names of the `dsh.apis` and `dsh.requires` members.
- Length of the time-based deprecation period before DSH 1.0.
- Whether the Python SDK methods, the SDK JSON-RPC protocol, and `cordis.yml` config fields join the same levels, and whether the protocol needs its own version.
- Report generator: API Extractor or a dump built on the export walker in [scripts/verify-export-jsdoc.ts](../../../../scripts/verify-export-jsdoc.ts) and the tag parser in [scripts/jsdoc.ts](../../../../scripts/jsdoc.ts).
- Lint tool form: a standalone published checker built on the same export walker, a non-type-aware approximation, or an upstream oxlint rule.

## Alternatives considered

**`@stable` markers without versions.** Cheapest and incremental, but a plugin cannot state which stable API it was built against, the Host cannot check it, and the report cannot tell additions from existing members. Kept as the input format with the adding seam version attached; the generated report supplies the list.

**A hand-maintained versioned list per release.** Gives plugin authors a clear reference, but maintaining it by hand for over a thousand export subpaths and more than a hundred services is not practical, and one version for the whole list forces every plugin to react to any seam's break. Kept as the generated report rather than a maintained artifact.

**One API version for the whole platform** (Android API level, VS Code `engines`). Simplest for plugin authors, but DSH releases often and its seams evolve independently; a single number would either grow with every break or discourage necessary breaks.

**Independent semver per npm package, dropping the lockstep version.** The [npm release sequences](../../implemented/process/2026-08-10-npm-release-sequences.md) decision keeps all DSH packages on one version so releases and peer ranges stay consistent. Package versions would also change for internal refactors that do not touch any API a plugin uses. Seam versions describe API compatibility without changing how packages are released.

**Grouping by package directory instead of seam.** Groups such as `fs/` mix Service Definitions, providers, and tools that evolve separately. The seam is already the unit the architecture uses, so it costs the least to maintain.

**Subpath export isolation for unstable APIs.** Making the import path the opt-in is more explicit than a lint warning, but it restructures the exports of every package and breaks every current consumer at once, which contradicts incremental adoption.

**Shipping a compatibility layer from the start.** Each retained old version needs its own conversion code and tests. Before any seam is stable and before external plugins depend on an old major, that cost buys nothing.

**Counting the deprecation period in releases.** DSH release frequency varies, so a release count gives plugin authors an unpredictable amount of time. Measuring time from the first release that recorded the deprecation is predictable and can be computed from archived reports.

## Acceptance criteria

- Root `AGENTS.md` and the package documentation listed in rollout step 1 state that unmarked APIs are unstable, and the deprecation period is defined.
- A checked-in API report covers exports, services, and events; CI fails when it is stale.
- The pilot members of the agent seam carry `@stable agent@1.0.0`; CI rejects an incompatible change to them or to a type they reference, and posts a stable API change summary on PRs that touch them.
- The lint tool reports a plugin's use of an unstable member, including an unstable event name passed to `ctx.on()`.
- A plugin that declares `requires` is accepted or rejected per seam range in installation, update, and market discovery; a plugin without it behaves as it does today.

## Risks

- Referenced types from other seams join the promise of the referencing seam; promoting the agent seam therefore freezes parts of the session, scope, and llm types before those seams are promoted.
- Behavior changes rely on author declarations, which review can miss.
- Seam versions and the lockstep package version are two numbering systems, which plugin authors may confuse.
- Promoting the agent seam constrains a core part of the loop that still changes often; promotion trades that flexibility for plugin stability.
- The lint tool is new published tooling that the project must maintain alongside the oxlint configuration.
- The manifest declaration cannot stop a plugin from using undeclared APIs; it informs checks and users, not enforcement.
