---
description: "Bind change requests to the Session that created, pushed, or tracked them, and watch their status."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge-session

English | [中文](README.zh.md)

## Summary

List the pull requests a Session is working on without a separate registry. A projection derives bindings from the Session's own `gh pr create`, `gh pr view`, `gh pr edit`, `gh pr checkout`, and `git push` shell results and from binding records. After each push, and when a caller such as the forge panel reports the branch a Session works on, the service looks up open change requests for that branch and records the unbound ones. Watching a Session polls its bound change requests through `ctx.forge`. The Session summary carries the bindings to clients.

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

Mount the service with the forge registry, a provider, and the Session projection registry.

```yaml
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-experimental-forge-github'
- name: '@deepseek-ai/dsh-experimental-forge-session'
```

`ctx.forgeSession.changeRequests(session)` returns the visible bindings in first-recorded order. Each entry carries the URL, its `origin` (`created`, `referenced`, `discovered`, or `tracked`), the provider reference or `null` when no provider serves the URL, and the latest polling result or `null`. `watch(session, listener)` is an effect on the calling fiber: while a Session has a watcher, every visible binding that a provider serves is polled, and listeners receive the complete list after each later binding change, provider registration change, or polling result. Provider changes resynchronize existing watches, including URLs that were previously unserved. `track(session, url)` binds a URL under the provider's canonical form, or restores a dismissed binding, and throws when no provider recognizes the URL. `dismiss(session, url)` hides a visible binding; other URLs leave the log unchanged. `discoverBranch(session, remote, branch)` runs the lookup that follows a push for a branch on the remote at `remote` and resolves once it has recorded its bindings or failed; a remote that no provider serves changes nothing.

A `bash` or `pwsh` call binds evidence only from its first result, and only when the tool execution itself succeeded; the command's exit status does not matter. A command containing `gh pr create` or `gh pr new` binds every `/pull/<number>` URL in its text output. A command containing `gh pr view`, `gh pr edit`, or `gh pr checkout` binds, as `referenced`, a `/pull/<number>` URL selected by the command, or a numeric selector with an explicit repository and host, plus the URL its output prints for its own change request: gh's `url:` field or a URL alone on a line before the `--` line that starts a description, and JSON `url` members. Links in a description or in other fields do not bind, and a command that also contains `gh pr create` binds its URLs as `created`. A command containing `git push`, optionally with leading `-C`, `-c`, or long Git options, records each branch listed under a `To <remote>` line as created, updated, forced, or already up to date; rejected and deleted refs, new tags, and explicit refs outside `refs/heads/` are skipped. For each pushed branch whose remote a provider serves, the service runs `ctx.forge.findByHead` within `discoveryTimeoutMs` and appends a `discover` record for every returned change request that is not bound. Dismissed bindings remain bound and are skipped; only `track` restores them. Every push repeats the lookup; failures are logged as warnings. Closing a Session cancels its unfinished branch lookups without adding bindings. Reopening it does not repeat those lookups; another push, `discoverBranch`, or `track` can bind the change request. URLs that differ only in scheme, letter case, query, fragment, or trailing slashes name the same binding.

Numeric `gh pr view`, `edit`, and `checkout` selectors accept `--repo OWNER/REPO`, `--repo=OWNER/REPO`, and `-R OWNER/REPO` in either argument order. A repository containing its host, or a literal `GH_HOST` assignment, supplies a URL directly. For a single command, optionally piped through `head`, `tail`, or `cat`, a completed foreground Bash call without a host runs a read-only `gh pr view <number> --repo <repository> --json url` through the same shell service, cwd, literal environment assignments, managed environment, and standing sandbox policy. The CLI resolves its configured host. A successful lookup appends a `reference` binding record; failures leave bindings unchanged and log a warning. This live observer requires `tools`, `shell`, and `shellEnv`; projection-only compositions still recover recorded URLs. Queries share `discoveryTimeoutMs`, stop on caller cancellation, and are aborted and awaited on service disposal.

Binding actions are `plugin:forge-session/binding` records listed in the [experimental persistence catalog](../../../docs/experimental-persistence-catalog.md); fork and resume carry them with the shell events, so a fork starts with its parent's bindings. `discoveryTimeoutMs` is listed in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-forge-session).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `forgeChangeRequests` projection keeps shell calls awaiting their first result, every binding with its dismissal state, and each pushed branch with the sequence number of the latest result that reported it. Pending calls are dropped at `turn/end`. Its client view, which the Session summary carries, is every binding with its URL, origin, and dismissal state in first-recorded order, and it keeps its reference while only pending calls or pushes change. The service reacts to a `tool/result` event by discovering exactly the pushes whose sequence number equals the event's, and refreshes watchers when the bindings array changes. Disposing the service aborts lookups and drops their results.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Discovery, track and dismiss records, and Session watches |
| [`src/projection.ts`](src/projection.ts) | Fold of shell calls, results, and binding records |
| [`src/commands.ts`](src/commands.ts) | Command classification and output parsing |
| [`src/types.ts`](src/types.ts) | Binding record, projection state, and entry types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Forge subsystem](../../../docs/subsystems/forge.md) — change request types and service reference.
- [Forge registry](../forge/README.md) — providers and shared polling.
- [Session projections](../../session/session-projection/README.md) — projection registration and checkpoints.
- [Binding decision](../../../.agents/notes/implemented/feature/2026-10-09-session-change-request-bindings.md) — why bindings derive from shell results and status stays on the host.

-----

<a id="model-experience"></a>
## Model Experience

None, as bindings, discovery records, and polled status never enter model requests; clients see the bindings through the Session summary.

#### KV Cache effect

None. Binding records are ignorable plugin records outside the model-visible conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Limited shell recognition** — Numeric selectors require a literal repository. Expansion, substitutions, multiline scripts, unknown options, aliases, and other CLIs are excluded. Unqualified repositories in compound commands or PowerShell require an output URL or `track`; the live resolver cannot recover their original environment. Replay restores confirmed reference records and explicit-host selectors without running `gh`; old unqualified calls without a recorded URL need another invocation or `track`. Branch selectors and `git push --porcelain` remain unsupported.
- **Discovery timing** — a change request opened elsewhere for a branch appears after the next push of that branch, after a caller such as the forge panel reports the branch again, or after a `track`.
- **No model tool** — the model cannot read or change bindings yet.
- **Background output** — `run_in_background: true` returns a job id without binding evidence. A foreground command moved to the background contributes only the output in its first result; later job output does not add bindings. Use `track` for change requests missing from that result.
- **Unqualified tag updates** — a forced or up-to-date tag printed without `refs/tags/` is treated as a branch. Discovery may bind an open change request for a branch with the same name; use `dismiss` to hide an incorrect binding.
- **Per-Session bindings** — subagent Sessions keep their own bindings; a parent Session does not aggregate them.
- **Silent lookup failures** — lookup failures reach the host log only; neither the Session nor its watchers see them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
