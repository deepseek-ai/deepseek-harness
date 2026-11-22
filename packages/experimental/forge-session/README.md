---
description: "Bind change requests to the Session that created, pushed, or tracked them, and watch their status."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge-session

English | [中文](README.zh.md)

## Summary

List the change requests a Session is working on without a separate registry. A projection derives bindings from binding records and from the Session's shell results, including those inside PTC programs, for `git push` and the commands forge providers register, such as `gh pr create`. After each push, and when a caller such as the forge panel reports the branch a Session works on, the service looks up open change requests for that branch and records the unbound ones. Watching a Session polls its bound change requests through `ctx.forge`. The Session summary carries the bindings to clients.

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

A provider registers the commands of its CLI with `ctx.forgeSession.registerCommands(rule)`, an effect on the calling fiber that returns its disposer; while forge-session runs, [forge-github](../forge-github/README.md) registers `gh` and [forge-gitlab](../forge-gitlab/README.md) registers `glab`. A rule names its executable, its creation subcommands, its reference subcommands and its raw API request subcommands, each group with the options it accepts, a regular expression for the change request page path, the JSON members that hold a reference command's own URL, and a `select` function that maps one parsed reference or API request command to a URL or to a read-only lookup command. Registration throws for a malformed rule and for a rule whose id or executable a live registration has. A rule classifies the same input the same way every time, and its registrant raises `version` whenever the rule classifies any command or output differently.

`ctx.forgeSession.changeRequests(session)` returns the visible bindings in first-recorded order. Each entry carries the URL, its `origin` (`created`, `referenced`, `discovered`, or `tracked`), the provider reference or `null` when no provider serves the URL, and the latest polling result or `null`. `watch(session, listener, options)` is an effect on the calling fiber: while a Session has a watcher, every visible binding that a provider serves is polled for its snapshot, with the `options` of the Session's first watcher passed to `ctx.forge.watch`, and listeners receive the complete list after each later binding change, provider registration change, or polling result. Provider changes resynchronize existing watches, including URLs that were previously unserved. `track(session, url)` binds a URL under the provider's canonical form, or restores a dismissed binding, and throws when no provider recognizes the URL. `dismiss(session, url)` hides a visible binding; other URLs leave the log unchanged. `discoverBranch(session, remote, branch)` runs the lookup that follows a push for a branch on the remote at `remote` and resolves once it has recorded its bindings or failed; a remote that no provider serves changes nothing.

A `bash` or `pwsh` call binds evidence only from its first result, and only when the tool execution itself succeeded; the command's exit status does not matter. A `bash` or `pwsh` call inside a PTC program binds the same evidence from its `tool/ptc-dispatch` event, which logs the call's arguments with its settled outcome. A command containing a rule's creation subcommand, such as `gh pr create`, binds every change request page URL of that rule in its text output. A command containing a reference subcommand, such as `gh pr view`, binds, as `referenced`, the change request that the rule's `select` finds in a literal simple command, plus the URL its output prints for its own change request: a `url:` field or a URL alone on a line before the `--` line that starts a description, and the rule's JSON URL members. Links in a description or in other fields do not bind, and a command that also contains a creation subcommand binds its URLs as `created`. An API request subcommand, such as `glab api`, binds as `referenced` only the change request its request path names; its output is not read, since one request can list many change requests. A command containing `git push`, optionally with leading `-C`, `-c`, or long Git options, records each branch listed under a `To <remote>` line as created, updated, forced, or already up to date; rejected and deleted refs, new tags, and explicit refs outside `refs/heads/` are skipped. For each pushed branch whose remote a provider serves, the service runs `ctx.forge.findByHead` within `discoveryTimeoutMs` and appends a `discover` record for every returned change request that is not bound. Dismissed bindings remain bound and are skipped; only `track` restores them. Every push repeats the lookup; failures are logged as warnings. Closing a Session cancels its unfinished branch lookups without adding bindings. Reopening it does not repeat those lookups; another push, `discoverBranch`, or `track` can bind the change request. URLs that differ only in scheme, letter case, query, fragment, or trailing slashes name the same binding.

A command's options parse by the declarations of the group whose subcommand it runs: a value option takes the next word, the text after `=`, or for a one-letter option the rest of the word, and an undeclared option makes the command name nothing. When `select` returns a lookup for a single command, optionally piped through `head`, `tail`, or `cat`, a completed foreground Bash call runs that read-only command, prefixed with `env` and the command's literal environment assignments, through the same shell service, cwd, managed environment, and standing sandbox policy; the CLI resolves its configured host. A lookup whose complete output is one page URL of the rule appends a `reference` binding record; other output and failures leave bindings unchanged and log a warning. A Bash call inside a PTC program runs its lookup after the enclosing root call settles, so the lookup follows that root call's cancellation. This live observer requires `tools`, `shell`, and `shellEnv`; projection-only compositions still recover recorded URLs. Queries share `discoveryTimeoutMs`, stop on caller cancellation, and are aborted and awaited on service disposal.

Binding actions are `plugin:forge-session/binding` records listed in the [experimental persistence catalog](../../../docs/experimental-persistence-catalog.md); fork and resume carry them with the shell events, so a fork starts with its parent's bindings. `discoveryTimeoutMs` is listed in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-forge-session).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `forgeChangeRequests` projection keeps shell calls awaiting their first result, every binding with its dismissal state, and each pushed branch with the sequence number of the latest result that reported it. Pending calls are dropped at `turn/end`. Its client view, which the Session summary carries, is every binding with its URL, origin, and dismissal state in first-recorded order, and it keeps its reference while only pending calls or pushes change. The service reacts to a `tool/result` or `tool/ptc-dispatch` event by discovering exactly the pushes whose sequence number equals the event's, and refreshes watchers when the bindings array changes. For each such push it also calls `ctx.forge.expectChange` for the visible change requests in the pushed remote's repository, so a watched one is polled at once and at the active interval until its checks start. At `turn/end` of a turn that had a tool result, it calls `ctx.forge.refresh` for every visible change request with the age of the turn's last tool result as `maxAgeMs`, so a watched change request that a command of the turn may have merged, closed, or updated is polled unless a poll of it started after that result; a turn without a tool result polls nothing. Disposing the service aborts lookups and drops their results.

The projection's state version is `5 × 2^32` plus a 32-bit hash of the recognized rules' `id@version` pairs, so a checkpoint folded with other rules is discarded and the log folds again. A registration that changes the recognized rules releases the projection and registers it at the new version once the registrations of the same microtask have run, one re-registration at a time; each Session refolds its log with the new rules when next read, including commands that ran before the provider loaded, and watchers whose bindings changed are notified. Ending a registration leaves its rule recognized until the service restarts or another registration replaces its id or executable, so unloading providers, including at shutdown, leaves the checkpointed version unchanged; only live registrations run reference lookups. Each start registers the projection without rules, since providers register theirs once forge-session has started, and their registrations then re-register it once. A failed re-registration registers the projection again with the earlier rules and logs a warning; when that fails too, it logs an error, and clients see no bindings until the service restarts.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Discovery, track and dismiss records, and Session watches |
| [`src/projection.ts`](src/projection.ts) | Fold of shell calls, results, program dispatches, and binding records |
| [`src/commands.ts`](src/commands.ts) | Rule validation and compilation, command classification, and output parsing |
| [`src/references.ts`](src/references.ts) | Literal simple commands of a shell command line |
| [`src/reference-lookup.ts`](src/reference-lookup.ts) | Live lookups of change requests named without a host |
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

- **Limited shell recognition** — Only CLIs with a registered rule bind. Numeric selectors require a literal repository. Expansion, substitutions, multiline scripts, undeclared options, and aliases are excluded. Unqualified repositories in compound commands or PowerShell require an output URL or `track`; the live resolver cannot recover their original environment. Replay restores confirmed reference records and selectors that name their host without running a lookup; old unqualified calls without a recorded URL need another invocation or `track`. Branch selectors and `git push --porcelain` remain unsupported.
- **Rule changes refold every Session** — a provider that adds a rule or raises its version invalidates every checkpointed `forgeChangeRequests` row: each Session refolds its whole log when next read, and until then the Session list shows no cached bindings for it. A Session read during startup, before the providers register, folds without their commands, and a checkpoint written then folds again at the next start. Starting without a provider removes the bindings that only its commands made, such as those of `gh pr create` without forge-github; binding records stay. Re-registration emits no projection change, so an open Session's summary shows the refolded bindings once a later event changes its projection state; watchers and `changeRequests` see them at once.
- **Discovery timing** — a change request opened elsewhere for a branch appears after the next push of that branch, after a caller such as the forge panel reports the branch again, or after a `track`.
- **No model tool** — the model cannot read or change bindings yet.
- **Background output** — `run_in_background: true` returns a job id without binding evidence. A foreground command moved to the background contributes only the output in its first result; later job output does not add bindings. Use `track` for change requests missing from that result.
- **Unqualified tag updates** — a forced or up-to-date tag printed without `refs/tags/` is treated as a branch. Discovery may bind an open change request for a branch with the same name; use `dismiss` to hide an incorrect binding.
- **Shortened program output** — a shell call inside a PTC program binds from the logged copy of its output, which the spill policy can shorten. A URL only in the omitted part does not bind, and the live lookup, which reads the complete output, skips a call whose output prints its own URL; use `track`.
- **Per-Session bindings** — subagent Sessions keep their own bindings; a parent Session does not aggregate them.
- **Silent lookup failures** — lookup failures reach the host log only; neither the Session nor its watchers see them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
