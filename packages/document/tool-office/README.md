---
description: "Skill-activated Office tools for viewing document pages, converting documents, and recalculating workbooks."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-office

English | [中文](README.zh.md)

## Summary

After an Office skill loads, the model gains three tools. `office_render` returns document pages, slides, or worksheet areas as images for layout inspection, without temporary image files or a separate image read. `office_convert` produces a document in another format; `office_recalculate` refreshes workbook formulas. Both return a temporary file to copy to its destination with the shell. The tools do not modify inputs or write workspace files, and work in standard and PTC modes alike.

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

The [Web bundle](../../bundle/web-app/README.md) and the [SDK bundle](../../bundle/sdk-app/README.md) mount this plugin with `office-kit` in Desktop, ordinary `dsh web`, and the SDK; in the Web bundle the `standard` and `ptc` agent presets include it and the `minimal` preset does not. Loading any configured [Office skill](../../skill/skill-office/README.md) activates all three tools from the next model step, whether loaded by a model `skill` call, a nested PTC call, or direct user invocation such as `/office`. Failed loads and other skills do not activate them. Calls before activation return `UNKNOWN_TOOL`.

Activation matches only the skill names listed in `activationSkills`, so mount [`@deepseek-ai/dsh-skill-office`](../../skill/skill-office/README.md) or another provider that registers skills with those names; without one, the three tools never appear.

The tools read the Office kit service at each call. When Kit is missing, calls fail with the service's `unavailable` message; while the service is absent, calls fail with `The document converter is unavailable.` Every `unavailable` failure tells the model to inform the user, or to retry later when the cause may be temporary, such as a full output store or a service being unloaded, without substituting system soffice, npx, or another converter.

```yaml
- name: '@deepseek-ai/dsh-office-kit'
- name: '@deepseek-ai/dsh-tool-office'
  config:
    maxImages: 20
```

| Field | Default | Meaning |
|---|---|---|
| `activationSkills` | `[office, office-docx, office-xlsx, office-pptx]` | Nonempty list of kebab-case skill names whose successful loading activates all three tools |
| `maxImages` | `20` | Maximum images one render returns, including worksheet fragments |
| `maxImagePixels` | `8388608` | Maximum pixels of each image |
| `maxImageDimension` | `8192` | Maximum width and height of each image |
| `maxImageBytes` | `33554432` | Maximum PNG bytes across all images of one render |

A render applies the lower of each field and the attachment store's corresponding image limit (`maxImagesPerMessage`, `maxImagePixels`, `maxImageDimension`, `maxMessageImageBytes`), and refuses any single image above `maxImageBytes` of the store. A selection beyond a bound fails instead of being truncated. Rendering requires an attachment store and a calling model route that declares image input. The tool reads that route from the latest model request of the Session, or from the agent options before the first request, and refuses a model whose input modalities omit images or are not declared before any rendering work starts.

Inputs resolve against the Session working directory and use the filesystem backend's read authority, as `read` and Office previews do, so files outside the workspace are readable. The input extension selects the document family. `office_convert` accepts Word, Excel, and PowerPoint documents: Word exports to pdf, docx, odt, or txt; Excel to pdf, xlsx, ods, or csv; PowerPoint to pdf, pptx, or odp. CSV export requires a worksheet name for a workbook with several sheets. `office_recalculate` accepts xls, xlsx, and ods workbooks and requires xlsx or ods output. `office_render` also accepts PDF.

Conversion and recalculation results name a file in the Office kit's private [output store](../office-kit/README.md#use-this-package) under the Harness home; the model copies it with the shell, so the shell's sandbox and approvals govern where it lands. When the filesystem backend cannot read Host files, such as an SSH workspace, these two tools fail before converting; rendering still works.

Every request enters the Office kit's shared queue with `foreground` priority, the same class as an open preview. Foreground work runs before background prewarming and can evict queued background jobs, so speculative previews cannot starve tool calls; tool calls and open previews share admission in arrival order.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Argument checks, including input-dependent conversion formats, and the Office kit lookup run before any filesystem access, so a malformed call or an absent service fails without reading the input. The tool then resolves the input through `ctx.fs`, requires a regular file, reads its first byte through `fs.readByteRange`, and stats it again, so a call without content read access, or for a file replaced since its stat, fails before the Office kit can answer from its cache. It then passes the Office kit an authorized source whose deferred read stats the file before and after a bounded `fs.readBytes` and rejects a changed version. Render results are committed through `attachments.saveImages()` before the result returns, so the `tool/result` event carries durable image references; resume, fork, and replay restore the same images, and image offload applies to them like any other tool-result image. The canonical value carries attachment references and image locations; `output.render` produces one summary text, then a location label and image block per rendered page or area. `presentationMeta` records the canonical input path, plus the temporary file path for conversions. Output store files are owned by the root Session of the caller's subagent tree, read through `subagents.rootOf()` when that service is mounted and otherwise the calling Session, and are named after the input with the new extension.

Each tool declares its own parameters and result schema. The supported schema subset cannot express page uniqueness, numeric bounds, or cross-parameter rules, so those render selections and input-dependent conversion formats are checked at runtime. Office kit errors are reported as `cannot <operation> "<path>": <message>`, where `<path>` is the resolved input path, or the path as given when the service is absent, with a hint for `unavailable` to tell the user or, when the cause may be temporary, to retry later without substituting another converter, a retry hint for `busy`, and a selection hint for oversized renders. Nested PTC calls re-enter the same execution pipeline, so policy and logging apply to them; a nested render's images are attached after the program run.

Successful `tools/result` notifications mark the calling Agent in a plugin-owned WeakSet. The post-commit `session/event` feed also marks direct user skill invocations, without depending on pre-step listener order. `agent/disposed` clears the mark. The three tools share one `when`: the Agent is marked, or the Session's latest public `requestHeader()` lists any Office tool. No additional projection or Session event is registered.

Native request headers retain Office declarations across resume and fork, including the first request after restoration; compaction replaces conversation content without removing request headers. PTC records only `run_code` in its request header, so a resumed or forked PTC Agent must load an Office skill again. Losing an Agent's memory before a native Office declaration is recorded also loses activation; calling `skill` again restores it on the following step.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Office kit](../office-kit/README.md) — conversion queue, limits, and Kit location.
- [Office tool decision](../../../.agents/notes/implemented/architecture/2026-10-31-native-office-tool.md) — why Office operations run through the Host.
- [Tool authoring reference](../../../docs/cookbook/adding-a-tool.md) — execution and presentation contracts.

<a id="model-experience"></a>
## Model Experience

### office_render, office_convert, office_recalculate

#### What the model sees

The three declarations are documented in the [tool catalog](../../../docs/tool-catalog.md). A render result opens with `Rendered <count> image(s) of <absolute input path> (<pageCount> in the document) at <dpi> DPI.`, adds `Fonts not installed and substituted: <families>.` when fonts are missing, then gives each image as a `Page <n>: <width>x<height> px` or `Sheet "<name>" <range>: <width>x<height> px` label followed by the image. A conversion reports `Converted <input> to <format> (<bytes> bytes[, <n> pages]): <temporary file>` (or `Recalculated …`), then `Copy this temporary file to its destination with the shell now; it may be deleted after a retention period or to free space, and is deleted when this conversation ends.` and the same font line. Failures read `cannot <operation> "<path>": <reason>`.

#### Token effect

No Office declarations before activation; three fixed tool schemas afterward, represented as program bindings in PTC mode. Each render adds its summary, one short label per image, and the images, bounded by the configured and attachment image limits; image tokens depend on the route's image pricing. Conversions add two lines.

#### KV Cache effect

In native mode, activation during a conversation appends one `developer/message` with `tool-addition` blocks; a route that declares `toolUpdate` keeps the request prefix unchanged, and other routes start one new request series. Native resume and fork retain the declarations. In PTC mode, the three tools are bindings listed in the `run_code` section of the system prompt, so activation rewrites the system prompt: a route that declares `systemPromptUpdate: in-history` appends one system message, and other routes start one new request series. PTC resume or fork loses the in-memory mark, so the system prompt changes twice: the next step removes the bindings, and loading an Office skill again adds them back. Results append to the conversation; image offload may later replace an image occurrence with placeholder text through its own logged event.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Converted files need a shell copy** — the filesystem service creates no binary files, so the model copies each temporary file with the shell. Deployments without a shell tool cannot deliver converted files, and the temporary file is deleted after the Office kit's retention or when the root Session of the caller's subagent tree is disposed; a file a subagent produced stays after that subagent ends.
- **No conversion on remote workspaces** — the Office kit runs on the Host, and a remote shell cannot read its output store.
- **Render saves no image file** — `office_render` returns images only for the model to view and writes no PNG or other image file. A user who needs the pages as a file gets a PDF through `office_convert` with `format: "pdf"`.
- **Web GUI does not display rendered images** — the [ui-tool](../../client/ui-tool/README.md) Office row shows the text blocks of an `office_render` result and omits its images, so the user does not see the pages the model inspected. The model still receives every image.
- **Native engine in the Host process** — rendering, conversion, and recalculation that the model starts run the native LibreOffice Kit engine inside the Host process through `ctx.officeKit`, so the shell sandbox and PTC permissions do not confine them. Inputs remain subject to the filesystem backend's read authority. The native parser processes an untrusted document with the Host user's permissions.
- **PTC activation does not survive resume or fork** — the PTC request header records only `run_code`, so a resumed or forked PTC Agent offers no Office bindings until the model loads an Office skill again; the removal and the re-addition each rewrite the system prompt, with the cache effect described under KV Cache effect.
- **Plugin reload clears activation** — hot reload, or disabling and re-enabling the plugin, clears the in-memory marks. If a step runs in the meantime, its request header omits the three tools, and the model must load an Office skill again to restore them.
- **Direct invocation activates from the next step** — the tool set of a step is fixed before the content of a user-invoked skill such as `/office` is injected, so the first model request after the invocation declares no Office tools. The tools appear from the next model step.
- Rendering fidelity, fonts, and pagination follow LibreOffice Kit and can differ from Microsoft Office.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
