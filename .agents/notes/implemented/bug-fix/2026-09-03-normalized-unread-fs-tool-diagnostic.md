# Agent Note: Normalized unread filesystem tool diagnostic

Status: implemented

English | [中文](2026-09-03-normalized-unread-fs-tool-diagnostic.zh.md)

## Problem

The `dsh-tool-fs` write and edit operations can receive `FS_NOT_OBSERVED` from either the observation policy or a filesystem provider. Those sources describe the same requirement with operation-specific messages, so identical recovery conditions reach the model with different wording. Provider text can also expose whether the rejected operation would overwrite an existing target, although the model only needs to read the target and retry.

## Decision

`remediateFsError(error, displayPath)` replaces every `FS_NOT_OBSERVED` message at the `dsh-tool-fs` model boundary with `cannot modify "<path>": file has not been read — read the file, then retry`. The wrapper preserves the structured error code and chains the source error as `cause`, so machine routing and diagnostics can still inspect the original failure.

`FS_STALE_VERSION` retains the appended re-read remedy owned by the [guarded-mutation remedy note](../../archived/feature/2026-08-03-fs-tool-error-remedy.md). Filesystem providers and policies keep their operation-specific messages because other consumers do not share the tool's model-facing presentation.

## Alternatives considered

**Append the same recovery suffix to each source message.** Rejected because the model would still receive different reasons for one required action, including provider-specific target-existence detail that does not change recovery.

**Normalize the provider and policy messages at their source.** Rejected because those components own machine-oriented errors used by consumers other than `dsh-tool-fs`; only the tool owns this model-visible wording.

**Introduce another error code for the normalized result.** Rejected because the underlying condition and recovery routing remain `FS_NOT_OBSERVED`; changing the code would discard useful compatibility for machine consumers.

## Consequences

Write and edit expose one stable unread-target diagnostic regardless of whether policy or provider rejects the mutation. The model gives up source-specific wording and the provider's target-existence hint in exchange for one actionable recovery instruction. The original message remains available through `cause`.

Unit and integration tests pin both source paths, code preservation, cause chaining, and the exact model-visible text. The `fs-policy-reject` recorded session carries the same diagnostic for replay.
