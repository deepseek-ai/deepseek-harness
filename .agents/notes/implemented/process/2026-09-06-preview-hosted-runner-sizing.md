# Agent Note: Measured GitHub-hosted PR preview sizing

Status: implemented

English | [中文](2026-09-06-preview-hosted-runner-sizing.zh.md)

## Problem

PR previews build the full workspace and browser-worker VFS image. A lower per-minute runner price does not guarantee lower job cost because GitHub rounds each job upward to whole minutes. Moving previews to persistent self-hosted machines also changes isolation and is outside this decision.

## Decision

The [preview workflow](../../../../.github/workflows/build-preview-cloudflare.yml) uses standard GitHub-hosted `ubuntu-24.04`. Build, cache, deployment, protected-image verification, and comment semantics remain unchanged. The [sizing reference](../../../../.github/preview-sizing/README.md) owns comparison requirements. The separate CI [failover runbook](2026-07-26-ci-failover-runbook.md) retains its independent runner-switch decision; previews do not use those switches.

### Measurements

[Experiment 34012729982](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34012729982) succeeds for all eight size/cache combinations plus one cache seed. Every measured job checks out SHA `9149d7e7ef945b5601711badd3cf63d58ab384f5`, uses Node 24.19.0 and pnpm 11.7.0, and executes immutable install, full workspace build, preview/VFS packing, and local upload shaping with gzip integrity verification. Warm jobs restore one exact run-private pnpm cache; cold jobs skip restoration but contain pnpm bootstrap files. No compiled outputs are restored.

| Runner | Cold / warm job seconds | Rounded minutes each | USD each | Workspace seconds cold / warm | Preview seconds cold / warm |
|---|---:|---:|---:|---:|---:|
| standard, 2 vCPU | 202 / 203 | 4 | 0.024 | 138.92 / 147.21 | 12.65 / 12.94 |
| larger, 4 vCPU | 177 / 162 | 3 | 0.036 | 124.21 / 114.86 | 10.77 / 9.88 |
| larger, 8 vCPU | 154 / 154 | 3 | 0.066 | 110.51 / 110.77 | 9.20 / 9.21 |
| larger, 16 vCPU | 124 / 125 | 3 | 0.126 | 90.57 / 84.99 | 7.62 / 7.33 |

Using [published rates](https://docs.github.com/en/billing/reference/actions-runner-pricing), measured jobs total $0.504; the 60-second standard seed adds $0.006. The $0.510 gross compute estimate includes setup, restoration, measurement upload, and cleanup, but excludes storage and account discounts. Standard costs 80.95% less than 16-core and 33.33% less than 4-core in each sampled cache state. It adds 78 seconds against the corresponding 16-core job.

Standard jobs expose two vCPUs and 7.75 GiB RAM. Workspace maximum process RSS is 2.86 / 2.76 GiB; preview maximum process RSS is 0.76 / 0.74 GiB. Both complete without an OOM or timeout. GNU time RSS is not simultaneous process-tree memory. These samples establish successful execution, not a permanent memory guarantee.

The comparison fixes source, lockfile, commands, and runtime versions, not physical CPUs or image release: standard and 4-core use image 20260831.293.1; 8-core and 16-core use 20260823.283.1. CPUs vary among AMD EPYC 9V74/7763 and Intel Xeon 8370C/8573C. One sample per cache state measures the offered labels, not isolated CPU scaling or statistical repeatability.

The experiment does not deploy or access Cloudflare credentials. Measurement upload takes zero to one second; warm-cache restore takes six to ten seconds. For context, [production job 101428009994](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34011495156/job/101428009994) spends 14 seconds uploading, one second verifying, and two seconds commenting on a different SHA. Adding that overhead to this experiment is a projection, not a measured standard-runner publication result. The actual PR preview workflow owns deployment confirmation.

## Alternatives considered

**Keep 16-core.** It provides the shortest measured job, but costs $0.102 more per sample for a 78-second improvement. Preview builds do not justify that premium for this cost-focused decision.

**Select 4-core or 8-core.** Both succeed and shorten builds, but their rounded sample costs exceed standard Ubuntu. Four-core retains more RAM and disk headroom if future workloads exhaust standard capacity; such a change requires new measurements.

**Move to self-hosted.** Rejected by scope: previews remain on GitHub CI. The existing Linux and Windows registrations can share persistent hosts; their dependency, store-volume, and cleanup assumptions do not apply to fresh hosted VMs. No failover or trust condition changes.

## Consequences

Previews trade approximately 78 seconds of sampled build-job latency for lower compute cost. Production Cloudflare latency, image rollout variance, future build growth, and broader success rates remain observable limitations. No hourly or monthly savings are extrapolated from this single experiment. The temporary benchmark workflow and its safety test are absent from the final tree; the experiment commits and linked run preserve the method and evidence.

The executed [focused regression](../../../../scripts/preview-workflow.spec.ts) pins hosted routing, PR triggers and permissions, immutable full builds, restore-only caching, publication shaping, protected-image checks, and idempotent comments. A physical self-hosted routing mutation fails its routing assertion; restoration passes all three tests. No model-visible runtime behavior changes, so no Session snapshot changes are required.
