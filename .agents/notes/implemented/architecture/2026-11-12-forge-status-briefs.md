# Agent Note: Forge status briefs

Status: implemented

English | [中文](2026-11-12-forge-status-briefs.zh.md)

## Problem

The Session list shows a state glyph for every change request that a listed Session binds, and read the full snapshot of each one for it: up to 100 check contexts, reviewers, review threads, linked issues, and the repository's merge settings. The registry batches every due change request of a forge, and the GitHub provider put a host's whole batch in one GraphQL query. GitHub ends a request after 10 seconds of processing: a snapshot query of 20 deepseek-harness pull requests took 10.2 s, one of 30 answered HTTP 504, and one of 61 HTTP 502. Every watch of a new list run was due at once, so the list of a user with about 30 bound pull requests failed as a whole and retried as a whole. Opening a Session whose change request the list already watched read nothing, so its panel waited up to one idle interval for a newer status.

## Decision

**Two levels of status.** A brief holds what a list shows: title, state, draft flag, mergeability, review decision, and combined check outcome. `ctx.forge.watchBrief` watches it; `ctx.forge.watch` watches the snapshot. A watched change request is polled for its snapshot while it has a snapshot watcher and for its brief otherwise. A snapshot holds a brief, so brief watchers receive every result. Providers read briefs through the optional `fetchBriefs`; the registry reads snapshots from a provider without it.

**GitHub brief query.** forge-github reads a brief from the pull request's own scalars and the `statusCheckRollup.state` of its head commit, 50 pull requests per query (`briefBatchSize`). Measured on deepseek-harness pull requests through `gh`, one query read 8 in 1.4 s, 31 in 2.3 to 2.8 s, and 61 in 3.0 to 3.7 s, at a rate-limit cost of 1 point each. In a snapshot query the check contexts are the largest part: 174 of 186 KB and 1.4 of 3.8 s for 8 pull requests.

**GitHub snapshot queries of bounded size.** A Session can bind many pull requests, and its panel watches the snapshot of each. forge-github puts at most 8 pull requests of a host in one snapshot query (`snapshotBatchSize`): measured the same way, a query of 5 took 3.6 s, one of 8 took 4.4 to 6.3 s, and one of 10 took 5.8 s. A snapshot read and a brief read each build every query before the first request and send them one after another, because GitHub asks an account to send its requests serially. A query whose `gh` run fails, and one GitHub refuses, fails only its own pull requests.

**One fetch in flight per forge and level.** A snapshot fetch for an open panel does not wait behind the brief fetch of a long list, and a host sees at most two status requests of one registry at a time.

**What the list already knows.** The list's run passes the state it stored for a change request as `known`. The registry times the first poll as it would after a read at `known.fetchedAt`, so a merged change request is not read again, and a run that follows another in the same process waits for the interval. Read times stay in memory; a state stored by an earlier process counts as read at the epoch.

**A status newer than the latest one.** A snapshot watcher may pass `maxAgeMs`. The Session panel and the review page pass `statusMaxAgeMs` (10 seconds), so opening a Session reads its change requests at once unless they were just read. The installed desktop apps of two peer products do the same: Codex refetches a thread's pull request when the thread mounts with data older than 15 seconds, and Claude prefetches a session's pull request when its row is pressed, with a freshness of 10 seconds.

## Alternatives considered

**Bounding snapshot queries only** keeps each query short, but a list of 61 pull requests then needs 8 queries and 38 s, past the registry's 30 s fetch deadline, for fields the list never shows.

**A longer `fetchTimeoutMs` or concurrent snapshot queries** leave GitHub's processing time per query unchanged, and GitHub allows one account 60 s of GraphQL CPU time per 60 s.

**REST with conditional requests** returns HTTP 304 without rate-limit cost through `gh`, but takes one `gh` process per pull request, about 1.2 s each, and carries no combined check state.

**Webhooks** need a server that receives them; the Host is a local process that reads through the user's `gh`.

**A `level` option on `watch`** would give one method two listener types; two methods keep each listener's update type exact.

**Storing read times** would save the first brief read after a Host restart only when the restart falls within one poll interval, at the cost of a change to the stored record.

## Consequences

For the case measured, 14 open and 17 merged bound pull requests, a poll of the list is one request of about 1.7 s in place of one query of 31 snapshots, which GitHub answered with HTTP 504, and the merged ones are not read. A brief reports GitHub's combined check state, while a snapshot with a complete check list derives its own from the newest run of each check; the two agreed for all 61 open pull requests measured, and nothing reconciles them when they differ. Both levels share the poll intervals, which are unchanged. Every query of one read still runs under the registry's one fetch deadline, which forge-github's own `gh` timeout equals by default: a read that outlives it fails as a whole, the pull requests of queries already answered included, and a query whose `gh` run hangs ends the read before its own timeout isolates it. Changing that takes a registry that accepts the results of one query at a time, not a provider change.
