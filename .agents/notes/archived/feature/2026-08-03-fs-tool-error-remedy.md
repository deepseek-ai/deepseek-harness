# Agent Note: Stale-version errors append the recovery instruction at the model boundary

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-03-fs-tool-error-remedy.zh.md)

## Problem

Guarded `write` and `edit` failures reach the model with messages that state the condition but not the only correct recovery: `FS_STALE_VERSION` ("file changed since it was read") and `FS_NOT_OBSERVED` ("edit requires reading … first"). The model must guess that the recovery is a re-read (or a first read) followed by a retry, and the retry/permission/UI layers that route on the structured code see the same message text. The provider-owned messages are part of the storage seam's machine-oriented vocabulary ([filesystem capability seam](../architecture/2026-06-17-filesystem-capability-seam.md)), so the remedy cannot live there without leaking model-facing wording into every consumer of `FsError`.

## Decision

`dsh-tool-fs` owns a model-facing error wrapper, `remediateFsError` in `src/error.ts`, applied in `write.ts` and `edit.ts` after the sandbox denial mapping. It appends the recovery instruction to stale-version failures and passes unrelated errors through untouched. The [normalized unread-mutation diagnostic](../bug-fix/2026-09-03-normalized-unread-fs-tool-diagnostic.md) supersedes this note's original `FS_NOT_OBSERVED` text treatment.

- `FS_STALE_VERSION` (including a missing edit target, which shares the stale code) gains `— re-read the file, then retry`.

The structured `FsError` code is preserved so retry/permission/UI layers keep routing on it, and the original error chains as `cause`. Provider messages stay machine-oriented and unchanged.

In `edit.ts` the `fs/edit-intent` waterfall sits inside the same `try` as the provider mutation, so the policy plugin's `FS_NOT_OBSERVED` refusal and the provider refusal both pass through the model-facing wrapper.

## Alternatives considered

- **Append the remedy to the provider messages in `dsh-fs` / `dsh-fs-local`.** Rejected because those messages are machine-oriented seam vocabulary consumed by retry, permission, UI, and model-facing layers; model-facing wording belongs at the model boundary, where `dsh-tool-fs` already owns result formatting ([filesystem capability seam](../architecture/2026-06-17-filesystem-capability-seam.md)).
- **Add the recovery to prompt guidance instead.** Rejected because the failure arrives mid-task; a static instruction does not reliably reach the retry decision, while the error message is present exactly when the model must act.
- **Signal the remedy with a new `FsError` code.** Rejected because the two failures are the same conditions retry layers already handle; splitting the code would fork routing on identical semantics.

## Consequences

The `FS_STALE_VERSION` model-visible text includes its appended remedy. Unit tests cover its text, code preservation, cause chaining, and passthrough of unrelated values; assembled tool paths assert that the remedy reaches the model.

The [filesystem absence-observation follow-up](../bug-fix/2026-08-09-filesystem-absence-observation.md) makes the stale remedy actionable for external deletion. The failed reread still returns `FS_NOT_FOUND`, but records confirmed absence: edit then returns `FS_NOT_FOUND` without another stale remedy, while write retries as an atomic `createIfAbsent` and preserves any concurrent creator.
