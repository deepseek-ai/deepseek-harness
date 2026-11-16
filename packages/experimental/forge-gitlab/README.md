---
description: "Serve the experimental forge registry for GitLab hosts through the GitLab CLI on the host."
kind: "package-reference"
---

# @deepseek-ai/dsh-forge-gitlab

English | [中文](README.zh.md)

## Summary

Read and write GitLab.com and self-managed GitLab merge requests for `ctx.forge` with the GitLab CLI that is already signed in on the host. Each poll reads state, changed lines, head pipeline jobs, reviewers and approvals, mergeability, unresolved discussions, and closing issues for every due merge request; the changes view reads the diff pinned to the head, the commits, and the review threads with their positions at the head and where they were last seen. It writes comments as discussions and draft notes, resolves discussions, submits and approves reviews, marks drafts ready, merges, retries pipelines, requests reviews, and rebases.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider after the forge registry and list every self-managed host explicitly. The Forge bundle mounts it with `gitlab.com`.

```yaml
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-forge-gitlab'
  config:
    hosts: [gitlab.com, gitlab.example.com]
```

The provider runs `glab` as a host process, even when Sessions execute commands in another execution world. Sign in once per host with `glab auth login --hostname <host>`. The child receives the host environment without `DSH_*` variables, without variables whose names contain `KEY`, `PASSWORD`, `SECRET`, or `TOKEN`, and without the variables that make `glab` choose another host, repository, or remote, such as `GITLAB_HOST`, `GITLAB_REPO`, and `GLAB_REMOTE_ALIAS`; it runs in the temporary directory, because inside a checkout `glab` resolves project paths against that checkout's remotes. Prompts, update checks, telemetry, pagers, and colors are disabled, and every request names its host with `--hostname`. Numeric limits must be positive safe integers; only `timeoutMs` is bounded by the runtime timer limit. `glabCommand`, `hosts`, `timeoutMs`, `maxOutputBytes`, `maxReviewThreads`, `maxCommits`, `statusBatchSize`, `maxConcurrentRequests`, and `maxCachedVersionBytes` are listed in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-forge-gitlab).

The provider lists its configured hosts in lowercase as `hosts`, names itself `GitLab`, and calls change requests merge requests. It serves a remote URL in `https`, `http`, `ssh`, or `git` form, or in scp form such as `git@gitlab.com:group/sub/app.git`, when its host is configured; nested groups form the repository's owner, such as `group/sub`. HTTP(S) remotes retain custom ports in the host identity; SSH and Git transport ports are excluded. It serves merge request URLs of the form `https://<host>/<namespace>/<project>/-/merge_requests/<number>` with any trailing path, query, or fragment, and builds that form without the suffix as the canonical URL; `fileUrl` returns `https://<host>/<namespace>/<project>/-/blob/<commit>/<path>`. A readiness probe reads the REST `user` resource: success is `ready`, a refusal of the credentials is `unauthenticated` with `glab auth login --hostname <host>` as its sign-in command, and any other failure, including a `glab` that cannot start, is `unavailable`. A head lookup returns up to 20 open merge requests whose source branch is the branch and whose source project is the target project, newest first; a lookup of the project's default branch returns none.

While [forge-session](../forge-session/README.md) runs, the plugin registers the `glab` command rule with it. `glab mr create` and `glab mr new` bind the merge requests they print. `glab mr view`, `glab mr update`, and `glab mr checkout` bind the merge request that a URL selects, or a number with `--repo`, `--repo=`, or `-R` before or after it; a full `http` or `https` project URL supplies the URL directly, and any other repository form, such as `group/app` or a Git URL, resolves through `glab mr view <number> --repo <repository> --output json --jq .web_url` in the call's shell, which applies that shell's `glab` configuration and `GITLAB_HOST`. `glab api` binds the merge request its REST path names, such as `projects/group%2Fapp/merge_requests/7/changes`, with a leading `/` or `api/v4/` or as a full API URL: directly when `--hostname` or the URL names the host, else through `glab mr view <number> --repo <path>`, or without `--repo` for the `:fullpath` and `:id` placeholders; a numeric project id names nothing.

A fetch groups references by host, splits each group into batches of `statusBatchSize` merge requests (default 2), and runs at most `maxConcurrentRequests` (default 4) GraphQL queries at once. GitLab refuses a query whose complexity passes 250, which a merge request with 20 reviewers, 20 approvers, and 50 jobs nearly reaches alone, so a refused batch is halved and read again. Mergeability comes from `detailedMergeStatus`, `mergeStatus`, and `conflicts`. The query selects the merge status before `diffStatsSummary`, after which GitLab 19.5 reports `CONFLICT` for a merge request it found mergeable. `UNCHECKED`, `CHECKING`, `PREPARING`, and `APPROVALS_SYNCING` are unknown, and so is a merge status GitLab has not checked since a change (`UNCHECKED` or `CANNOT_BE_MERGED_RECHECK`), whatever its last outcome says; GitLab checks it again only when a REST read of the merge request asks it to, so the poll sends one and a later poll reads the outcome. Otherwise `CONFLICT` is conflicting even while `conflicts` is false. A merge request is ready to merge when it is open, not a draft, `MERGEABLE`, not conflicting, and the signed-in user may merge it. The project's fast-forward setting makes the merge method `rebase` instead of `merge`, and the merge request's squash settings add, force, or omit `squash`. The review decision is `changes-requested` when a reviewer's state is `REQUESTED_CHANGES`, `approved` when GitLab reports the merge request approved, and `review-required` for `NOT_APPROVED`. Reviewers come first, then approvers who are not reviewers, never the author; a reviewer whose review is awaited is requested, and reviewer states map to `approved`, `changes-requested`, `commented`, and `dismissed`. Checks are the head pipeline's jobs without the ones a retry replaced: a failed job allowed to fail is neutral, a manual job is pending unless it is allowed to fail, which makes it skipped, and the pipeline's status decides the rollup. Every job names its pipeline's global id as its `rerun`, since GitLab retries a pipeline's failed and cancelled jobs together, and `canRerunChecks` follows the signed-in user's right to update the head pipeline. A poll reads the first 50 jobs; `fetchChecks` reads the rest 100 per page, refusing a page whose head moved. `branchUpdates` offers `rebase`, GitLab's only branch update, while the branches have diverged without conflicts, no rebase runs, and the user may push to the head branch; `canRequestReviews` follows the user's right to update the merge request. The unresolved count is GitLab's resolvable discussions less the resolved ones. Closing issues come from REST `closes_issues`, up to 25, and are read again only when the merge request's update time changes; a failed read keeps the last list marked truncated.

`diff` reads the newest MR diff version, which GitLab records for every push, and returns `stale` unless its head is the requested commit; it then joins the version's per-file diffs into one patch with Git's headers, ordered by path as GitLab's raw patch is, and compares a file GitLab collapsed or found too large from its text at both commits. A version whose `real_size` ends in `+`, which GitLab sets past its file limit, is `too-large`. For every open merge request measured, the patch matched GitLab's raw patch except for Git's `index` lines. `commits` lists the merge request's commits oldest first, at most `maxCommits` (default 250), reading the pages that hold the oldest ones when GitLab's `X-Total` counts more. `compare` reads `repository/compare` between two commits and reports a comparison GitLab stopped for time as `too-large`, and `mergeBase` reads `repository/merge_base`. `fileText` reads `repository/files/<path>/raw` at a full commit.

`readReview` reads REST discussions 100 per page until `maxReviewThreads` threads, beside GraphQL pages of the signed-in user's rights on the merge request and on each discussion and note, the user's draft notes, and their approval, then the diff versions; the newest version must be at the requested head, else the read is `stale`. A thread is a discussion whose first note is a diff note on a text or file position; discussions on the overview, on images, and without notes are left out, and system notes are dropped from threads. GitLab keeps one position per thread, at the last diff version whose lines the thread's lines were unchanged in: a position at the head gives `current`, and every line thread keeps its position as `original`. GitLab does not move a multi-line thread's `line_range` when it carries the thread to a new version, so a range's first line is its last line less the range's length. An outdated thread's `diffHunk` is cut from its position's diff: the version's file when GitLab keeps it, or a comparison of the file's text at the position's merge base and head, since GitLab drops the files of earlier versions once a merge request merges. Those patches never change and are kept until they pass `maxCachedVersionBytes` (default 16 MiB); a version larger than that serves its read without being kept. The read is `truncated` when it stops before the last discussion page, leaves the rights of a discussion or of a note past a discussion's first 100 unread, or drops the threads whose hunks and drafts bring the result past `maxOutputBytes`. A thread may be replied to when the user may comment, and resolved when GitLab lets the user resolve its discussion; a note may be edited and deleted when GitLab grants the user `adminNote` on it. The user's draft notes are their pending review, whose id is `draft-notes`: a draft reply joins its thread as a pending comment, and a draft on a file position is a thread of its own, which cannot be replied to or resolved before it is published. GitLab reports no creation time for drafts, so they carry the read's time. `reviewEvents` offers `comment` to a user who may comment, `approve` when GitLab lets them approve or they already approved, since GitLab Community Edition lets authors approve their own merge requests, and `request-changes` only to reviewers, since GitLab records that decision only for them.

`markReady` calls the GraphQL `mergeRequestSetDraft` mutation, and `merge` puts `merge` with `sha` set to the confirmed head and `squash` for the squash method, so GitLab refuses with HTTP 409, reported as `stale`, once the head moved; the merge request's own setting decides whether GitLab deletes the head branch.

Review writes read the newest diff version first and refuse with `stale` unless its head is the confirmed commit. A comment's position names that version's merge base, target tip, and head: an added line names its new line, a deleted line its old line, and any other line both, inside or outside the hunks, and a range adds a `line_range` with GitLab's line codes; a line the version's diff does not hold is refused before anything is written, and a comment on an unchanged line reads back on the new side. A file GitLab collapsed or found too large is placed on the diff compared from its texts, and a file's new path names it over another file's old path. `submitReview` starts a discussion for one comment. A review writes each comment as a draft note, approves at the head when its decision is `approve`, and publishes the drafts with the summary and the review state of `comment` (`reviewed`) or `request-changes` (`requested_changes`); a refused draft or approval deletes the drafts it wrote. After a refused publication the drafts are read again, since GitLab can publish them before refusing the summary: they are deleted only when all remain, else the result is `unknown`. A deletion that fails makes the result `unknown` with the number of drafts that may remain. A review is refused while the user holds drafts, which publishing would include. Pending replies and comments are draft notes, which `submit-pending` publishes in the same way and `discard-pending` deletes one by one, reporting how many it deleted before a refusal. An approval is skipped when the user already approved, since GitLab answers a second one with HTTP 401. Replies, resolutions, edits, and deletions go through the merge request's own paths, so GitLab refuses ids of another merge request.

`rerunChecks` retries the head pipeline once it has failed jobs and none pending. `requestReviews` adds new reviewers with `mergeRequestSetReviewers` and asks current ones again with `mergeRequestReviewerRereview`; a merge request that takes one reviewer, as on GitLab's free tier, refuses a second, and GitLab has no team reviewers. `reviewerCandidates` lists at most 20 of GitLab's matches among the users who can see the project, never the author, none suggested. `updateBranch` only rebases: GitLab names no head in a rebase request, so the provider reads the head first and refuses a moved one with `stale`, and GitLab rebases in the background once it accepted the request. Writes are never retried: a 4xx answer is a refusal, `failed`, except HTTP 401, `unauthenticated`, and HTTP 409 to a merge or an approval, `stale`; a 5xx answer, an answer without a status, and a write past `timeoutMs` are `unknown`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each status query reads several merge requests under aliases with their project paths and numbers as variables, so a missing project or merge request fails only its own alias.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Configuration validation, and provider and command rule registration |
| [`src/commands.ts`](src/commands.ts) | The `glab` command rule that forge-session binds merge requests by |
| [`src/provider.ts`](src/provider.ts) | URL mapping, batching, closing issue and diff caches, and actions |
| [`src/api.ts`](src/api.ts) | REST, GraphQL, and write requests through `glab api`, and failure mapping |
| [`src/status.ts`](src/status.ts) | Status query construction and snapshot mapping |
| [`src/diff.ts`](src/diff.ts) | Version-pinned patches, comparisons, merge bases, and file texts |
| [`src/commits.ts`](src/commits.ts) | Commit listing oldest first |
| [`src/review.ts`](src/review.ts) | Discussion, draft note, and permission reads, and mapping onto head and original positions |
| [`src/writes.ts`](src/writes.ts) | Review writes and submissions through discussions, draft notes, and approvals |
| [`src/position.ts`](src/position.ts) | Diff note positions and line codes from a version's file diff |
| [`src/overview.ts`](src/overview.ts) | Pipeline retries, review requests, reviewer candidates, and rebases |
| [`src/pool.ts`](src/pool.ts) | Bounded concurrency |
| [`src/glab.ts`](src/glab.ts) | Host `glab` execution with environment scrubbing and limits |
| [`src/urls.ts`](src/urls.ts) | Remote, merge request, and issue URL parsing, and project path validation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Forge registry](../forge/README.md) — provider registration and shared polling.
- [Forge subsystem](../../../docs/subsystems/forge.md) — provider contract and change request types.
- [GitHub provider](../forge-github/README.md) — the provider this one mirrors for GitHub hosts.

-----

<a id="model-experience"></a>
## Model Experience

None, as the provider reads and writes merge requests for host-side watchers and the panel without contributing model context.

#### KV Cache effect

None. Provider output reaches only host-side watchers.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **GitLab CLI on the host** — `glab` must be installed and signed in for each configured host; tokens in environment variables are not forwarded. Hosts missing from `hosts` are never read; a status fetch returns `unavailable` for their references, and a head lookup rejects before starting `glab`. A host whose SSH remotes use another host name, or a GitLab installed under a path prefix, is not recognized.
- **No viewed marks** — the provider keeps no viewed marks, so the changes view keeps them in the browser, as GitLab's own pages do.
- **Rebase without a head check** — a push between the head read and the rebase request is rebased too, and a rebase GitLab fails in the background is not reported.
- **Overview discussions** — discussions that are not on a file count toward `unresolvedThreads` but are not returned as threads.
- **Bots and draft times** — comment authors are never marked as bots, and draft notes carry the read's time.
- **CE fields only** — the status query reads fields Community Edition has; required approvals, code owners, suggested reviewers, and merged-results pipelines of paid tiers are not read.
- **Rate limits** — every poll costs one GraphQL query per batch plus one REST request per merge request whose update time changed; a review read costs one REST and one GraphQL request per 100 discussions, one request each for the versions, the draft notes, and the approval, and up to two per outdated file not yet cached; a write reads the newest version first, and a comment reads its version's files once.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
