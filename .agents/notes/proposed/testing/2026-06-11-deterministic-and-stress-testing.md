# Agent Note: Deterministic tests, the replay invariant fixture, and race stress

Status: proposed

English | [中文](2026-06-11-deterministic-and-stress-testing.zh.md)

The [CI test reliability skill](../../../skills/dsh-ci-test-reliability/SKILL.md) provides current authoring and diagnosis guidance without implementing the lint rule, universal replay fixture, or nightly stress job proposed here. Those mechanisms remain proposed.

## Problem

Several loop tests synchronize with `setTimeout(30)` sleeps — flakiness debt that wastes agent cycles on retries and can mask ordering bugs. Separately, our core architectural promise (any session log replays to identical derived history) is asserted in two tests but is cheap to assert *everywhere*. And the inbox wakeup race was verified by hand exactly once; nothing re-verifies it continuously.

## Proposal

Three measures:

1. **No wall-clock sleeps in tests.** Replace `setTimeout(N)` waits with event-driven waits (the existing `waitForIdle` pattern, extended to `waitForStatus`, `waitForEvent(n)`) or vitest fake timers where time itself is under test. Enforce with a lint rule banning `setTimeout` in `packages/*/tests` outside an allowlisted helper module.
2. **Universal replay fixture.** A shared test helper wraps the loop harness so that after every test, the agent's session log is replayed into a fresh Session and `deriveMessages()` equality is asserted automatically. The invariant then gets checked hundreds of times per CI run across every scenario the suite produces, not twice.
3. **Nightly race stress.** A CI job running the agent-loop and inbox suites with `vitest --repeat=200` (and `--shuffle`) to flush scheduling-dependent failures; any flake found is a bug to fix, never a retry.

## Plan

Land 1 and 2 together (they touch the same helpers); add the nightly job after the suite is sleep-free so repeats are fast.

## Acceptance criteria

- No `setTimeout` remains in `packages/*/tests` outside the allowlisted helper module, enforced by the lint rule.
- The shared harness replays every test's session log into a fresh `Session` and asserts `deriveMessages()` equality automatically, across the whole suite.
- The nightly job runs the agent-loop and inbox suites with `--repeat` and `--shuffle`; a flake it finds is triaged as a bug, never retried away.

## Risks

Fake timers interact subtly with Promise scheduling in the loop — prefer event-driven waits; reserve fake timers for timer-service behavior itself.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
