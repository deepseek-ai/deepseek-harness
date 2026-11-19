# Agent Note: Forge status briefs

Status: implemented

English | [中文](2026-11-12-forge-status-briefs.zh.md)

## Problem

The Session list shows a state glyph for every change request that a listed Session binds, and read the full snapshot of each one for it: up to 100 check contexts, reviewers, review threads, linked issues, and the repository's merge settings. The registry batches every due change request of a forge, and the GitHub provider put a host's whole batch in one GraphQL query. GitHub ends a request after 10 seconds of processing: a snapshot query of 20 deepseek-harness pull requests took 10.2 s, one of 30 answered HTTP 504, and one of 61 HTTP 502. Every watch of a new list run was due at once, so the list of a user with about 30 bound pull requests failed as a whole and retried as a whole. Opening a Session whose change request the list already watched read nothing, so its panel waited up to one idle interval for a newer status.

Other reads repeated without need. Change requests shared a fetch only when they became due in the same millisecond, so 14 list watches cost 30 queries an hour while they stayed aligned and 415 once they had drifted apart. Each time a Session's panel was shown again, the Host probed sign-in and looked the branch up again, and the client forced a second status read. Each saved viewed mark made every open changes view read all marks and all review threads again. A push or a `gh pr merge` by the agent started no status read.

## Decision

**Two levels of status.** A brief holds what a list shows: title, state, draft flag, mergeability, review decision, and combined check outcome. `ctx.forge.watchBrief` watches it; `ctx.forge.watch` watches the snapshot. A watched change request is polled for its snapshot while it has a snapshot watcher and for its brief otherwise. A snapshot holds a brief, so brief watchers receive every result. Providers read briefs through the optional `fetchBriefs`; the registry reads snapshots from a provider without it.

**GitHub brief query.** forge-github reads a brief from the pull request's own scalars and the `statusCheckRollup.state` of its head commit, 25 pull requests per query (`briefBatchSize`). Measured on deepseek-harness pull requests through `gh`, a query of 10 took 1.6 to 2.0 s, one of 25 took 2.5 to 3.4 s, and one of 50 took 2.9 to 6.8 s, at a rate-limit cost of 1 point each; 25 leaves a wider margin to GitHub's 10 seconds than 50 does. In a snapshot query the check contexts are the largest part: 174 of 186 KB and 1.4 of 3.8 s for 8 pull requests.

**GitHub snapshot queries of bounded size.** A Session can bind many pull requests, and its panel watches the snapshot of each. forge-github puts at most 8 pull requests of a host in one snapshot query (`snapshotBatchSize`): measured the same way, a query of 5 took 3.6 s, one of 8 took 4.4 to 6.3 s, and one of 10 took 5.8 s. Queries are sent one after another, because GitHub asks an account to send its requests serially. A query whose `gh` run fails, and one GitHub refuses, fails only its own pull requests.

**One provider call per query.** A provider may name `snapshotBatchSize` and `briefBatchSize` to the registry, and forge-github does. The registry then calls the provider once per that many due change requests of a host, one call after another, each within its own `fetchTimeoutMs`, and settles the watches of a call when it returns. A call that fails or outlives its deadline fails only its own change requests, and the results of earlier calls stay published. A provider that names no size, as forge-gitlab, is called once with every due change request of the forge.

**One fetch in flight per forge and level.** A snapshot fetch for an open panel does not wait behind the brief fetch of a long list, and a host sees at most two status requests of one registry at a time.

**Polls that share a fetch.** A fetch reads the due change requests of its forge and level, and also those past the midpoint of the wait after their latest status. Change requests that became due at different times therefore return to one fetch: the 14 list watches cost 30 queries an hour at the earlier intervals whether they were bound together, one after another, or had checks running for a while. A change request waits out the backoff after a failed read in full.

**Intervals.** An open change request is polled every 15 seconds while its checks run and every 60 seconds otherwise (`activeIntervalMs`, `idleIntervalMs`), at both levels. A status that first reports an unknown mergeability earns one poll at the active interval; one that reports it again waits the idle interval, because 11 of 98 open pull requests measured, all drafts stacked on another pull request's branch, kept reporting it.

**What the list already knows.** The list's run passes the state it stored for a change request as `known`. The registry times the first poll as it would after a read at `known.fetchedAt`, so a merged change request is not read again, and a run that follows another in the same process waits for the interval. Read times stay in memory; a state stored by an earlier process counts as read at the epoch.

**A status newer than the latest one.** A snapshot watcher and `refresh` may pass `maxAgeMs`. The Session panel and the review page pass `statusMaxAgeMs` (10 seconds) when they start, so opening a Session reads its change requests at once unless they were just read; showing the panel again and focusing the window call the `revisit` Remote, which polls with the same bound, while the reader's refresh stays forced. The installed desktop apps of two peer products do the same: Codex refetches a thread's pull request when the thread mounts with data older than 15 seconds, and Claude prefetches a session's pull request when its row is pressed, with a freshness of 10 seconds.

**Reads after the agent's commands.** After a push result, forge-session calls `ctx.forge.expectChange` for the visible change requests in the pushed repository: a watched one is polled at once and then at the active interval until a status reports running checks, for at most one idle interval. When a turn that had a tool result ends, forge-session refreshes the Session's visible change requests with the age of that result as `maxAgeMs`.

**Nothing read for a hidden page.** The client closes the panel streams, the list's state stream, and the review count stream once the page has been hidden for 30 seconds, and opens them again when it shows. The Host polls only while a stream is open, so it needs no report of the page's visibility, and it keeps polling while any tab of the page is visible.

**Panel state kept between followers.** A Session's panel leaves its last state, snapshots, and branch lookup when its last follower leaves, and the next panel of that Session starts from them unless the Session moved to another directory. It repeats neither the sign-in probe of a host found ready nor the branch lookup of a Session that shows a change request; a status read refused as unauthenticated starts one probe.

**Viewed marks kept on the Host.** The Host keeps the viewed marks read for a change request by head commit, under the bounds of the kept review threads. A saved mark replaces the kept state of its file and leaves the kept threads, so a save costs the provider's write and no further read.

## Alternatives considered

**Bounding snapshot queries only** keeps each query short, but a list of 61 pull requests then needs 8 queries and 38 s for fields the list never shows.

**A longer `fetchTimeoutMs` or concurrent snapshot queries** leave GitHub's processing time per query unchanged, and GitHub allows one account 60 s of GraphQL CPU time per 60 s.

**REST with conditional requests** returns HTTP 304 without rate-limit cost through `gh`, but takes one `gh` process per pull request, about 1.2 s each, and carries no combined check state.

**Webhooks** need a server that receives them; the Host is a local process that reads through the user's `gh`.

**A `level` option on `watch`** would give one method two listener types; two methods keep each listener's update type exact.

**Storing read times** would save the first brief read after a Host restart only when the restart falls within one poll interval, at the cost of a change to the stored record.

**A queue per host with a lane for user actions** would let a refresh pass a fetch in flight. The two levels already keep an open panel apart from the list, and a snapshot query takes 2 to 6 s, so the queue would save that much on a refresh at the cost of a second scheduler.

**A random offset on each interval** spreads requests over time, which is the opposite of what the measured cost needs: it would separate change requests that one query reads together.

**Pausing a host after a refused read** saves little: 14 change requests that were all refused as unauthenticated backed off together and cost 10 queries in an hour.

**A budget of one background query per interval** matters only past the size one fetch reads in time; 100 pull requests took two brief queries of 50 and 7.6 s.

**A faster cadence after a push**, 5 seconds for a minute as one peer product uses, needs two more settings; the active interval shows new checks at most about 10 seconds later.

## Consequences

For the case measured, 14 open and 17 merged bound pull requests, a poll of the list is one request of about 1.7 s in place of one query of 31 snapshots, which GitHub answered with HTTP 504, and the merged ones are not read. At the 60-second idle interval that is 59 queries an hour while the page is visible, and none while it is hidden. A change request past the midpoint of its wait is read with any fetch of its lane, so one whose neighbor has running checks is read up to twice as often as its own interval asks; the number of queries does not grow with it. A brief reports GitHub's combined check state, while a snapshot with a complete check list derives its own from the newest run of each check; the two agreed for all 61 open pull requests measured, and nothing reconciles them when they differ. One snapshot query and the continuation pages of its pull requests share one deadline, so a pull request with many review threads can fail the up to 8 pull requests of its query. A viewed mark changed on the code host itself shows after `reviewRefreshMs` or the reader's refresh. A page that stays visible without a reader keeps polling.
