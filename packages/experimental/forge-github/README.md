---
description: "Serve the experimental forge registry for GitHub hosts through the GitHub CLI on the host."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge-github

English | [中文](README.zh.md)

## Summary

Read GitHub and GitHub Enterprise pull requests for `ctx.forge` with the GitHub CLI that is already signed in on the host. Each poll batches pull requests by host to read state, changed lines, checks, review decision, mergeability, and unresolved review threads for every due pull request.

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

Mount the provider after the forge registry and list every GitHub Enterprise host explicitly.

```yaml
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-experimental-forge-github'
  config:
    hosts: [github.com, ghe.example.com]
```

The provider runs `gh` as a host process, even when Sessions execute commands in another execution world. Sign in once per host with `gh auth login --hostname <host>`. The child receives the host environment without `DSH_*` variables and without variables whose names contain `KEY`, `PASSWORD`, `SECRET`, or `TOKEN`, so `GH_TOKEN` and `GITHUB_TOKEN` are not forwarded and `gh` uses its own credential store. Prompts, update notices, pagers, and colors are disabled. `maxOutputBytes` and `maxReviewThreads` must be positive safe integers; only `timeoutMs` is bounded by the runtime timer limit. `ghCommand`, `hosts`, `timeoutMs`, `maxOutputBytes`, and `maxReviewThreads` are listed in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-forge-github).

The provider serves a remote URL in `https`, `http`, `ssh`, or `git` form, or in scp form such as `git@github.com:owner/name.git`, when its host is configured. HTTP(S) remotes retain custom ports in the host identity; SSH and Git transport ports are excluded. It serves pull request URLs of the form `https://<host>/<owner>/<name>/pull/<number>` with any trailing path, query, or fragment, and builds that form without the suffix as the canonical URL. A readiness probe runs `gh auth status --hostname <host>`: exit status 0 is `ready`, another exit status is `unauthenticated` with the first diagnostic line, and a `gh` that cannot start is `unavailable`. A head lookup returns up to 20 open pull requests whose head is the branch, newest first, excluding pull requests from forks; a lookup of the default branch returns none.

Polling returns the first 100 head-commit check contexts without following pages. An incomplete preview sets `checksTruncated` and keeps GitHub’s aggregate state; its counts do not describe the full list. `fetchChecks(ref, signal)` reads complete details only for the requested PR, pinning continuation pages to the first response’s rollup. The combined UTF-8 JSON responses, review thread pages included, must fit `maxOutputBytes`; excess returns `too-large`. Failed or non-advancing pages fail only this detail read and leave polling results intact. Runs with the same application, workflow, event, and check name keep only the newest run id; a queued replacement supersedes an older completed run. Runs without a numeric database id are retained by node id because their relative age is unknown. Commit status contexts keep the newest result per context name. Complete lists derive their indicator from these results; unknown context kinds retain GitHub’s aggregate state.

Every status read counts review threads in pages of up to 100 until it has counted `maxReviewThreads` (default 1,000) of them; each page after the first is one more GraphQL query. A pull request with more threads sets `threadsTruncated`, and its `unresolvedThreads` counts only the threads read. A thread page that fails or does not advance fails that pull request's status read and leaves the other pull requests of the batch intact; a partial count is not published.

Unfinished check runs and completed runs with stale, missing, or unrecognized conclusions map to `pending`. Other completed checks map to `success`, `failure` (failure, timed out, startup failure, or action required), `cancelled`, `skipped`, or `neutral`. Cancelled checks keep the rollup non-passing. Check runs keep their start and completion times. Commit status contexts map `SUCCESS` to `success`, `FAILURE` and `ERROR` to `failure`, and every other state to `pending`, and carry no times. A GraphQL `NOT_FOUND` error becomes a `not-found` failure. A response without GraphQL data or errors, including an HTTP error JSON body, uses the first stderr diagnostic or the body's message. Authentication diagnostics become `unauthenticated`; oversized check pages become `too-large`; rate limits and other failures become `unavailable`. Head lookups preserve the same diagnostic in their rejection.

A pull request is `mergeReady` when it is open, not a draft, GitHub reports its merge state as `CLEAN`, `HAS_HOOKS`, or `UNSTABLE`, and the signed-in user has write, maintain, or admin permission. `mergeMethods` lists the squash, merge-commit, and rebase methods the repository allows, the user's default merge method first. Marking ready runs `gh pr ready <number> --repo <host>/<owner>/<name>`. Merging calls `PUT repos/<owner>/<name>/pulls/<number>/merge` through `gh api` with the method and the expected head SHA, so GitHub refuses once new commits arrived, which is reported as `stale`. Unlike `gh pr merge`, it never enables auto-merge, never joins a merge queue, and never deletes the head branch. A refused action reports GitHub's message, and a diagnostic that mentions authentication becomes `unauthenticated`.

`diff` reads `headRefOid` and `baseRefOid` in one GraphQL query and returns `stale` when the head is not the requested commit, which must be a full 40- or 64-digit hexadecimal commit. Otherwise it reads `repos/<owner>/<name>/compare/<baseRefOid>...<headSha>` through `gh api --allow-escape-sequences` with the diff media type, the patch from the merge base of both commits, so neither end follows a moving branch. For every open and merged pull request measured, this patch is byte-identical to `gh pr diff`, which takes no commit argument. Unlike the pull request diff, the compare endpoint returns diffs over 300 files, so only output over `maxOutputBytes` or GitHub's own refusal makes such a diff `too-large`. `--allow-escape-sequences` keeps terminal escape sequences that file contents hold, which `gh` 2.97 and newer otherwise refuse to print; an older `gh` rejects the option with `unknown flag` before sending a request and prints such sequences unchanged, so that rejection repeats the read without it. `fileText` reads `repos/<owner>/<name>/contents/<path>?ref=<commit>` through `gh api` with the raw media type and accepts only a full 40- or 64-digit hexadecimal commit. `fileUrl` returns `https://<host>/<owner>/<name>/blob/<commit>/<path>`. Both paths percent-encode each segment. A refused read becomes `not-found` for HTTP 404, `unauthenticated` for a diagnostic that mentions authentication, `too-large` for GitHub's HTTP 406 refusal or `too_large` error, which a diff or file over its size limit draws, and `unavailable` otherwise, with GitHub's message. A read whose output exceeds `maxOutputBytes` becomes `too-large`, and one that outlives `timeoutMs` becomes `unavailable`.

Review submission checks the current pull request head, then posts a single inline comment or one completed review through the REST API with an explicit `commit_id`. Multiline comments carry their side and inclusive start and end lines. Review decisions are Comment, Approve, and Request changes. JSON request bodies travel on stdin. The provider never retries a mutation: a timeout, unexpected response, or server error after dispatch returns an unknown outcome that the caller must reconcile on GitHub. A commit arriving between the check and the write can make the explicitly addressed review outdated; GitHub does not offer an atomic head precondition on these endpoints.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A fetch groups references by host and sends one initial `gh api graphql` query per host. Continuation queries use the original rollup node id, so a changed pull request head cannot mix commits within one check list. The query inlines validated owner, name, and number values and gives each pull request an alias, so partial GraphQL errors fail only their own aliases. `gh` exits nonzero on partial errors but still prints the complete response, which the provider parses before it inspects the exit code.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Configuration validation and provider registration |
| [`src/provider.ts`](src/provider.ts) | URL mapping, host grouping, and failure classification |
| [`src/graphql.ts`](src/graphql.ts) | Query construction and response validation and mapping |
| [`src/compare.ts`](src/compare.ts) | Patch between two commits through the compare API, shared by every diff read |
| [`src/gh.ts`](src/gh.ts) | Host `gh` execution with environment scrubbing and limits |
| [`src/urls.ts`](src/urls.ts) | Remote URL and pull request URL parsing, and validation of inlined names and commits |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Forge registry](../forge/README.md) — provider registration and shared polling.
- [Forge subsystem](../../../docs/subsystems/forge.md) — provider contract and change request types.
- [Subprocess environment](../../subprocess/subprocess/README.md) — the shared environment scrub.

-----

<a id="model-experience"></a>
## Model Experience

None, as the provider reads pull request status for host-side watchers without contributing model context.

#### KV Cache effect

None. Provider output reaches only host-side watchers.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **GitHub CLI on the host** — `gh` must be installed and signed in for each configured host; tokens in environment variables are not forwarded. Hosts missing from `hosts` are never read, including references retained across configuration changes. A status fetch returns `unavailable` for those references; a head lookup rejects before starting `gh`.
- **Review thread bound** — a status read counts at most `maxReviewThreads` review threads per pull request; beyond it `unresolvedThreads` is a lower bound that `threadsTruncated` marks.
- **Batch deadline** — continuation pages of a pull request with many review threads lengthen its host's polling batch; a batch that outlives `ctx.forge`'s `fetchTimeoutMs` reports `unavailable` for every pull request in it, not only for the one with many threads.
- **Rewritten base branch** — the diff starts from the merge base of the head and the base commit GitHub recorded at the pull request's last update. After the base branch is force-pushed, that merge base can differ from the one GitHub's pull request view uses, so the patch can include or omit commits until the pull request is updated.
- **No fork discovery** — head lookups exclude pull requests whose head is in another repository.
- **Rate limits** — every poll costs one GraphQL query per host, plus one query per further page of 100 review threads, and a complete check read one more query per further page of 100 check records; every diff read costs one GraphQL query and one REST request. All count against the signed-in account’s rate limit.
- **No merge queue** — a base branch that requires a merge queue refuses a direct merge, and the provider never queues one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
