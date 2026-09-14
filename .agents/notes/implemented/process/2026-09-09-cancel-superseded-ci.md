# Agent Note: Cancel superseded CI validation

Status: implemented

English | [中文](2026-09-09-cancel-superseded-ci.zh.md)

## Problem

Validation of an obsolete PR revision or master commit consumes runner capacity without establishing the newest revision’s status. Unconditional aggregate verdicts and coverage-history uploads can also keep cancelled runs doing bookkeeping. Preserving older post-merge runs favors historical completion over current validation, especially on the shared self-hosted pools.

## Decision

Validation favors the newest run within each workflow/ref group. [CI](../../../../.github/workflows/ci.yml), [CI master](../../../../.github/workflows/ci-master.yml), [real-API e2e](../../../../.github/workflows/e2e.yml), and the credential-free [dsh](../../../../.github/workflows/release.yml) and [vendor](../../../../.github/workflows/release-vendor.yml) pack validations use `cancel-in-progress: true` with `${{ github.workflow }}-${{ github.ref }}`. Different PR refs and different workflows do not cancel each other. Event type is not part of the group: master pushes and manual benchmarks can supersede each other in CI master, and e2e pushes, scheduled runs, and manual runs can supersede each other on the same ref.

The [reusable Python runtime builder](../../../../.github/workflows/build-exe-for-python-sdk.yml) uses `${{ !inputs.release }}`. Its `build-single-exe-${{ github.workflow }}-${{ github.ref }}` group remains distinct from its caller’s group, and the caller workflow name isolates ordinary CI from release-owned builds. Release-owned builds are exempt because they belong to an intentional publication transaction. Publication, deployment, and metadata workflows retain their own policies; this decision does not apply cancellation indiscriminately across workflows.

The PR aggregate uses `${{ !cancelled() && github.event_name == 'pull_request' }}`. The explicit status function preserves evaluation after failed or skipped dependencies rather than accepting GitHub’s default success-only condition. The aggregate still fails on any failure, cancellation, or skip among its dependencies when the workflow itself is not cancelled; cancellation of the whole workflow suppresses its obsolete verdict. Coverage duration history uses `!cancelled()` too: failed coverage can still save useful measurements, but cancelled coverage does not upload them. Wine’s `always()` cleanup remains necessary resource cleanup rather than optional bookkeeping.

This reverses the cancellation exemption in the [failover runbook](2026-07-26-ci-failover-runbook.md), [master-only platform CI](2026-09-06-master-only-platform-ci.md), and [real-API e2e decision](../testing/2026-06-19-real-api-e2e-ci.md). Those notes retain independent value for pool trust and switching, platform coverage, and secret exposure. The [release rehearsal decision](2026-09-06-release-rehearsal-selfhosted.md) retains runner selection and isolation ownership. None is fully superseded or archived.

## Alternatives considered

**Preserve running master-push drills.** The former `${{ github.event_name != 'push' }}` exemption favored periodic readiness evidence: each standby executes its complete unsharded aggregate with one gate worker and can outlast the interval between master merges. Even that policy did not guarantee every drill completed. GitHub retains one pending run per group, replacing intermediate pending pushes; cancellation is evaluated on the newly triggered run, so a manual benchmark sharing the master group could still cancel a drill. That rare manual interruption was accepted on the expectation of evidence from a subsequent push. The exemption’s cost was bounded by the master-only runtime checks, Wine, and two drills; PR jobs remained in a separate workflow, and exact-condition regression checks pinned the push-reachable job set. This policy is rejected in favor of freeing capacity for current validation, explicitly accepting standby starvation.

**Protect a drill with job-level concurrency, or cancel only PR events.** A job-level group cannot exempt a job from cancellation of its entire workflow. A PR-only cancellation condition also exempts manual dispatch: a repeated runner benchmark can occupy twelve larger runners for up to fifteen minutes rather than replacing an obsolete measurement. Workflow-level cancellation covers both pushes and manual runs.

**Keep every post-merge, nightly, and pack run.** Historical completion provides more per-commit and per-trigger evidence, but obsolete validation competes with the newest run. These validations do not publish packages, so preserving every run is not the same requirement as protecting an intentional publication transaction.

**Replace every `always()` condition.** Failure aggregation and resource cleanup have different obligations. A success-only aggregate can hide failed dependencies behind a skipped required check; removing unconditional Wine cleanup can leave resources running. Only cancelled-run bookkeeping is suppressed.

## Consequences

Rapid master updates can repeatedly cancel the longer standby drills before they produce a verdict. Operators use the latest completed standby verdict, checking its age and commit before relying on it for failover readiness; a scheduled, running, or cancelled drill is not readiness evidence. The policy does not guarantee that every intermediate commit, nightly trigger, or benchmark completes. Different refs can still compete for shared host capacity.

Cancellation is a request handled by GitHub Actions and its runners, not a guarantee of immediate termination or bounded queue delay. Cleanup can still take time. The policy makes obsolete validation cancellable; it does not promise a fixed runtime or cancellation latency.

## Verification

[Workflow regressions](../../../../scripts/ci-workflow.spec.ts) pin workflow/ref isolation, release-owned exemptions, aggregate status conditions, coverage-history cancellation, and retained Wine cleanup. [Platform routing regressions](../../../../scripts/tests/ci-master-platforms.spec.ts) preserve the master/PR target split and release matrix; [release rehearsal regressions](../../../../scripts/tests/ci-release-selfhosted.spec.ts) preserve cancellation alongside runner eligibility and publication isolation. These configuration checks do not reproduce GitHub scheduling or runner shutdown. Live supersession and completed standby evidence remain CI verification responsibilities.
