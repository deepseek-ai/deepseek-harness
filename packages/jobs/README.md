---
description: "The jobs group map: background-job control — the registry contract, process-local storage, and the model-facing job tools — for users and maintainers navigating the group."
kind: "package-group"
---

# jobs/ — background-job capability family

English | [中文](README.zh.md)

## Summary

The jobs group is the background-work capability family: tools that run long work register it as a job, and the owning agent can read, wait on, list, and cancel it without blocking its own turn. Jobs belong to the agent session that started them, so one agent never sees another's work, and completion is delivered to the owning agent in-session instead of polled. The group splits into the registry contract (`jobs`), its process-local storage (`jobs-local`), and the model-facing control tools with completion notices (`tool-jobs`).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`jobs`](jobs/README.md) | Defines the background-job contract: ids, ownership, lifecycle, and completion listeners | `ctx.jobs` |
| [`jobs-local`](jobs-local/README.md) | Runs and stores jobs in this process, fenced per owner | registers on `ctx.jobs` |
| [`tool-jobs`](tool-jobs/README.md) | Lets the model read, list, and kill jobs and delivers completion notices | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Background task runtime subsystem](../../docs/subsystems/jobs.md) — the job types, snapshot fields, and the `ctx.jobs` API.
- [Generic long-running tool runtime Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) — the design behind the background-job runtime.
- [job-registry seam Agent Note](../../.agents/notes/archived/architecture/2026-07-26-job-registry-seam.md) — the owner-fenced registry contract and its rationale.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
