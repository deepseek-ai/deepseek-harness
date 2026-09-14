# Agent Note: runner-owned temporary storage for PR CI

Status: implemented

English | [中文](2026-09-06-pr-ci-runner-temporary-storage.zh.md)

## Problem

The Linux failover pool runs multiple runner instances on one VM. PR coverage and snapshot processes use the operating-system temporary directory for transformed modules and fixtures. Files outside the runner's temporary directory escape its job cleanup, including when cancellation prevents process-level disposal. Exhausting that shared directory makes unrelated PRs fail before tests execute.

## Decision

The static, coverage, and consumer jobs in [PR CI](../../../../.github/workflows/ci.yml) export `TMPDIR=runner.temp` through `GITHUB_ENV` in their first step before any setup or test process starts. Node, Vite, tsx, and temporary test consumers inherit the runner-owned location. Each runner owns its directory and GitHub Actions clears its removable contents at job start and completion; fixtures still allocate unique children and retain their own cleanup.

npm keeps its configured persistent cache, normally `$HOME/.npm` on POSIX, without a per-job override in the main CI or release workflows. The pnpm store remains shared at `$HOME/.local/share/pnpm/store`. Both retain cross-runner reuse under the package managers’ concurrent-access support; shared-cache capacity and filesystem failures remain operational responsibilities. The consumer job places Playwright browser downloads and installation locks beside `RUNNER_TEMP`; hosted cache restore uses that same location.

The [release rehearsal decision](../process/2026-09-06-release-rehearsal-selfhosted.md) applies the same lifetime rule to release consumers. The [failover runbook](../process/2026-07-26-ci-failover-runbook.md) continues to own runner selection and shared-host capacity. This change does not retarget jobs, reduce concurrency, retry tests, weaken assertions, or modify master-only CI.

## Recorded ACP completion order

The [ACP diagnostic scenario](../../../../snapshots/session/subagent-acp-diagnostic/cordis.snapshot.yml) holds its scripted background response until `job_output` owns the completion wait. Without that synchronization, a fast child can publish a legitimate job notice between the recorded parent steps. A scenario-local wrapper releases the child after the jobs service registers the completion waiter; the mock watches an exclusive marker in the private test workspace and closes the watcher after release. The fixture restores the wrapped method on disposal. The recorded Session bytes and production job-notice behavior stay unchanged.

## Workspace-grant fixture placement

The headless `session-sandbox-root` fixture declares `workspace.parent: outside-temp`, not a home-filesystem dependency. Its allocator uses a sibling of the canonical platform temp root where the parent is writable and avoids system temporary grants, otherwise home, and rejects a cwd already covered by automatic temporary write grants. On the failover runner this keeps the test on the data volume without making its write succeed through a temporary-directory exemption. The filesystem-sandbox containment tests use the same allocator for their workspace and denied sibling; they register cleanup immediately after successful acquisition. Atomic workspace allocation, recorded Session bytes, and the independent expected file remain unchanged.

## Live verification and browser fixture inputs

The installed-wheel live SDK test externally replaces the created file with a fresh host-only challenge before asking the model to verify it; the verification prompt does not reveal that value. Both turns must contain model-requested tool calls, and the verifier compares the returned value and actual file bytes.

The reference-composer fixture maps the known home-abbreviated workspace display to its existing cwd token and waits for the current exact suggestion set before selecting; neither host paths nor stale suggestions determine its result. The shared browser timezone, Inspector subscription synchronization, and PowerShell completion behavior follow the [existing platform-test decision](2026-09-07-pwsh-ci-observable-completion.md).

The advanced Python snapshot pauses only its matching workflow child’s first pre-step until the parent’s durable workflow membership event is observed. The fixture supports either event-arrival order and cancels pending waits on abort or disposal. This pins the scenario’s cross-session ordering without sorting notifications or changing production scheduling.

The queue snapshot moves the pointer away from the Stop/Send control and waits for its Send tooltip to close before capture. Workspace-management tests select the sole non-blank Session by its actions affordance, not row position, and select that Session before asserting that archiving it removes the empty Ungrouped bucket. Hover behavior, queue contents, durable archive identity, and reload assertions remain unchanged. The concurrent spill isolation test keeps each root paired with its run result rather than assuming filesystem allocation completion order matches input order.

## Alternatives considered

**Delete shared temporary files from a PR job.** Another runner may still own those files. Repository jobs must not reclaim a shared directory by pathname or age.

**Retry tests or enlarge timeouts.** Neither recovers storage or gives residual files a cleanup owner.

**Switch every job to hosted runners.** This avoids the affected VM but leaves the failover path defective and changes the operator's independent pool selection.

## Consequences

Output honoring `TMPDIR` follows the job lifetime instead of accumulating in unmanaged host storage. Package-manager and browser caches remain persistent. This does not reclaim existing shared temporary files, guarantee filesystem capacity, or clean files the runner account cannot remove. Operators still own historical residue, disk provisioning, and jobs outside this PR workflow.

Linux bwrap and Landlock workspace-write profiles grant literal `/tmp` and the workspace, not an inherited `TMPDIR` outside it; confined fixtures must place temporary writes in those granted paths. The [snapshot spill helper](../../../../packages/test-support/session-snapshot/src/harness.ts) separates fixed-length logical locators from atomically allocated live storage. A fixture-only adapter delegates saves to the real local spill provider and resolves only locators saved by that run to their live files. Recorded preview lengths, omission counts, and retrieval assertions remain unchanged; no files are allocated at the logical `/tmp/dsh-acp-snap-*` prefix. This change does not widen product sandbox grants.

The parsed-workflow cases in [ci-workflow.spec.ts](../../../../scripts/ci-workflow.spec.ts) require the assignment on all three workers and reject step-level overrides. They fail against the unmodified workflow. Independent-process smoke checks and repeated PR runs validate the actual tooling; the YAML assertions alone do not prove host capacity.
