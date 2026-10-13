---
kind: upgrade-guide
description: "JobId now identifies one background execution across registry lifetimes."
---

# Background job ids identify one execution

English | [中文](guide.zh.md)

## Change

The job registry returns `<kind>-<short-uuid>` instead of `<kind>-N`; the suffix is 16 lowercase UUID hex characters. The same `JobId` appears in live controls, `job/registered`, and `job/settled`; lifecycle records no longer carry `executionId`. The identifier remains owner-authorized. Existing Session histories remain unchanged and do not resume their jobs.

## Migration

1. Pass the exact id returned by a start result or `jobs.list()` to `job_output` and `job_kill`; use `job_output` with `wait: true` to wait. Remove code that constructs an id from the kind and an ordinal.
2. Pair SDK lifecycle events by `data.jobId`. Remove imports of `JobExecutionId` and code that maps it to a process-local `jobId`.
3. Verify a new job's registration and settlement contain the same `jobId`, and a later registry instance issues a different one.
