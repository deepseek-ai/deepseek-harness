# Agent Note: Session change request bindings

Status: implemented

English | [中文](2026-10-09-session-change-request-bindings.zh.md)

## Problem

A Session that opens or updates pull requests leaves them only in its shell output. Neither the user nor later consumers have a list of the change requests the Session works on or a shared view of their status. Code hosts differ in URLs, command-line tools, and status models, and any association must survive fork and resume without changing what the model sees.

## Decision

The experimental forge capability seam has three roles. [`dsh-experimental-forge`](../../../../packages/experimental/forge/README.md) defines provider-neutral repository and change request references, a provider registry, and shared polling: watchers of one change request share one loop, each forge has one batched fetch in flight, and the cadence follows check, mergeability, and lifecycle state. [`dsh-experimental-forge-github`](../../../../packages/experimental/forge-github/README.md) is the first provider; it reads GitHub through the GitHub CLI on the host, so credentials stay in that tool's own store and never enter Session execution worlds. [`dsh-experimental-forge-session`](../../../../packages/experimental/forge-session/README.md) binds change requests to Sessions.

Bindings derive from the Session log instead of a separate store. A Session projection reads `bash` and `pwsh` calls: `gh pr create` results bind the URLs they print, `gh pr view`, `gh pr edit`, and `gh pr checkout` calls bind the change request they act on, and `git push` results record the branches they updated. Those three commands act on one change request, so only the URL given as their first argument and the URL their output prints for that change request count; links in a description name other change requests. Caller actions and discovery results are `plugin:forge-session/binding` records. Because every input is a log event, fork and resume carry bindings without new persistence, and the projection rebuilds them from any checkpoint. The printed URL or ref line is the evidence, not the exit status: an existing pull request reported by a failing `gh pr create` still binds, and a partially rejected push still records the branches it updated.

After each push result, and when a caller such as the forge panel reports the branch a Session's checkout tracks, the service looks up open change requests for that branch through the provider and records the unbound ones. A dismissed binding stays hidden from discovery and returns only through `track`. Polled status is not logged; it is process-local state that exists while a watcher displays the Session. The projection's client view therefore carries bindings without status.

## Alternatives considered

**A host-side binding database.** A separate store would need its own fork, resume, and deletion rules; plugin records and projections already provide them.

**A model tool that registers each change request.** The association would depend on the model calling an extra tool, and every request would carry its schema. Parsing the commands the model already runs costs no tokens.

**Logging polled status in the Session.** Status changes independently of the conversation. Logging it would grow the log with every poll and expose stale snapshots to later readers.

**Running `gh` through the Session's subprocess provider.** Remote and sandboxed execution worlds would need GitHub credentials, and status would depend on the world a Session uses. The host CLI keeps one credential owner.

## Consequences

Bindings appear without model cooperation for the common `gh pr create`, `gh pr view`, `gh pr edit`, `gh pr checkout`, and `git push` flows and add no model tokens. Commands run through scripts, aliases, or other command-line tools are not recognized, and a change request opened elsewhere for a branch appears only after another push, another report of that branch, or a `track`. Another provider adds its own access and URL forms behind the same provider contract without changing the binding rules or the polling. The host needs `gh` signed in for each GitHub host.
