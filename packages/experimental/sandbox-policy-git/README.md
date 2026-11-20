---
description: "Grant a Session that works in a linked Git worktree write access to the Git directory the worktree shares with its repository, for maintainers composing worktree Sessions under workspace-write."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-policy-git

English | [中文](README.zh.md)

## Summary

Let Git commands that write repository data, such as `git add` and `git commit`, run under `workspace-write` in a Session that works in a linked Git worktree. The plugin registers the Git directory the worktree shares with its repository as an additional writable directory of that Session, and removes the registration when the Session works elsewhere. The [worktree service](../worktree/README.md) mounts it.

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

A composition that mounts the worktree service already has this plugin. Another composition mounts it beside `fs`, `sandboxPolicy`, and `workingDirectory` providers; it has no configuration.

```yaml
- name: '@deepseek-ai/dsh-sandbox-policy-git'
```

### What a Session may write

A linked worktree keeps its index, its `HEAD`, and the repository's objects and refs in the repository's Git directory, usually `<repository>/.git`, which lies outside the worktree. The [sandbox policy](../../sandbox/sandbox-policy/README.md) bounds a Session by the directory it works in, so without a grant those writes are denied. While a Session's directory is the top-level directory of a linked worktree, the plugin registers that Git directory through `ctx.sandboxPolicy.registerWritableRoot`. The registration follows that method's rules: it applies under `workspace-write`, to that Session only, to operations that resolve their policy afterwards, and it is not stored with the Session.

The grant covers the whole Git directory, including `hooks`, `config`, and the administration directories of the repository's other worktrees. A Git command the user later runs outside the sandbox executes hooks and configured programs found there, as it does for a Session that works in the main checkout, whose root contains the same directory.

### When the layout is read

The plugin reads the layout of the Session's directory at three points, each of which the caller awaits:

- when an Agent is created, which includes resume, clear, and compaction, before the Agent accepts input;
- after every Host move of the Session's directory, before `ctx.workingDirectory.set` returns;
- at the directory validation before each model request.

Each read replaces the Session's registration with its result, so a Git directory that disappeared or no longer names the worktree stops being granted at the next read. A read takes the caller's cancellation; a cancelled read changes nothing.

A grant belongs to the directory it was read for. It ends in the step that commits a Host move to another directory, before the entered directory is read, so no policy combines the entered directory with the Git directory of the one left. Disposing the Agent or unloading the plugin removes the registration; a read still in flight then registers nothing, and the unload waits for it.

### Which directories qualify

The files in a Session's directory are writable by the Session, so its `.git` file alone grants nothing. A directory qualifies only when the Git directory itself names it as a worktree, in the layout `git worktree add` writes:

1. `<directory>/.git` is a regular file with a `gitdir:` line that resolves to an existing `<common>/worktrees/<name>`.
2. `<common>/worktrees/<name>/commondir` resolves to `<common>`.
3. `<common>/worktrees/<name>/gitdir` resolves to `<directory>/.git`.
4. `<common>` neither contains the directory nor lies inside it.
5. `<common>` holds a `HEAD` file, an `objects` directory, and a `refs` directory.
6. `<common>/worktrees/<name>` lies in no directory the deployment or another plugin already lets the Session write. Pointer files the Session can write prove nothing about the directory above them, so the plugin neither grants `<X>` through a writable `<X>/worktrees/<name>` nor widens a configured grant of one administration directory to the whole Git directory. Once the plugin granted a Git directory, later reads accept that same directory.

Absolute and relative pointers, a worktree of a bare repository, and a worktree nested inside another worktree qualify. The main checkout needs no grant. A subdirectory of a worktree and a submodule checkout do not qualify.

### Failures

A layout that cannot be read grants nothing, and neither does a pointer file larger than 8192 bytes. The plugin logs one warning per Session and directory, and the directory operation or Agent creation that triggered the read succeeds; the next read tries again.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin listens to `agent/created`, to `agent/disposed`, and to the `working-directory/access` waterfall, where it reads after `next()` returned the committed directory. A prepended `session/event` listener ends a grant when a `workspace-root/change` names another directory, which is the step that commits the move; a Session that publishes no events loses it when the read of the entered directory starts. The plugin keeps one registration per Session with the directory it was read for. A read whose directory the Session left before the read finished is discarded, because the move that followed has its own read, and so is one whose Agent was disposed meanwhile. The plugin's context owns every registration, so unloading the plugin removes them all.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Listeners and the registration of each Session |
| [`src/linked-worktree.ts`](src/linked-worktree.ts) | Layout validation through the execution-world filesystem |

No runtime invariant companion is published: the sandbox policy owns the registrations and the working-directory service owns the Session's directory; this package stores neither.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Sandbox policy](../../sandbox/sandbox-policy/README.md) — registration rules and the model-visible policy text.
- [Working directory](../../session/working-directory/README.md) — Host moves and the `working-directory/access` waterfall.
- [Worktree service](../worktree/README.md) — the operations that move a Session into and out of a worktree.
- [Grant decision](../../../.agents/notes/implemented/architecture/2026-11-18-linked-worktree-git-directory-grant.md) — why the whole Git directory is granted and why these checks.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the sandbox policy's `sandbox:policy` context, which lists the registered Git directory under `Additional writable directories` while the Session's mode is `workspace-write`.

#### KV Cache effect

This package contributes no prompt text. The sandbox policy's context changes when a registration is added or removed, which coincides with the changed working-directory context of a Host move; the stable system prompt is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Windows** — the plugin registers nothing on Windows, where process confinement ignores additional writable directories. Git commands that write the repository from a worktree Session need an approved escalation or `danger-full-access` there.
- **Top-level directory only** — a Session whose directory is a subdirectory of a worktree, or a submodule checkout, receives no grant.
- **No narrower grant** — the registration interface accepts directories, so `hooks` and `config` cannot be excluded from the grant.
- **Between reads** — a Git directory that is removed stays registered until the next read, and the Session's confined operations fail with `SANDBOX_INVALID_ROOT` until then. An operation that resolved its policy before a move committed keeps the permissions it resolved, and one that resolves it between the commit and the end of the read of the entered directory holds no grant.
- **Earlier permissions** — the checks compare the pointer files with what the Session can write now. Pointer files and Git directory entries planted while a Session could write more, under `danger-full-access` or from the main checkout before it entered a worktree, pass them; the grant then reaches a directory that party could already write at the time. Platform temporary directories are not compared either.
- **Regular entries** — a Git directory whose `HEAD`, `objects`, or `refs` is a symbolic link does not qualify.
- **Sessions without an Agent** — only Sessions of live Agents receive a grant.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
