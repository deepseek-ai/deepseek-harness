# Agent Note: Filesystem absence is an observation and guarded creation never replaces

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-filesystem-absence-observation.zh.md)

## Problem

The event-gated filesystem policy originally records only successful reads and mutations as a target version. If a session reads a file and an external command deletes it, the first guarded mutation correctly fails stale, but the prescribed reread returns `FS_NOT_FOUND` before emitting `fs/observed`. The old positive version therefore remains forever: write keeps choosing `replaceIfVersion`, the provider keeps rejecting the missing target, and the model-facing “re-read the file, then retry” instruction becomes an unrecoverable loop.

Treating a failed read as permission to create also exposes a second boundary. Both local and E2B providers probe before staging, then historically publish with rename; another process can create the target between those steps and be overwritten even though the caller supplied `createIfAbsent`. An in-process target lock does not protect that cross-process publication race.

## Decision

`dsh-fs` owns an explicit observation union: `{ kind: 'present', version: FsVersion } | { kind: 'absent' }`. The `fs/observed` event carries that union. Successful reads and mutations emit present; a metadata miss from `read` or the `str_replace_editor` `view`, `str_replace`, or `insert` command emits absent synchronously before returning `FS_NOT_FOUND`. Other read failures do not manufacture absence.

`dsh-fs-observation-policy` stores three logical states per owner and target without injecting or calling `ctx.fs`: missing map entry is unseen, `absent` is confirmed absence, and `present(version)` is a replacement/edit basis. Write maps unseen and absent to the existing `createIfAbsent` intent and present to `replaceIfVersion`. Edit maps unseen to `FS_NOT_OBSERVED`, absent to `FS_NOT_FOUND`, and present to its version guard. A successful create or mutation replaces absence with its produced present version.

Every provider must enforce `createIfAbsent` at the publication point, not only at its initial probe. `dsh-fs-local` stages and fsyncs in a private sibling directory, then hard-links the staged file to the destination; after a failed link it inspects the destination entry so a regular-file collision returns `FS_NOT_OBSERVED`, a non-regular entry returns `FS_NOT_REGULAR_FILE`, and a failure against a still-missing target returns `FS_IO_ERROR`. `dsh-fs-e2b` uses remote `ln -T` with an explicit created/existing result and derives the committed target version from metadata obtained before the non-cancellable commit. Replacements and bare unconditional writes retain their existing publication paths.

This decision does not claim cross-process linearizability for `replaceIfVersion`: the provider version check and replacement remain protected only against writers represented by the provider's own lock and detectable metadata. The narrower guarantee is exact and sufficient for absence recovery: guarded creation never clobbers a target that appears before publication. Local guarded creation requires hard-link support; once any local publication succeeds, staging cleanup is best effort because private residue cannot make the committed write false.

## Alternatives considered

- **Delete the cached version when a read returns not found.** Rejected because it conflates unseen with confirmed absence, cannot give edit the correct `FS_NOT_FOUND` result, and erases the state transition the event is meant to communicate.
- **Have `dsh-fs-observation-policy` call `stat` before choosing an intent.** Rejected because it makes the event-only policy depend on a provider, adds I/O to every decision, and still leaves a TOCTOU gap before publication.
- **Let `replaceIfVersion` create when its target disappeared.** Rejected because a positive observation is evidence for replacement, not creation; silently changing that provider intent would bypass the required missing reread and weaken stale protection.
- **Keep the deleted-target dead end fail-closed.** Rejected because the model-facing recovery instruction is then false and a normal external cleanup cannot be recovered within the session.

## Consequences

The first mutation after an unobserved external deletion still fails `FS_STALE_VERSION`; the user or model must follow the existing reread remedy. That missing reread returns `FS_NOT_FOUND` while changing policy state, after which edit remains forbidden and write may recreate the path. If another writer wins the create race, the retry returns `FS_NOT_OBSERVED` and leaves the winner intact; a competing directory, special entry, or dangling symbolic link instead returns `FS_NOT_REGULAR_FILE` without prescribing another read.

The observation payload is a package-owned event contract change, so every producer, listener, invariant, generated Cordis catalog, subsystem document, and both filesystem tool families move together. The policy keeps its one-stat read and zero-stat write/edit budget, owner isolation, disposal behavior, and optional deployment boundary from the [event-gate decision](../architecture/2026-06-26-file-context-as-event-gate.md).

The assembled filesystem snapshot pins the model-visible recovery chain, while provider tests inject a creator after staging to prove no-clobber publication. The [guarded-mutation remedy decision](../feature/2026-08-03-fs-tool-error-remedy.md) remains the owner of model-facing recovery wording; this note makes its deletion path actionable.
