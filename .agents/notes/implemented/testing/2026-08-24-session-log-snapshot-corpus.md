# Agent Note: Session-log snapshot corpus

Status: implemented

English | [中文](2026-08-24-session-log-snapshot-corpus.zh.md)

## Problem

The keyless snapshot corpus uses ACP as the controller for many scenarios whose asserted behavior belongs to the assembled Agent, tools, persistence, or another product interface. This makes an automation protocol look like the owner of backend behavior, retains test-only application entrypoints beside the supported `dsh` launcher, and scatters recorded sessions among example, SDK, Web, and script directories.

The term snapshot also covers unrelated ARIA, geometry, generator, and package-unit expected output. Contributors cannot infer from a path whether a recorded session drives the test, whether the session is both replay input and expected output, or which command owns a refresh.

## Decision

Reserve the top-level `snapshots/` tree and `*.snapshot.ts` suffix for scenarios that own or explicitly reference recorded session JSONL. Each process-level scenario launches a shipped profile through `dsh`; a small adapter controls headless, SDK, ACP, or Web behavior without becoming another application entrypoint. A declarative `snapshot.yml` holds only profile, patch, lifecycle-control, platform, header-pin, and workspace facts that the completed session cannot express.

This decision supersedes the ACP-specific placement and controller ownership in the [record-once/replay-deterministic decision](2026-06-19-acp-snapshot-tests.md), while that note remains authoritative for session-log replay, exceptional overrides, normalization, and ACP transcript comparison.

The recorded session remains the primary input and expected output. Human-originated messages drive the selected public interface, recorded assistant chunks drive deterministic model replay, and the normalized persisted result must equal the fixture. Parent and child sessions share one typed redaction map. Committed fixtures contain relationship-preserving identity tokens and replace request system prompts and tool schemas with tokens; each distinct header class retains one explicit sidecar owner.

Fixture decoding and comparison depend only on the selected JSONL content; filenames identify inventory roles but are not parser inputs. The same strict static catalog validates replay, seed, record, refresh, and normalized comparison paths.

Headless stderr reconstruction expands embedded reasoning from both `assistant/message` and log-only `assistant/attempt` settlements, so failed or retried reasoning remains part of the projected process output.

Each parent or child role uses `session[.<ordinal>][.vN].jsonl`, with v0 encoded by an omitted version and every filename matching its header. Replay, record, and refresh select the numerically highest generation per role. Most owners omit `sessionFormat` and track the current writer; a bounded historical owner declares its exact version and closed coverage names. The v2 corpus keeps selected v0 roles for multi-hop, packed-row, retry/failure, and shipped-profile coverage plus selected v1 roles for the adjacent structural edge. Record and refresh never rewrite an explicitly retained historical fixture, rename a committed generation, or delete one through automatic cleanup. A retained Session generation does not freeze its non-Session expected outputs: refresh still writes owned system-prompt and tool-schema sidecars from the current run. Reviewed source-tree curation removes a predecessor only after the same role has a verified current successor. The corpus policy requires current selected roles to remain the majority and caps historical selected roles at ten; lower predecessor generations may remain beside a selected current successor.

Scenario-owned HTTP fixtures separate the stable authority recorded in the session from their transport listener. Each fixture binds loopback port `0`, lets the operating system allocate and bind the port atomically, and maps the recorded URL or endpoint through the real provider to that listener. Any process-global transport interception matches only the recorded endpoint, is owned by the fixture fiber, and is restored before the listener closes.

Every existing ACP scenario receives a behavior-preserving destination. Ordinary one-shot behavior uses the headless profile, persistent machine control uses the SDK profile, and only ACP protocol behavior remains ACP-owned. Web scenarios driven by a recorded session join the corpus and retain their ARIA or geometry expected output as secondary evidence. Web and package tests without a recorded-session source keep owner-local expected output and stop using snapshot paths or filenames.

Workspace inputs remain scenario-local. A mutating scenario compares a complete expected final workspace that record and refresh never rewrite, so a model or tool self-report cannot satisfy the test. Existing intentional session reuse remains an explicit acyclic owner reference; the corpus adds no workspace inheritance or general fixture-merging mechanism.

## Alternatives considered

**Keep ACP as the universal driver.** This preserves the existing harness but continues coupling backend coverage to a low-priority protocol and cannot prove the supported headless, SDK, and Web launch paths.

**Move every scenario to a new headless test driver.** A private driver would reproduce the application-entrypoint problem and cannot express multi-turn, cancellation, or background lifecycle control available through the shipped SDK profile.

**Centralize every expected output under `snapshots/`.** ARIA, geometry, generator, and unit expectations do not use a recorded session as both input and result. Mixing them would keep the current ambiguous terminology and weaken package ownership.

**Create one declarative browser and terminal language.** Complex UI and PTY scenarios need interaction code. A shared snapshot core plus interface adapters removes application drivers without adding a second test framework.

**Deduplicate workspaces and recorded sessions automatically.** The current workspace duplication is small and intentional locality is easier to review. Only existing semantic session reuse justifies an explicit reference.

**Bind the recorded URL's numeric port.** A stable listener port keeps transport and transcript values identical, but concurrent snapshot jobs on one host share the network namespace and race for that port.

**Probe an unused port before launching the scenario.** Releasing a probed port before the child binds it creates a time-of-check/time-of-use race. Binding port `0` inside the owning process keeps allocation and ownership atomic.

**Make every selected fixture current.** This minimizes fixture versions but removes shipped-profile proof that the complete adjacent migration chain can still restore released inputs.

**Keep every scenario selected on its oldest generation.** This maximizes migration calls but stops the snapshot corpus from exercising the current writer and current-format fast path as its ordinary case.

## Invariants

- Every existing recorded-session scenario has one passing replacement before its old owner is removed.
- Every process-level snapshot starts through `dsh`, and the application-entrypoint inventory no longer allows the retired snapshot drivers.
- Every top-level scenario owns or references session JSONL; non-session expected output remains owner-local.
- Committed session fixtures are redaction fixed points, contain no system-prompt or tool-schema bulk, and retain exactly one pin per header class.
- Canonical fixture names equal their header versions; every reference names its owner's selected parent generation; at most ten selected roles use explicit v0/v1 declarations, current selected roles outnumber them, and their coverage names include every retained migration behavior.
- Mutating scenarios verify their final workspace externally.
- Owner-local process expectations use `*.expected.e2e.ts` and a separate built-output gate.
- Source and built adapters install replay-only packages in isolated profile fallbacks; distinct prompt-section orders keep their request headers byte-identical.
- Scenario HTTP fixtures bind OS-assigned loopback ports while preserving their recorded model-visible authorities.
- Source and built launch modes, browser replay, SDK projections, packaged Python runtime cases, documentation gates, and repository hygiene pass.

## Consequences

The corpus makes controller ownership visible: ordinary Agent behavior no longer inherits ACP protocol output, SDK and Web projections retain their interface-specific evidence, and only ACP cancellation and permission exchanges remain ACP-owned. Contributors review one normalized session diff plus the sidecars or UI expectations that add independent evidence. Adding a composition requires a manifest class pin; adding a volatile identity requires a typed relationship-preserving redaction rule rather than a broader text scrubber. Concurrent jobs can replay network-backed fixtures without reserving repository-wide ports, at the cost of a fixture-local mapping between the recorded authority and its transport listener.

Historical migration coverage costs explicit per-scenario metadata and retained predecessor files, while the selected current majority prevents compatibility fixtures from hiding current-writer regressions.

## Risks

The corpus can change hundreds of fixtures and hide behavior changes in generation-name churn. Mechanical generation output, normalization behavior, and controller behavior therefore remain separately attributable in the diff and validation, and expected-output rewrites require scenario-level review.

One recorded session serving as both replay input and expected output can reproduce a bad model script consistently. Independent world-state assertions, protocol or UI expectations, real-model recording, and focused package tests remain required complementary evidence.
