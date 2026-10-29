---
description: "The model-facing read, read_image, write, and edit tools for users and maintainers composing or debugging filesystem access for agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-fs

English | [中文](README.zh.md)

## Summary

Use `dsh-tool-fs` to let a model read UTF-8 files with line numbers, read supported images, create or atomically replace files, apply targeted literal edits, and apply Codex-style multi-file patches. Results are capped, and failures provide stable error codes and recovery instructions. Add `dsh-fs-observation-policy` when writes and edits must follow a successful read; without it, mutations remain atomic but are unconditional. Image reads require durable attachment storage and an image-capable routed model. Choose the sibling discovery package for glob or grep searches.

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

Relative paths use the Session's current working directory. A directory change affects subsequent reads and mutations without changing sandbox permission roots. Successful results return the canonical absolute path from `fs.processPath`, and root result metadata retains that operation-time path for replay and navigation.

Mount the tools after a `ctx.fs` backend and, for read-before-write/edit behavior, the policy plugin. The model then gets line-numbered reads, atomic writes and edits, and — with an attachment store mounted — image reads; every result is capped, and failures carry stable codes with recovery instructions.

### Minimal composition

A backend, the policy plugin, then the tools; the attachment store is optional and enables `read_image`.

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-fs-observation-policy'
- name: '@deepseek-ai/dsh-tool-fs'
```

The policy plugin is optional: without it the tools run against the bare provider (unconditional write, overwrite, edit, and patch with no observed state). A deployment that loads these tools is expected to also load it, so the behavior is read-before-write/edit/patch. `read_image` registers only while a durable `ctx.attachments` service is mounted; execution additionally refuses on a route whose exact model does not declare image input, so a text route's durable history stays free of image blocks.

### The tools

| Tool | Arguments | Behavior |
|---|---|---|
| `read` | `file_path`, `offset?`, `limit?` | Line-numbered UTF-8 content with a pagination footer; `offset` is 1-based and `limit` defaults to and caps at the configured `readLimit` |
| `read_image` | `file_path` | Reads and persists a PNG/JPEG/WebP/GIF source; an extension-less path (normalized attachment object paths included) is identified from its file signature; normalization can downscale it before the next model request, so the model need not create a thumbnail first |
| `write` | `file_path`, `content` | Creates or fully replaces a file; with the policy plugin, overwriting requires a prior `read` at the unchanged version, creating does not |
| `edit` | `file_path`, `old_string`, `new_string`, `replace_all?` | Literal replacement requiring a unique match unless `replace_all` is true; with the policy plugin, requires a prior `read` and an unchanged file |
| `apply_patch` | `input`, sandbox escalation fields when available | Add/update/delete/move with whole-patch admission and known partial effects |

Field names are snake_case to match Claude Code and existing harness tool schemas. The `write` and `edit` path descriptions ask the model to emit `file_path` before the content or replacement strings; this guides streaming presentation but does not enforce JSON member order. Successes return compact envelopes — a read window, an image reference, or a `Created file`/`Updated file` confirmation — and `write`/`edit` derive replayable diff-card metadata for UI presentation.

### Configuration

All keys are optional. The `read`, `readImage`, `write`, and `edit` switches default to `true`; set a switch to `false` to omit that tool and its guidance. `applyPatch` defaults to `false`, so the default composition registers no `apply_patch`; the shipped `tool-fs` rows that enable `edit` ([`dsh-base`](../../bundle/base/cordis.patch.yml) and the Web `standard`, `ptc`, and `cordis` presets) state `applyPatch: false`, and changing that one line to `true` adds the tool beside `edit`. All five tools may be disabled. Enabling `readImage` still requires an attachment store and an image-capable model. Read caps remain validated when `read` is disabled.

| Key | Default | Meaning |
|---|---|---|
| `read` | `true` | Register `read` and its guidance |
| `readImage` | `true` | Register `read_image` while an attachment store is mounted |
| `write` | `true` | Register `write` and its guidance |
| `edit` | `true` | Register `edit` and its guidance |
| `applyPatch` | `false` | Register `apply_patch` and its guidance |
| `readLimit` | `2000` | Default and maximum lines returned by one `read` call |
| `readMaxLineLength` | `2000` | Characters kept per line before truncation |
| `readMaxBytes` | `51200` | Byte cap on one `read` call's selected lines; overflow ends the window with a capped footer |
| `readStreamMinSize` | `10485760` | Files at or above this size (or of unknown size) stream instead of loading whole into memory |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-fs) is the exhaustive source for every accepted field and its JSDoc.

With `fs-observation-policy` mounted and `read` disabled, `write` can still create files, and successful writes or edits record the versions needed for later mutations in that session. Existing unobserved files remain protected; disabling `read` does not relax the policy. Another filesystem reader must emit `fs/observed` for an existing file to become observed.

### Policy and sandbox behavior

Path authorization for `read` and `read_image` belongs entirely to `ctx.fs`; media-type declarations and file signatures only decide whether `read_image` accepts the bytes returned by that backend.

With the policy plugin mounted, `write` and `edit` obtain their guard from the `fs/*` intent slots, so an unread target or a stale observation fails with `FS_NOT_OBSERVED` or `FS_STALE_VERSION` and a recovery instruction. Under a confining backend (`fs-sandbox`), `write`/`edit` additionally advertise `sandbox_permissions` and `justification`; a denied mutation returns the `[sandbox: file access denied under <mode> mode]` marker with the same-turn escalation hint, and an approved retry may stamp a strictly wider mode for that one call. When `sandbox_permissions` is omitted or repeats the call's effective mode, `justification` may be omitted, empty, or whitespace-only; no approval is requested. A different mode still requires a non-empty reason, and widening requires approval. A non-empty reason without a mode is rejected. These exceptions do not bypass observation checks or filesystem denials. The justification asks the model to use the language of the current user request.

### Failures and recovery

For `apply_patch`, syntax and preflight refusals throw with `isError: true` before any disk change. `FsError` preserves filesystem codes; `PatchToolError extends HarnessError` carries `PATCH_SYNTAX` and `PATCH_SYMLINK_SOURCE`. Once commit starts, the tool returns a value with `isError: false` even on failure or uncertainty, so known partial effects retain their diff metadata; a call cancelled during commit receives the tool registry's abort result like every other tool, and its completed changes remain visible through Review. `phase`, `cancelled`, ordered `operations` and `affectedPaths` describe the commit; each operation retains its index, kind, display paths, patch line, status, diagnostic and known changes. Full `before`/`after` text serves rendering and PTC; the Session stores the rendered result plus `meta.diffs` and `meta.stopped`. Creations store no diff, as for `write`; deletions and move sources store a removal diff only when the provider returned a bounded basis, using `newText: ''` because `FileDiff.newText` cannot be null.

Failures are normalized as `Error: <message>` with a structured code preserved for callers. Stable messages include `file_path must be a non-empty string`, `limit must be less than or equal to <max>`, `cannot read "<path>": not found`, `cannot read "<path>": not a regular file`, and the image-route refusal `cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`. `FS_NOT_OBSERVED` is normalized to `cannot modify "<path>": file has not been read — read the file, then retry`, independent of whether the policy or provider rejected the operation; `FS_STALE_VERSION` retains the provider's reason and appends `— re-read the file, then retry`. After the reread confirms absence, `edit` reports `FS_NOT_FOUND` instead of repeating a stale remedy, while `write` uses guarded creation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool suite and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The tools are the executor; policy is an event gate. The tools inject no policy service and inspect no cache — each mutation asks the single intent slot for its guard through `ctx.waterfall`, and each operation emits `fs/observed` only after it succeeded. Reads do exactly one provider `stat` (type and size routing plus the observed version); `write` and `edit` do none, because the guard comes from the intent slot and the provider re-checks under its lock.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, tool composition, `read_image` attachments gate |
| [`src/read.ts`](src/read.ts) | `read` executor: one stat, streaming decision, window build, observation |
| [`src/read-image.ts`](src/read-image.ts) | `read_image` executor: route and media-type gates, bounded bytes, attachment save |
| [`src/write.ts`](src/write.ts) | `write` executor: intent waterfall, atomic write, observation |
| [`src/apply-patch.ts`](src/apply-patch.ts), [`apply-patch-output.ts`](src/apply-patch-output.ts) | `apply_patch` registration, strict commit values and compact diagnostics |
| [`src/apply-patch-presentation.ts`](src/apply-patch-presentation.ts) | Pure call previews and known result diffs |
| [`src/edit.ts`](src/edit.ts) | `edit` executor: intent waterfall, literal edit, observation |
| [`src/patch/index.ts`](src/patch/index.ts), [`types.ts`](src/patch/types.ts) | Internal `executePatch` entry and serializable per-operation reports |
| [`src/patch/plan.ts`](src/patch/plan.ts) | Parse and resolve Session-relative paths; preserve ordered operations sharing a canonical target |
| [`src/patch/preflight.ts`](src/patch/preflight.ts) | Simulate preceding successes and collect observation, type, text, and hunk failures before any write |
| [`src/patch/execute.ts`](src/patch/execute.ts) | Reacquire guards, commit sequentially, record actual effects, and classify uncertain failures |
| [`src/read-render.ts`](src/read-render.ts) | Cordis-free windowing and envelope formatting |
| [`src/sandbox.ts`](src/sandbox.ts) | Escalation API shared by the mutating tools: policy resolution and denial-marker mapping |
| [`src/error.ts`](src/error.ts) | Stable model-facing diagnostics for guarded-mutation failures |
| [`src/mutation-result.ts`](src/mutation-result.ts) | Successful mutation observation and canonical result paths |

### Per-tool flow

All four tools share one flow shape: resolve the path with the calling session's cwd, run the applicable gate, perform exactly one provider operation, and emit `fs/observed` only after success. `read` and `read_image` pay one `stat` for type and size routing; `write` and `edit` pay none because their guard comes from the intent slot, and provider failures surface as typed `FsError` results. The per-tool executors live in `src/read.ts`, `src/read-image.ts`, `src/write.ts`, and `src/edit.ts`.

The internal patch executor accepts a raw patch and an already resolved sandbox policy. It builds an ordered plan, preflights all operations against simulated state, then commits through `writeText`, `patchText`, `deleteFile`, or one `moveFile` call. A refused preflight operation has no simulated effect, and any refusal prevents every write. Sandbox containment is not simulated: the provider decides it at each commit, as for `write` and `edit`, so a denied operation stops the patch with the earlier operations retained. A syntax report carries the parser failure; a preflight report lists the refused operations; a commit report keeps one entry per operation with `completed`, `failed`, `unknown`, or `skipped` status and known LF text changes. Unresolved paths retain their raw patch spelling; resolved paths use provider display paths. Programming errors reject the call.

### Observation and concurrency

`fs/observed` fires after the operation succeeded via a plain `ctx.emit`; a listener is contractually a synchronous, side-effect-only recorder, so async or fallible observation does not belong on this event. `read` opts into concurrent scheduling because its only mutation is the synchronous version recorder; recorder races fail closed when a later `write` or `edit` re-checks the version under its target lock, and both mutation tools remain exclusive.

Patch preflight reads never emit `fs/observed`. The first preflight operation on a target dispatches its intent; later operations on that target use the simulated state. Each commit dispatches its intents again to obtain current guards. Add and update record presence, delete records absence, and move records its destination plus source absence only after successful removal; a partial move is `failed` with a destination-only change. The move source baseline comes from `moveFile` under its lock.

After a mutation rejects with `FS_IO_ERROR`, the executor compares each affected target's version with a fresh `stat`. Unchanged targets mean a known failure; a changed target or failed comparison means `unknown`, which records no observation or change. `FS_ABORTED` is always `unknown`: a cancelled remote request rejects while the provider may still be writing. Execution stops at the first failed or unknown commit, or before an operation whose signal is aborted.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tools to the contract, backends, and policy they compose with.

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — exhaustive provider contract, policy events, and error taxonomy.
- [dsh-fs](../fs/README.md) — the `ctx.fs` contract these tools consume.
- [fs-local](../fs-local/README.md) — the host-filesystem backend these tools run against.
- [fs-sandbox](../fs-sandbox/README.md) — the sandbox-enforcing backend that adds the escalation fields.
- [fs-observation-policy](../fs-observation-policy/README.md) — the policy plugin that guards mutations through the `fs/*` events.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs) — the exhaustive schemas this package registers.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

At assembly time, each guidance section checks `ctx.tools.get(name, scope)` and renders only while its tool is visible to that agent. The write paragraph recommends edit only while edit is visible. The text below is unchanged when all three tools are available; restrictions, their removal, and tool registration changes take effect on the next assembly. The same check works for direct agent restrictions and historical subagent filters restored from descriptors, including PTC capabilities behind `run_code`. The read-before-mutation sentences in write/edit describe the observation policy, not a requirement to invoke the tool named `read`. They remain when `read` is hidden: the policy still guards mutations, and another observing operation, such as `str_replace_editor` with `command: view`, can establish the same file observation. Tool visibility does not disable that precondition.

##### Read guidance

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.
```

##### Write guidance

```markdown
Read an existing file before overwriting it with write (the default fs-observation-policy requires it) and prefer edit for targeted changes.
```

##### Edit guidance

```markdown
Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session.
```

#### Token effect

Guidance cost follows the visible tools and their applicable cross-tool recommendations.

#### KV Cache effect

Prefix-stable while the visible tool set, plugin scope, and guidance text are unchanged. Restrictions or plugin lifecycle changes may invalidate reuse from the first changed section.

### Tool schemas

#### What the model sees

The model sees the generated [`read`, `read_image`, `write`, and `edit` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs), with snake_case arguments. The image tool appears only while a durable attachment store is mounted; its schema is route-independent, and the strict gate refuses at execution. Scoped tool restrictions can remove any definition for one agent.

#### Token effect

Fixed schema cost on every request in that tool view.

#### KV Cache effect

Prefix-stable while the visible tool definitions and order are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Read result

#### What the model sees

A successful read is exactly `<path><resolvedPath></path>`, newline, `<type>file</type>`, newline, `<content>`, numbered lines as `<lineNumber>: <text>`, a blank line, one footer, and `</content>`. The footer is exactly `(Output capped. Showing lines <start>-<end>. Use offset=<next> to continue.)`, `(Showing lines <start>-<end> of <total>. Use offset=<next> to continue.)`, or `(End of file - total <total> lines)`. A long line ends exactly `... (line truncated to <max> chars)`. A missing read still returns `FS_NOT_FOUND`, but it records confirmed absence for the calling session; after an externally deleted file is re-read, a retried `write` can safely recreate it through the provider's no-replace guard.

#### Token effect

Read output is capped by `readLimit`, `readMaxLineLength`, and `readMaxBytes`; the retained call and result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Image read result

#### What the model sees

A successful `read_image` returns `<path><resolvedPath></path>`, `<type>image</type>`, and a `<content>` envelope naming the media type, normalized dimensions, and byte size, followed by the image itself as a native image block. The result is logged with its durable reference before the next model request.

#### Token effect

The image is billed on every later request until compaction. Each call is independently bounded by the attachment store's `maxImageBytes`/`maxImagePixels`/`maxImageDimension`; repeated successful calls accumulate history, and content addressing deduplicates only the stored bytes, not the per-request token cost.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Write and edit results

#### What the model sees

Write returns the exact five-line envelope `<path><resolvedPath></path>`, `<type>file</type>`, `<content>`, `Created file` or `Updated file`, then `</content>`. Edit returns exactly `The file <resolvedPath> has been updated successfully.` or, for `replace_all`, `The file <resolvedPath> has been updated. All occurrences were successfully replaced.` The full write or replacement text remains in the assistant tool-call arguments.

#### Token effect

Success text is small, but large mutation arguments and any result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>`. This package's stable validation and read messages are `file_path must be a non-empty string`, `limit must be less than or equal to <max>`, `old_string must be a non-empty string`, `old_string and new_string must differ`, `cannot read "<path>": not found`, `cannot read "<path>": not a regular file`, `offset <offset> is out of range for "<path>" (<total> lines)`, `cannot read "<path>": the <ext> extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`, `cannot read "<path>": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`, `cannot read "<path>": the bytes do not decode as a supported PNG/JPEG/WebP/GIF image; the file may be truncated or corrupt`, `cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`, and the mismatch repair `cannot read "<path>": the <ext> extension declares <type>, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats` (an extension-less mismatch reports `cannot read "<path>": the file signature claims <type>, but the bytes decode as a different image format; the file may be corrupt`). A failed 16-bit conversion reports `cannot read "<path>": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`. Provider and policy templates are quoted in their package READMEs. The model-facing error wrapper normalizes every `FS_NOT_OBSERVED` source to `cannot modify "<path>": file has not been read — read the file, then retry`; `FS_STALE_VERSION` keeps the provider's reason and adds `— re-read the file, then retry`. Both retain the structured error code and original cause. After that reread confirms absence, `edit` reports `FS_NOT_FOUND` instead of repeating a stale remedy, while `write` uses guarded creation.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Apply patch

#### What the model sees

The `apply_patch` schema requires one `input` string (the Codex parameter name, which models trained on that tool send unprompted) containing `*** Begin Patch` / `*** End Patch`, Add/Update/Delete headers, optional Move to, and context/add/remove hunk lines. Paths are Session-relative. A confining backend adds the same escalation fields as write/edit. Success lines group A/M/D and a completed move reports `M <destination>`, matching Codex rust-v0.158.0. An empty patch renders `Success. No operations in patch.`. A stopped patch includes only the applicable Completed, Failed, Outcome unknown and Not executed sections; unknown outcomes end with the re-read remedy. Syntax errors keep the parser message.

##### System guidance

```markdown
Prefer apply_patch over separate edit calls for changes across files or separated regions. Read a file before updating, deleting, or moving it (the default fs-observation-policy requires it), unless you just created or edited it in this session. The whole patch is checked first (syntax, hunk matching, missing files) and a rejected patch changes nothing; once applying starts, operations run in order, stop at the first failure, and are not rolled back, so re-read affected files before retrying when needed.
```

##### Result examples

```markdown
Success. Updated the following files:
A src/new.ts
M src/a.ts
D src/obsolete.ts

Patch stopped after 1 of 3 operations.
Completed:
M src/a.ts
Failed:
- operation 2 (move src/b.ts -> src/c.ts, patch line 6): source removal denied
  destination src/c.ts was written; source src/b.ts remains
Not executed:
- operation 3 (add src/d.ts)

Patch rejected before any change (1 problems):
- operation 1 (update src/a.ts, patch line 2): cannot modify "src/a.ts": file has not been read — read the file, then retry
```

#### Token effect

The default tool set adds one patch tool schema and three guidance sentences to the first request. Commit output scales with operation count and diagnostics, not file size.

#### KV Cache effect

Stable while the visible tools are unchanged; call/result text appends to history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool suite is a poor fit or needs special operational care. They are current package constraints, not a general filesystem comparison or a task backlog.

- **Patch commits do not roll back** — earlier successes and a published move destination remain on disk after a later failure, and an `unknown` result requires re-reading the affected files before retrying.
- **No model-facing directory listing ships** — `ctx.fs.listDir` serves provider code such as skill discovery, while the sibling `dsh-tool-fs-search` package supplies ripgrep-backed `glob` and `grep` rather than extending the filesystem seam.
- **`read` handles UTF-8 text files only** — images use the separate `read_image` tool; PDF, audio, and video remain deferred. A directory target is `FS_NOT_REGULAR_FILE`.
- **Extension-declared media type** — an extension selects the declared type and the attachment store's magic-byte validation stays authoritative; a correctly formatted image under a wrong extension is refused with the rename remedy rather than sniffed. Only a path with no extension is identified from its file signature.
- **Object paths re-enter source admission** — `read_image` on a normalized attachment object re-admits its bytes as a new source, so a deployment whose `maxImageBytes`/`maxMessageImageBytes` sit below the normalized-image byte budget can refuse an object path that `ctx.attachments.readImage` still serves; shipped defaults keep the normalized budget (4 MiB) far under the source caps (50 MiB).
- **Inline image preview rides the UI composition** — the tool-result card renders the image through the browser's `tool.call.images` slot, which the attachment presentation plugin fills; a UI without that plugin shows the result's envelope text instead.
- **No attachment-region tool** — an agent may crop an image through another available tool when it has a filesystem path; a pasted or dragged image without a path cannot be re-read at higher resolution.
- **No timeout surface** — `read`/`write`/`edit` take no timeout argument and declare no timeout budget; cancellation rides `exec.signal` only ([provider rationale](../README.md)).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
