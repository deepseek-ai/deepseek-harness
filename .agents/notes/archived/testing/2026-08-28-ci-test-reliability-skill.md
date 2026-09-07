# Agent Note: CI test reliability skill

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-28-ci-test-reliability-skill.zh.md)

## Problem

DeepSeek Harness runs tests across concurrent Vitest files, worker processes, repository gates, and Actions jobs. Process isolation does not isolate host ports, predictable paths, external namespaces, or inherited children, while process-global mutations and incomplete teardown can contaminate later tests. A test can select the correct tier and still pass only when it runs alone.

The testing policy owns test tiers, defensive patterns own runtime lifecycle rules, pre-push guidance selects commands, and code review evaluates completed diffs. None of them gives an agent a focused workflow for designing resource-owning tests against the real CI topology or classifying an existing probabilistic failure before changing code.

## Decision

[dsh-ci-test-reliability](../../../skills/dsh-ci-test-reliability/SKILL.md) owns test isolation and CI-flake diagnosis guidance. It applies when tests or fixtures acquire host resources, mutate process-global state, depend on asynchronous readiness, own subprocesses or network listeners, or exhibit probabilistic CI failures.

The skill requires agents to model concurrency beyond one Vitest process, allocate live resources atomically, separate stable fixture identities from ephemeral transport addresses, synchronize on observable state, restore global mutations exactly, and await teardown to quiescence. Regression evidence matches the owned risk: negative controls for guards, deterministic barriers for races, concurrent independent processes for host-resource isolation, and external observations instead of component self-reports.

Two rules cover the failures the repository has actually paid for. A value the operating system owns is not guaranteed to return as written, so a test may write one back only where the assertion tolerates that write-back failing; where the assertion depends on it, the expected value comes from a fresh read. And a suite timeout overrides the runner flag rather than yielding to it, so a suite bound by process creation takes the lane budget, raises the hook budget with it, and keeps an outer wait far larger than any timeout under test. Restoring a granted budget or sizing a bounded retry to measured contention is therefore not a masking fix.

The diagnosis-only workflow lives in a separate reference so ordinary authoring does not load Actions triage procedure. It compares passing and failing evidence before classifying host collisions, incomplete lifecycle, global contamination, load-sensitive synchronization, platform or entry-path failures, product races, provider transience, or runner infrastructure.

[dsh-pre-push-checks](../../../skills/dsh-pre-push-checks/SKILL.md) conditionally consults the reliability skill before selecting commands, while [dsh-code-review](../../../skills/dsh-code-review/SKILL.md) applies it when reviewing risky tests. Command selection and general PR review remain with those existing skills.

This decision partially overlaps the [deterministic and stress testing proposal](../../proposed/testing/2026-06-11-deterministic-and-stress-testing.md). The skill ships authoring and diagnosis guidance; it does not implement that proposal's lint rule, universal replay fixture, or nightly stress job, so the proposal remains active.

## Alternatives considered

**Expand dsh-pre-push-checks.** Pre-push guidance runs after test design and owns evidence selection. Making it also own resource allocation, synchronization, teardown, and CI diagnosis would mix two different decisions and load reliability procedure for ordinary pushes.

**Expand dsh-code-review.** Review guidance can detect unreliable tests after a diff exists, but it cannot guide the agent while the fixture is being designed or while a failure is being diagnosed without a PR.

**Put the complete workflow in the standing testing policy.** The testing policy must remain the concise authority for tiers and placement. Loading detailed Actions diagnosis and resource-specific procedure for every test task would duplicate situational guidance and make that policy harder to scan.

**Add a generic stress runner or regex gate immediately.** Repeated green runs do not prove a race is controlled, and literal ports, paths, sleeps, and URLs can be valid parser inputs or expected values. A later high-signal defect class can justify a narrow executed check without making broad textual matches policy.

## Consequences

Agents receive the reliability rules while designing or diagnosing the tests that need them, and pre-push and review workflows share the same criteria without duplicating the procedure. Pure deterministic tests continue to use the normal focused evidence path.

The skill is advisory, so it cannot mechanically prevent every resource collision. A repeated, statically identifiable defect can still justify an executed repository check. The repository also retains one additional active Skill and reference whose links and statements must remain current with the actual CI topology.

The existing deterministic-and-stress proposal remains open, and this change does not audit or rewrite the current test corpus.
