# Agent Note: Apply patch file editing

Status: implemented

English | [中文](2026-09-28-apply-patch-file-editing.zh.md)

## Problem

A model editing several files or separated regions needs multiple literal-edit calls or a shell script. Shell and Python edits do not expose filesystem mutation intents, so a working directory without Git cannot reliably present those edits in the turn Review tab. A patch tool expresses related edits in one call while retaining guarded filesystem operations. #5121 asks for the capability and its effectiveness evaluation; #4556 supplies the broader motivation for efficient file editing.

## Decision

`apply_patch` accepts one Codex-style patch for add, update, delete, and move operations, including multiple files and hunks. The pure [dsh-fs-patch library](../../../../packages/fs/fs-patch/README.md) follows Codex `rust-v0.158.0` parsing, sequential matching, whitespace tolerance, and `NormalizeToLf` reconstruction; the matcher receives LF text only, so Codex `PreserveLineEndings` is not implemented.

The [filesystem service](../../../../packages/fs/fs/README.md) exposes `patchText`, `deleteFile`, and `moveFile`; local, sandboxed, and SSH providers implement them. `fs/delete-intent` requires the same present observation as `fs/edit-intent`, while move destinations use `fs/write-intent`. Version guards and sandbox enforcement remain with the provider. A move publishes its destination before deleting its source, and `sourceDeleted` distinguishes a completed move from a published destination whose source could not be removed.

The [tool executor](../../../../packages/fs/tool-fs/README.md) resolves paths and simulates expected state during whole-patch preflight, including repeated paths and moves, without writing files; a refused preflight commits nothing. Commit reobtains observation guards for each operation and stops at the first failure or cancellation without rollback. After an I/O or cancellation failure, a `stat` comparison checks whether every affected target retains its prior version; changed state or a failed comparison produces `unknown`, which requires rereading before retry. Reports retain completed, failed, unknown, and skipped operations, including a partially published move.

Commit reports return `isError: false` so completed diff metadata survives a stopped patch; their operation statuses and stopped flag expose the failure. Syntax and preflight rejection produce tool errors. Successful move summaries use `M <destination>`. Applied diff paths use canonical absolute `processPath` for client navigation, while operation records retain display paths and unresolved paths keep their patch spelling.

[Review capture](../../../../packages/deliverables/workspace-changes/README.md) uses filesystem intent listeners, not argument parsing. `tools/pre-execute` associates the execution with its turn recorder; prepended write, edit, and delete listeners first await the policy decision, then await capture before provider mutation. Moves capture both endpoints. Each turn retains its first baseline and compares actual final bytes, so repeated edits yield one net diff and reverted changes disappear. Existing size, count, time, location, and Session-lifetime limits remain.

`tool-fs.applyPatch` defaults to `false`, so every shipped composition keeps the model request it had before the tool existed; the `tool-fs` rows that enable `edit` (`dsh-base` and the Web `standard`, `ptc`, and `cordis` presets) state `applyPatch: false`, and a deployment turns the tool on by changing that one line, or by a profile patch on the `tool-fs` id where no preset owns the row. The tool consults the `fs/*` intent waterfalls like `write` and `edit`, so the mounted observation policy requires a prior read and rejects stale versions for every patch operation. The schema names its argument `input` as the Codex tool does: across 2,226 recorded DS-Bench and DeepSWE rollouts, 14% of `apply_patch` calls arrived with that key and were rejected while the argument was named `patch`. The tool registers its schema, guidance, native/PTC execution, and tool presentation through plugin effects; the agent loop is unchanged.

## Alternatives considered

**Keep using shell or Python for patches.** This leaves non-Git changes without filesystem intent capture and does not provide the requested model-facing editing tool.

**Reuse Codex markers with an independently strict matcher.** This reduces initial implementation work but makes familiar patches fail differently. A pinned Codex parser and matcher make deviations reviewable; Harness policies stay explicit.

**Make the whole patch transactional.** Cross-file rollback adds recovery state and can overwrite concurrent external edits. Preflight and ordered commits reject known failures early and expose partial results without promising rollback.

**Expand Review while adding the tool.** Rename presentation, persistent storage, SSH capture, and capture-failure policy are independent product decisions; existing whole-file capture and rendering cover this integration.

**Register the tool by default wherever `write` and `edit` are both enabled.** This would add a schema and a guidance section to every default model request and change every recorded request expectation before the tool's effect on ordinary sessions is measured; the explicit switch keeps the baseline composition unchanged and lets comparison runs opt in.

## Consequences

One call can express related edits. Default model requests are unchanged; a composition that enables the switch includes another tool schema and its guidance, so its recorded request expectations differ from the baseline. Preflight cannot prevent a later conflict, cancellation, or storage failure; callers inspect operation statuses before retrying. Permissive upstream matching remains pinned and tested rather than tightened. Provider implementations and external subclasses must support three additional operations, and partial moves require handling both endpoints.

## Testing

Parser and matcher fixtures cover the pinned syntax, whitespace, repeated contexts, and EOF behavior. Provider and executor tests cover observation, version and sandbox refusals, repeated paths, partial moves, cancellation, and uncertain outcomes. The real-tool Review matrix runs with no repository and with Git unavailable, checking all operation kinds, first-to-last baselines, rejected edits, partial publication, reverted changes, capture ordering, malformed syntax, and path aliases. Real model Session recordings cover successful updates, read-policy rejection and retry, and partial execution; deterministic cancellation stays in executor tests.

## Deferred

A controlled editing-task evaluation comparing final-file correctness, task success, tokens, tool calls, retries, latency, and Review coverage against `edit` on identical initial states. SSH Review, closing-prose file references for `apply_patch`, and Codex `PreserveLineEndings`.
