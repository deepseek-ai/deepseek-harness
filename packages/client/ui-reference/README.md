---
description: "Web @file and @session reference source for the composer: candidates, ordering, and atomic inline references (unified file/session picking)."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-reference

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-reference` is the unified Web `@file` and `@session` reference source: it registers the `reference` entry in the composer's inline-suggestion machinery so a user typing `@` sees file and session candidates in one list. Files order before sessions, sections are labelled with locale-registered terms, and either candidate domain can fail independently without blocking the other. Each row carries only what distinguishes it: a file names its parent directory and nothing at the workspace root, a session names its workspace only when that workspace is not the current one, and a drilled directory listing names none because its breadcrumb already does. A pick inserts an atomic inline reference — file, folder, and session alike — whose hidden serialized and clipboard form is the natural text the shared `@path` grammar defines; a directory row additionally carries a drill verb (Tab or the row's chevron) that keeps plain editable path text and the menu active at its trailing slash so the user can descend another level. Selecting a session routes through the session-reference service, which validates the mention and captures model context at the pre-step boundary; this package itself registers no prompt or tool.

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

The source is active whenever the composition mounts this package and a Host `ctx.fileReferences` provider is available. Type `@` followed by an unquoted token to see files first, then sessions; open `@"…` to search files only. The candidate list is a completion menu, not a search result page: pick once and keep typing.

### What a pick inserts

A file closes completion as an atomic inline reference displayed with a file glyph and business-color filename. A directory row carries two verbs: the settling pick (row click or Enter) resolves the folder itself as the same kind of atomic reference — folder glyph, trailing-slash label, canonical `@dir/` mention as its serialized form — while the drill action (Tab or the row's chevron) keeps plain editable path text with a folder glyph and the menu active at its trailing slash, so you can descend another level. Paths containing whitespace use `@"path with spaces"`, and a quote the user opened explicitly remains quoted.

A session pick inserts an atomic inline reference whose hidden `ref` and clipboard representation is the canonical `@[label](dsh-session:…)` mention returned by the Host; its visible form is a chat-bubble glyph plus the session title. Sending carries the mention through `session.prompt`, and the session-reference service validates it and captures model context at `agent/pre-step`.

### Failure behavior

One unavailable or failed candidate domain yields no rows for that domain while the other still lists. A session-reference preparation failure occurs after prompt acceptance and terminates that agent turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The source keeps candidate encoding internal to the registration effect: the `/client` export is the plugin body (`apply`/`inject`) only.

### Candidate flow

For an unquoted token, the browser starts the `fileReferences/list` and `sessionReferenceResolver/candidates` Remote calls together, then deterministically orders files before sessions with locale-registered folder/file/session labels. Rows render under non-selectable file and session section headings without a redundant raw `reference` source title. A session row is dated from the Host session list's `updatedAt` through the same relative-time bucket that list uses, so one session reads the same age on both surfaces; a session the list does not carry falls back to the candidate's creation time. A drilled query publishes a breadcrumb from the workspace root to the directory being listed; each crumb carries the drill payload a folder row would, so returning to a step and descending into one are one outcome.

### Serialization

File picks preserve the natural text defined by the shared `@path` grammar as the hidden serialized and clipboard form. Session picks use the canonical `@[label](dsh-session:…)` mention; serialization never reconstructs identity from the visible title.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the suggestion machinery, the reference seams, and the input pipeline.

- [ui-input-trigger](../ui-input-trigger/README.md) — the inline suggestion machinery the source registers into.
- [file-reference](../../context/file-reference/README.md) — the `@file` seam and its provider contract.
- [session-reference](../../context/session-reference/README.md) — the `@session` seam and prepared snapshot semantics.
- [Web input machine and slash pipeline](../../../.agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md) — how references and commands share the input machine.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through Host-owned providers, which own the file guidance and session snapshot preparation this package's reference selection delegates to them.

#### KV Cache effect

Candidate browsing has no model effect. A selected file or session changes only the new user-message suffix and any Host-prepared session-reference context that follows that message; earlier target history remains unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the reference source cannot help; they are current package constraints.

- **Candidate failure is intentionally quiet** — one unavailable or failed Remote discovery call yields no rows for that domain. A session-reference preparation failure occurs after prompt acceptance and terminates that agent turn.
- **No browser-side file scan** — Web completion requires a mounted Host `ctx.fileReferences` provider; the browser cannot fall back to its own filesystem.
- **Session search remains metadata-only** — discovery filters session id, cwd, and the latest log-backed title through `ctx.sessionReferenceResolver`; message bodies and full transcripts are not searched.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A single slash-source registration whose disposal is proven by the HMR-safety spec — it emits no cordis events and owns no cross-plugin mutable state.
