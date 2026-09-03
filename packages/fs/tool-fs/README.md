---
description: "The model-facing read, read_image, write, and edit tools for users and maintainers composing or debugging filesystem access for agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-fs

English | [中文](README.zh.md)

## Summary

`dsh-tool-fs` provides the model-facing filesystem tools — `read`, `read_image`, `write`, and `edit` — and their executor. With them the model reads files with line numbers, creates or replaces them atomically, and applies targeted literal edits; results are capped and failures carry stable codes with recovery instructions, all backed by a mounted `ctx.fs` backend. The read-before-edit policy lives in a separate plugin (`dsh-fs-observation-policy`), so omitting it yields unconditional, still-atomic mutations. `read_image` appears while a durable attachment store is mounted and refuses execution unless the routed model declares image input. Choose this package when the model should read, create, replace, or edit UTF-8 text files; discovery (`glob`/`grep`) is a sibling package.

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

Mount the tools after a `ctx.fs` backend and, for read-before-write/edit behavior, the policy plugin. The model then gets line-numbered reads, atomic writes and edits, and — with an attachment store mounted — image reads; every result is capped, and failures carry stable codes with recovery instructions.

### Minimal composition

A backend, the policy plugin, then the tools; the attachment store is optional and enables `read_image`.

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-fs-observation-policy'
- name: '@deepseek-ai/dsh-tool-fs'
```

The policy plugin is optional: without it the tools run against the bare provider (unconditional write, overwrite, and edit with no observed-state). A deployment that loads these tools is expected to also load it, so the behavior is read-before-write/edit. `read_image` registers only while a durable `ctx.attachments` service is mounted; execution additionally refuses on a route whose exact model does not declare image input, so a text route's durable history stays free of image blocks.

### The tools

| Tool | Arguments | Behavior |
|---|---|---|
| `read` | `file_path`, `offset?`, `limit?` | Line-numbered UTF-8 content with a pagination footer; `offset` is 1-based and `limit` defaults to and caps at the configured `readLimit` |
| `read_image` | `file_path` | Reads and persists a PNG/JPEG/WebP/GIF source; an extension-less path (normalized attachment object paths included) is identified from its file signature; normalization can downscale it before the next model request, so the model need not create a thumbnail first |
| `write` | `file_path`, `content` | Creates or fully replaces a file; with the policy plugin, overwriting requires a prior `read` at the unchanged version, creating does not |
| `edit` | `file_path`, `old_string`, `new_string`, `replace_all?` | Literal replacement requiring a unique match unless `replace_all` is true; with the policy plugin, requires a prior `read` and an unchanged file |

Field names are snake_case to match Claude Code and existing harness tool schemas. Successes return compact envelopes — a read window, an image reference, or a `Created file`/`Updated file` confirmation — and `write`/`edit` derive replayable diff-card metadata for UI presentation.

### Configuration

All keys are optional; the defaults are the shipped read caps.

| Key | Default | Meaning |
|---|---|---|
| `readLimit` | `2000` | Default and maximum lines returned by one `read` call |
| `readMaxLineLength` | `2000` | Characters kept per line before truncation |
| `readMaxBytes` | `51200` | Byte cap on one `read` call's selected lines; overflow ends the window with a capped footer |
| `readStreamMinSize` | `10485760` | Files at or above this size (or of unknown size) stream instead of loading whole into memory |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-fs) is the exhaustive source for every accepted field and its JSDoc.

### Policy and sandbox behavior

Path authorization for `read` and `read_image` belongs entirely to `ctx.fs`; media-type declarations and file signatures only decide whether `read_image` accepts the bytes returned by that backend.

With the policy plugin mounted, `write` and `edit` obtain their guard from the `fs/*` intent slots, so an unread target or a stale observation fails with `FS_NOT_OBSERVED` or `FS_STALE_VERSION` and a recovery instruction. Under a confining backend (`fs-sandbox`), `write`/`edit` additionally advertise `sandbox_permissions` and `justification`; a denied mutation returns the `[sandbox: file access denied under <mode> mode]` marker with the same-turn escalation hint, and an approved retry may stamp a strictly wider mode for that one call.

### Failures and recovery

Failures are normalized as `Error: <message>` with a structured code preserved for callers. Stable messages include `file_path must be a non-empty string`, `limit must be less than or equal to <max>`, `cannot read "<path>": not found`, `cannot read "<path>": not a regular file`, and the image-route refusal `cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`. Guarded-mutation failures append their remedy: `FS_STALE_VERSION` gets `— re-read the file, then retry`, `FS_NOT_OBSERVED` gets `— read the file, then retry`. After the reread confirms absence, `edit` reports `FS_NOT_FOUND` instead of repeating a stale remedy, while `write` uses guarded creation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool suite and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The tools are the executor; policy is an event gate. The tools inject no policy service and inspect no cache — each mutation asks the single intent slot for its guard through `ctx.waterfall`, and each operation emits `fs/observed` only after it succeeded. Reads do exactly one provider `stat` (type and size routing plus the observed version); mutations do none, because the guard comes from the intent slot and the provider re-checks under its lock.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, tool composition, `read_image` attachments gate |
| [`src/read.ts`](src/read.ts) | `read` executor: one stat, streaming decision, window build, observation |
| [`src/read-image.ts`](src/read-image.ts) | `read_image` executor: route and media-type gates, bounded bytes, attachment save |
| [`src/write.ts`](src/write.ts) | `write` executor: intent waterfall, atomic write, observation |
| [`src/edit.ts`](src/edit.ts) | `edit` executor: intent waterfall, literal edit, observation |
| [`src/read-render.ts`](src/read-render.ts) | Cordis-free windowing and envelope formatting |
| [`src/sandbox.ts`](src/sandbox.ts) | Escalation API shared by `write`/`edit`: policy resolution and denial-marker mapping |
| [`src/error.ts`](src/error.ts) | Model-facing remedy appended to `FS_STALE_VERSION` and `FS_NOT_OBSERVED` |

### Per-tool flow

All four tools share one flow shape: resolve the path with the calling session's cwd, run the applicable gate, perform exactly one provider operation, and emit `fs/observed` only after success. `read` and `read_image` pay one `stat` for type and size routing; `write` and `edit` pay none because their guard comes from the intent slot, and provider failures surface as typed `FsError` results. The per-tool executors live in `src/read.ts`, `src/read-image.ts`, `src/write.ts`, and `src/edit.ts`.

### Observation and concurrency

`fs/observed` fires after the operation succeeded via a plain `ctx.emit`; a listener is contractually a synchronous, side-effect-only recorder, so async or fallible observation does not belong on this event. `read` opts into concurrent scheduling because its only mutation is the synchronous version recorder; recorder races fail closed when a later `write` or `edit` re-checks the version under its target lock, and both mutation tools remain exclusive.

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

Every request in this plugin's registration scope receives the independently registered read, write, and edit guidance below. Scoped tool restrictions can hide schemas without removing these sections.

##### Read guidance

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.
```

##### Write guidance

```markdown
Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.
```

##### Edit guidance

```markdown
Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.
```

#### Token effect

Fixed guidance cost per request while the plugin is active, even when a restriction hides one or more tools.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Tool restrictions do not remove this section, but plugin activation or disposal may invalidate reuse from it.

### Tool schemas

#### What the model sees

The model sees the generated [`read`, `read_image`, `write`, and `edit` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs), with snake_case arguments. The image tool appears only while a durable attachment store is mounted; its schema is route-independent, and the strict gate refuses at execution. Scoped tool restrictions can remove any definition for one agent.

#### Token effect

Fixed schema cost on every request in that tool view.

#### KV Cache effect

Prefix-stable while the visible tool definitions and order are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Read result

#### What the model sees

A successful read is exactly `<path><displayPath></path>`, newline, `<type>file</type>`, newline, `<content>`, numbered lines as `<lineNumber>: <text>`, a blank line, one footer, and `</content>`. The footer is exactly `(Output capped. Showing lines <start>-<end>. Use offset=<next> to continue.)`, `(Showing lines <start>-<end> of <total>. Use offset=<next> to continue.)`, or `(End of file - total <total> lines)`. A long line ends exactly `... (line truncated to <max> chars)`. A missing read still returns `FS_NOT_FOUND`, but it records confirmed absence for the calling session; after an externally deleted file is re-read, a retried `write` can safely recreate it through the provider's no-replace guard.

#### Token effect

Read output is capped by `readLimit`, `readMaxLineLength`, and `readMaxBytes`; the retained call and result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Image read result

#### What the model sees

A successful `read_image` returns `<path><displayPath></path>`, `<type>image</type>`, and a `<content>` envelope naming the media type, normalized dimensions, and byte size, followed by the image itself as a native image block. The result is logged with its durable reference before the next model request.

#### Token effect

The image is billed on every later request until compaction. Each call is independently bounded by the attachment store's `maxImageBytes`/`maxImagePixels`/`maxImageDimension`; repeated successful calls accumulate history, and content addressing deduplicates only the stored bytes, not the per-request token cost.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Write and edit results

#### What the model sees

Write returns the exact five-line envelope `<path><displayPath></path>`, `<type>file</type>`, `<content>`, `Created file` or `Updated file`, then `</content>`. Edit returns exactly `The file <displayPath> has been updated successfully.` or, for `replace_all`, `The file <displayPath> has been updated. All occurrences were successfully replaced.` The full write or replacement text remains in the assistant tool-call arguments.

#### Token effect

Success text is small, but large mutation arguments and any result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>`. This package's stable validation and read messages are `file_path must be a non-empty string`, `limit must be less than or equal to <max>`, `old_string must be a non-empty string`, `old_string and new_string must differ`, `cannot read "<path>": not found`, `cannot read "<path>": not a regular file`, `offset <offset> is out of range for "<path>" (<total> lines)`, `cannot read "<path>": the <ext> extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`, `cannot read "<path>": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`, `cannot read "<path>": the bytes do not decode as a supported PNG/JPEG/WebP/GIF image; the file may be truncated or corrupt`, `cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`, and the mismatch repair `cannot read "<path>": the <ext> extension declares <type>, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats` (an extension-less mismatch reports `cannot read "<path>": the file signature claims <type>, but the bytes decode as a different image format; the file may be corrupt`). A failed 16-bit conversion reports `cannot read "<path>": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`. Provider and policy templates are quoted in their package READMEs. Guarded-mutation failures additionally carry their recovery instruction in the message, appended by this package's model-facing error wrapper: `FS_STALE_VERSION` gets `— re-read the file, then retry`, and `FS_NOT_OBSERVED` gets `— read the file, then retry`; the structured code is preserved. After that reread confirms absence, `edit` reports `FS_NOT_FOUND` instead of repeating a stale remedy, while `write` uses guarded creation.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool suite is a poor fit or needs special operational care. They are current package constraints, not a general filesystem comparison or a task backlog.

- **No model-facing directory listing ships** — `ctx.fs.listDir` serves provider code such as skill discovery, while the sibling `dsh-tool-fs-search` package supplies ripgrep-backed `glob` and `grep` rather than extending the filesystem seam.
- **`read` handles UTF-8 text files only** — images use the separate `read_image` tool; PDF, audio, and video remain deferred. A directory target is `FS_NOT_REGULAR_FILE`.
- **Extension-declared media type** — an extension selects the declared type and the attachment store's magic-byte validation stays authoritative; a correctly formatted image under a wrong extension is refused with the rename remedy rather than sniffed. Only a path with no extension is identified from its file signature.
- **Object paths re-enter source admission** — `read_image` on a normalized attachment object re-admits its bytes as a new source, so a deployment whose `maxImageBytes`/`maxMessageImageBytes` sit below the normalized-image byte budget can refuse an object path that `ctx.attachments.readImage` still serves; shipped defaults keep the normalized budget (4 MiB) far under the source caps (20 MiB).
- **Inline image preview rides the UI composition** — the tool-result card renders the image through the browser's `tool.call.images` slot, which the attachment presentation plugin fills; a UI without that plugin shows the result's envelope text instead.
- **No attachment-region tool** — an agent may crop an image through another available tool when it has a filesystem path; a pasted or dragged image without a path cannot be re-read at higher resolution.
- **No timeout surface** — `read`/`write`/`edit` take no timeout argument and declare no timeout budget; cancellation rides `exec.signal` only ([provider rationale](../README.md)).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This model-facing adapter has no independent lifecycle stream; execution relations are owned by the capability seam it calls.
