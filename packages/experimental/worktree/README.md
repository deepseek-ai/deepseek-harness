---
description: "Create and enter a retained Git worktree under the calling Session file policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-worktree

English | [中文](README.zh.md)

## Summary

Create an isolated checkout from a local commit and continue the same Session in it. Each operation creates a new named branch and leaves the source checkout intact. The existing sandbox governs all writes. Leaving the checkout retains its files and branch.

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

Mount the service alongside `workingDirectory`, `fs`, `subprocess`, `sandbox`, and `sandboxPolicy` providers. Add the tool package when models need the operation.

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

`ctx.worktrees.create(agent, { name?, from? }, signal?)` creates a new branch and checkout, then enters the canonical checkout directory through `ctx.workingDirectory.set`. `from` resolves to a local commit before creation and defaults to `HEAD`; staged, unstaged, untracked, and ignored source files are not copied. `baseCommit` reports the resolved commit object name; repository-local replacement refs still apply to the checked-out content. Checkout disables configured Git clean, smudge, and process filters without changing repository configuration. An existing branch or checkout path is an error. The returned record contains `path`, `branch`, `baseCommit`, and `repositoryRoot`.

The default checkout directory is `<current checkout root>/.agents/worktrees/<name>`. The returned `repositoryRoot` is the top-level directory of the caller’s current checkout; when it is a linked checkout, the pool is nested inside it. Omitted names use `worktree-` plus a UUID. The service writes a `.gitignore` containing `*` and a trailing newline only when its allocation creates the pool; existing files and ignore rules are preserved. Relative `directory`, generated `namePrefix`, executable choices, and process limits are configurable in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-worktree).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Git and directory allocation run through the mounted subprocess and sandbox providers with the calling Session's existing file policy. Creation does not widen write access to the destination or shared Git administration directory. Directory creation claims the destination exclusively; cancellation and failed setup can leave retained artifacts, whose path appears in the error. Service disposal aborts pending operations and waits for their settlement.

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

- **Retained artifacts** — leaving a worktree keeps its branch and files. Setup failures can also retain partial artifacts; removal, pruning, and branch deletion belong to the user or another consumer.
- **Local revisions only** — creation does not fetch commits or missing partial-clone objects, initialize submodules, install dependencies, or copy uncommitted files. Missing local objects cause creation to fail.
- **Filtered representations** — checkout skips configured filters to avoid executing repository-configured programs or triggering implicit downloads. Git LFS pointers and encrypted blobs stay in their stored representation; hydration or decryption is a separate user-controlled operation.
- **Execution requirements** — the subprocess provider must offer Git 2.45 or newer and Node in the same execution world as the filesystem provider. Git must support `--no-lazy-fetch`; unsupported executables fail before directory allocation. The existing sandbox must permit all checkout and shared Git metadata writes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The sandboxed Node child supplies exclusive directory creation, which the [filesystem service](../../fs/fs/src/index.ts) does not expose, and identifies whether this service created the pool. The filesystem contract permits bare providers such as [fs-local](../../fs/fs-local/src/index.ts) to ignore `sandboxPolicy` on writes; `createIfAbsent` protects a file but neither enforces permissions nor identifies who created its directory. Keeping directory allocation and ignore-file creation under the same process sandbox as Git preserves refusal of existing checkout paths and the condition for creating `.gitignore`.

</details>
