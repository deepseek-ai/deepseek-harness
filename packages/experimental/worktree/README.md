---
description: "Create, enter, and leave retained Git worktrees under the calling Session file policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-worktree

English | [中文](README.zh.md)

## Summary

Create an isolated checkout from a local commit and continue the same Session in it. Each operation creates a new named branch and leaves the source checkout intact. The existing sandbox governs all writes except archive cleanup. Leaving the checkout retains its files and branch.

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

Mount the service alongside `workingDirectory`, `fs`, `subprocess`, `sandbox`, `sandboxPolicy`, and `sessionProjections` providers. Archive cleanup additionally needs `workspaceRegistry` and `sessionQuery`, and uses `sessionProjectionCache` when it is mounted; without the first two the service only creates and restores. The service mounts the [linked-worktree grant](../sandbox-policy-git/README.md), which on macOS and Linux lets a Session that works in a linked worktree write its repository's Git directory under `workspace-write`. Add the tool package when models need the operation.

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

`ctx.worktrees.create(agent, { name?, from?, fetch? }, signal?, onPhase?)` creates a new branch and checkout, then enters the canonical checkout directory through `ctx.workingDirectory.set`. `from` resolves to a local commit before creation and defaults to `HEAD`. With `fetch: true`, `from` must be the full name of a remote-tracking branch, `refs/remotes/<remote>/<branch>`, of a configured remote, the longest remote name winning when names nest; creation first runs `git fetch --no-tags --no-recurse-submodules --no-write-fetch-head --no-auto-maintenance <remote> +refs/heads/<branch>:<from>`, so only that branch is fetched, then resolves the fetched commit. The fetch runs under the Session's sandbox policy and the command deadline, without prompts, and a failed fetch creates nothing; staged, unstaged, untracked, and ignored source files are not copied. `baseCommit` reports the resolved commit object name; repository-local replacement refs still apply to the checked-out content. Checkout disables configured Git clean, smudge, and process filters without changing repository configuration. An existing branch or checkout path is an error. The returned record contains `path`, `branch`, `baseCommit`, and `repositoryRoot`. An optional fourth argument, `onPhase`, receives `fetch` first when the request asks to fetch, `prepare` before validation, directory allocation, and branch creation, and `checkout` before the files are written and the checkout is entered; it must not throw.

`ctx.worktrees.enter(agent, { name }, signal?)` moves the Session into an existing worktree in the pool of the checkout it works in, through `ctx.workingDirectory.set`. `name` is the directory relative to that pool, the name `create` gave the worktree. The directory must resolve inside the pool and be a registered worktree of the repository; otherwise the call rejects with `WORKTREE_NOT_FOUND` and the Session stays where it is. Entry runs no Git command that writes, and resolves to the checkout's `path`, its `branch` unless HEAD is detached, and the `repositoryRoot` the Session entered from.

`ctx.worktrees.exit(agent, signal?)` returns the Session from the recorded worktree that contains its current directory to that worktree's `repositoryRoot` through `ctx.workingDirectory.set`, and resolves to the record of the worktree it left: its creation when the log holds one, otherwise its entry. The record can be the Session's own or fork-inherited, and nested worktrees exit one level per call. The checkout and branch remain. The call rejects with `WORKTREE_NOT_ENTERED` when no recorded worktree contains the current directory, and with the working-directory service's error when the source checkout no longer exists.

`ctx.worktrees.restore(agent, { path, branch, baseCommit, repositoryRoot }, signal?, onPhase?)` checks a removed worktree out again at its recorded directory. It validates the recorded repository root, full commit object name, branch, and canonical target inside the configured pool before mutation. It removes only the missing target's unlocked registration with `git worktree remove`; other worktrees and locked registrations remain unchanged. Its commands run under the Session's policy bounded by the recorded source checkout, which contains the target, so a Session whose own root is the removed worktree can restore it. It then checks out the branch when it still exists, or creates the branch again at `baseCommit` when it does not, and reports which happened as `branchRecreated`. An existing directory is an error. The calling Session's working directory does not change, and changes that were never committed are not recovered. Checkout disables filters as creation does. `onPhase` receives `prepare` before validation, target-registration cleanup, and branch creation, and `checkout` before the files are written; it must not throw.

Every creation appends a `plugin:worktree/created` record to the Session log after the directory change, so the `worktree` projection lists the Session's checkouts with `owned` false for one inside a fork-inherited prefix. Every entry appends a `plugin:worktree/entered` record, which only `exit` reads: archiving a Session never removes a checkout it only entered, and an entry does not retain a checkout the Session has left. When the Workspace archives a Session, the service registers one `scheduled` cleanup for the first checkout that Session created itself and returns; the inspection runs in the background. While `retainOnArchive` is on, archiving registers nothing and every checkout stays; the field is volatile and read at each archive, and the [Forge panel](../client-ui-forge/README.md) edits it as a switch on the bundle's worktree row of the Plugins page. The checkout is retained while any unarchived Session refers to it, by a recorded creation or by a working directory inside it (a Session beneath an archived subagent ancestor counts as archived; cold Sessions are read from the projection cache or their log). A cold creator is observed through `sessionQuery.observeSession` without being attached or resumed. Archiving is the user's authorization to remove the checkout, so cleanup reads no sandbox policy and its Git commands run unconfined; only the checks below bound it. An eligible checkout is removed with a non-force `git worktree remove`, run from the recorded source checkout, which contains the target, after a second use check inside the path lock, which also holds `ensure` and `set` into that path through `working-directory/access`; the branch and its commits remain. Tracked changes, untracked files, an initialized submodule (a repository in the checkout's administrative `modules` directory), locks, detached HEAD, a mismatched branch, and targets outside the configured pool retain the checkout. Ignored files and edits to skip-worktree or assume-unchanged files do not: `git status` reports neither, and Git discards them with the checkout. A committed embedded repository is not inspected; Git refuses that removal, so the attempt settles as `failed`. Inspection stops reading `git status` at its first entry and streams the worktree listing, keeping its entries in memory while it looks for the checkout; neither output is bounded by `maxOutputBytes`. Processes are not consulted: a process still writing there makes Git refuse, and an idle one fails its next command. Unarchiving cancels an unadmitted removal and waits for an admitted one. `cleanupOf(session, revision)` reads the attempt, or waits for a named revision to settle, as `scheduled`, `retained`, `removed`, or `failed`; a failure leaves the Session archived and logs a warning. Checkouts created before this event existed, and Sessions archived earlier, are not swept.

Expected failures throw `WorktreeError` with a stable `code`: `WORKTREE_INVALID_ARGUMENT` for a name Git or the pool rules reject, an empty start revision, or a restoration record that violates a documented constraint, while a start revision or base commit Git cannot resolve fails as `WORKTREE_COMMAND_FAILED`; `WORKTREE_ALREADY_EXISTS` for an existing branch or path; `WORKTREE_LOCKED` for a locked registration; `WORKTREE_NOT_FOUND` for an entry whose name selects no registered worktree in the pool; `WORKTREE_NOT_ENTERED` for an exit while the Session's directory lies in no recorded worktree; `WORKTREE_COMMAND_FAILED`, `WORKTREE_OUTPUT_TOO_LARGE`, and `WORKTREE_TIMEOUT` for a command that exits unsuccessfully, exceeds `maxOutputBytes`, or exceeds `timeoutMs`; and `WORKTREE_UNAVAILABLE` after service disposal. A failure after directory allocation adds the retained-artifact context to its message and keeps the original error's `name` and `code`; caller cancellation stays an `AbortError`.

The default checkout directory is `<current checkout root>/.agents/worktrees/<name>`. The returned `repositoryRoot` is the top-level directory of the caller’s current checkout; when it is a linked checkout, the pool is nested inside it. Omitted names join the `dsh-` prefix, the first eight hexadecimal digits of the UUID in the Session id, a hyphen, and four random hexadecimal digits, such as `dsh-6b1f02c4-9a3e`; a Session id without a UUID gets eight random hexadecimal digits after the prefix. `generatedWorktreeName` exports the same rule for callers that name a worktree before creating it. The service writes a `.gitignore` containing `*` and a trailing newline only when its allocation creates the pool; existing files and ignore rules are preserved. Each Git and Node command runs under its own `timeoutMs` deadline, 5 minutes by default, so checking out a large repository on a slow filesystem can finish; cancellation still stops the running command. Relative `directory`, generated `namePrefix`, executable choices, process limits, and `retainOnArchive` are configurable in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-worktree).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Git and directory allocation run through the mounted subprocess and sandbox providers with the calling Session's existing file policy; archive cleanup runs them unconfined. Creation itself does not widen write access to the destination or shared Git administration directory; a Session that works in a linked worktree holds the latter through the linked-worktree grant. Directory creation claims the destination exclusively; cancellation and failed setup can leave retained artifacts, whose path appears in the error. Service disposal aborts pending operations and waits for their settlement.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Resolve the source revision, create the checkout, and publish the new working directory |
| [`src/process.ts`](src/process.ts) | Confine literal argv, cap output, and await process termination |
| [`src/directory.ts`](src/directory.ts) | Claim the destination and initialize a newly created pool's ignore file |

No runtime invariant companion is published: Git owns checkout registration and the working-directory service owns the Session directory; this package retains no independent projection of either.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Worktree subsystem](../../../docs/subsystems/worktrees.md) — request, result, and service reference.
- [Working directory](../../session/working-directory/README.md) — recorded Session directory and directory changes.
- [Worktree tool](../tool-worktree/README.md) — model-facing creation.
- [Subprocess](../../subprocess/subprocess/README.md) — process ownership and execution worlds.
- [Creation decision](../../../.agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.md) — retained checkouts and existing write grants.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the worktree tool's creation result and the working-directory service's recorded Session context.

#### KV Cache effect

This package contributes no prompt text. Its consumers own the appended tool result and recorded directory context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Entry by pool name** — `enter` reaches only registered worktrees inside the configured pool of the checkout the Session works in. A worktree in another checkout's pool is entered from that checkout, and one outside every pool is not reachable.
- **Retained artifacts** — leaving a worktree keeps its branch and files, and archive cleanup never deletes a branch. Setup failures can also retain partial artifacts, and a failed removal can leave a partial directory for the retained branch to be restored over.
- **Local revisions unless asked** — creation fetches only the one remote branch a request asks for; it does not fetch other commits or missing partial-clone objects, initialize submodules, install dependencies, or copy uncommitted files. On Git that meets the execution requirements, missing local objects cause creation to fail.
- **Filtered representations** — checkout skips configured filters to avoid executing repository-configured programs or triggering implicit downloads. Git LFS pointers and encrypted blobs stay in their stored representation; hydration or decryption is a separate user-controlled operation.
- **Execution requirements** — the subprocess provider must offer Git and Node in the same execution world as the filesystem provider. Git must honor `GIT_NO_LAZY_FETCH`, which Git 2.45 and the 2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, and 2.44.1 maintenance releases do; older releases ignore it and proceed instead of failing, so creation can fetch missing partial-clone objects from a promisor remote. The `git --no-lazy-fetch` option would reject these releases, but it exists only in Git 2.45 and later and also rejects the patched maintenance releases. The existing sandbox must permit all checkout and shared Git metadata writes.
- **Commits inside a worktree** — the repository's Git directory lies outside a linked worktree, so under `workspace-write` a Session that works in one runs `git add` and `git commit`, and creates another worktree from it, only while a grant covers that directory. The [linked-worktree grant](../sandbox-policy-git/README.md) this service mounts registers it on macOS and Linux. On Windows it registers nothing, and processes there ignore a grant made through `additionalWritableRoots` or `registerWritableRoot`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The sandboxed Node child supplies exclusive directory creation, which the [filesystem service](../../fs/fs/src/index.ts) does not expose, and identifies whether this service created the pool. The filesystem contract permits bare providers such as [fs-local](../../fs/fs-local/src/index.ts) to ignore `sandboxPolicy` on writes; `createIfAbsent` protects a file but neither enforces permissions nor identifies who created its directory. Keeping directory allocation and ignore-file creation under the same process sandbox as Git preserves refusal of existing checkout paths and the condition for creating `.gitignore`.

</details>
