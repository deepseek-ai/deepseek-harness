---
description: "The office tool: render document pages as images the model sees, convert documents, and recalculate workbooks through the shared Office kit."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-office

English | [中文](README.zh.md)

## Summary

Give the model one `office` tool for Office operations. `render` returns document pages, slides, or worksheet areas as images in the tool result, so the model inspects layout without temporary files or a separate image read. `convert` produces a document in another format and `recalculate` a workbook with refreshed formula results, each as a temporary file that the model copies to its destination with the shell; the tool itself writes no workspace file. All three run through the shared [Office kit](../office-kit/README.md) service in the Host process, in standard and PTC modes alike.

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

The [Web bundle](../../bundle/web-app/README.md) and the [SDK bundle](../../bundle/sdk-app/README.md) mount this tool with `office-kit` in Desktop, ordinary `dsh web`, and the SDK; in the Web bundle the `standard` and `ptc` agent presets include it and the `minimal` preset does not. The tool is registered whether or not LibreOffice Kit is installed or the `office-kit` service is mounted, and it reads that service at each call. When Kit is missing, every call fails with the Office service's `unavailable` message; while the service is absent, every call fails with `The document converter is unavailable.` Both failures tell the model to tell the user the operation is unavailable without substituting system soffice, npx, or another converter. The [Office skills](../../skill/skill-office/README.md) tell the model when to render and how to check results.

```yaml
- name: '@deepseek-ai/dsh-office-kit'
- name: '@deepseek-ai/dsh-tool-office'
  config:
    maxImages: 20
```

| Field | Default | Meaning |
|---|---|---|
| `maxImages` | `20` | Maximum images one render returns, including worksheet fragments |
| `maxImagePixels` | `8388608` | Maximum pixels of each image |
| `maxImageDimension` | `8192` | Maximum width and height of each image |
| `maxImageBytes` | `33554432` | Maximum PNG bytes across all images of one render |

A render applies the lower of each field and the attachment store's corresponding image limit (`maxImagesPerMessage`, `maxImagePixels`, `maxImageDimension`, `maxMessageImageBytes`), and refuses any single image above `maxImageBytes` of the store. A selection beyond a bound fails instead of being truncated. Rendering requires an attachment store and a calling model route that declares image input, checked by `dsh-tools` `assertImageInputRoute`; other routes receive a refusal before any rendering work starts.

Inputs resolve against the Session working directory and use the filesystem backend's read authority, as `read` and Office previews do, so files outside the workspace are readable. The input extension selects the document family, and `format` selects the output of `convert` and `recalculate`. Their result names a file in the Office kit's private [output store](../office-kit/README.md#use-this-package) under the Harness home; the model copies it with the shell, so the shell's sandbox and approvals govern where it lands. When the filesystem backend cannot read Host files, such as an SSH workspace, `convert` and `recalculate` fail before converting; `render` still works.

Every request enters the Office kit's shared queue with `foreground` priority, the same class as an open preview. Foreground work runs before background prewarming and can evict queued background jobs, so speculative previews cannot starve tool calls; tool calls and open previews share admission in arrival order.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool resolves the input through `ctx.fs`, requires a regular file, reads its first byte through `fs.readByteRange`, and stats it again, so a call without content read access, or for a file replaced since its stat, fails before the Office kit can answer from its cache. It then passes the Office kit an authorized source whose deferred read stats the file before and after a bounded `fs.readBytes` and rejects a changed version. Render results are committed through `attachments.saveImages()` before the result returns, so the `tool/result` event carries durable image references; resume, fork, and replay restore the same images, and image offload applies to them like any other tool-result image. The canonical value carries attachment references and image locations; `output.render` produces one summary text, then a location label and image block per rendered page or area. `presentationMeta` records the canonical input path, plus the temporary file path for conversions. Output store files are owned by the root Session of the caller's subagent tree, read through `subagents.rootOf()` when that service is mounted and otherwise the calling Session, and are named after the input with the new extension.

Argument rules that the schema cannot express — operation-specific parameters, distinct one-based pages, the dpi range, and the input and output formats of each operation — are checked before any file access. Office kit errors are reported as `cannot <operation> "<path>": <message>`, with a hint for `unavailable` to tell the user, a retry hint for `busy`, and a selection hint for oversized renders. Nested PTC calls re-enter the same execution pipeline, so policy and logging apply to them; a nested render's images are attached after the program run.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Office kit](../office-kit/README.md) — conversion queue, limits, and Kit location.
- [Office tool decision](../../../.agents/notes/implemented/architecture/2026-10-31-native-office-tool.md) — why Office operations use a resident Host tool.
- [Tool authoring reference](../../../docs/cookbook/adding-a-tool.md) — execution and presentation contracts.

<a id="model-experience"></a>
## Model Experience

### office

#### What the model sees

The [office schema](../../../docs/tool-catalog.md#office) is always present while the plugin is mounted. A render result opens with `Rendered <count> image(s) of <absolute input path> (<pageCount> in the document) at <dpi> DPI.`, adds `Fonts not installed and substituted: <families>.` when fonts are missing, then gives each image as a `Page <n>: <width>x<height> px` or `Sheet "<name>" <range>: <width>x<height> px` label followed by the image. A conversion reports `Converted <input> to <format> (<bytes> bytes[, <n> pages]): <temporary file>` (or `Recalculated …`), then `Copy this temporary file to its destination with the shell now; it is deleted when this conversation ends.` and the same font line. Failures read `cannot <operation> "<path>": <reason>`.

#### Token effect

One fixed tool schema per request while mounted. Each render adds its summary, one short label per image, and the images, bounded by the configured and attachment image limits; image tokens depend on the route's image pricing. Conversions add two lines.

#### KV Cache effect

The schema is static for the mount lifetime and does not depend on loaded skills, so the tool-declaration prefix stays stable. Results append to the conversation; image offload may later replace an image occurrence with placeholder text through its own logged event.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Converted files need a shell copy** — the filesystem service creates no binary files, so the model copies each temporary file with the shell. Deployments without a shell tool cannot deliver converted files, and the temporary file is deleted after the Office kit's retention or when the root Session of the caller's subagent tree is disposed; a file a subagent produced stays after that subagent ends.
- **No conversion on remote workspaces** — the Office kit runs on the Host, and a remote shell cannot read its output store.
- **Render saves no image file** — `render` returns images only for the model to view and writes no PNG or other image file. A user who needs the pages as a file gets a PDF through `convert` with `format: "pdf"`.
- **Native engine in the Host process** — rendering, conversion, and recalculation that the model starts run the native LibreOffice Kit engine inside the Host process through `ctx.officeKit`, so the shell sandbox and PTC permissions do not confine them. Inputs remain subject to the filesystem backend's read authority. The native parser processes an untrusted document with the Host user's permissions.
- Rendering fidelity, fonts, and pagination follow LibreOffice Kit and can differ from Microsoft Office.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
