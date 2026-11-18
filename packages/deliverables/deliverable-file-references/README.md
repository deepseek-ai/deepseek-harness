---
description: "Give Web and SDK agents shared instructions for linking files and delivering results."
kind: "package-reference"
---

# @deepseek-ai/dsh-deliverable-file-references

English | [中文](README.zh.md)

## Summary

Agents receive the same file-link and result-delivery instructions in Web and SDK sessions. Use this guidance when a host can expose links or delivered files. It adds one fixed system-prompt paragraph; hosts retain responsibility for file access and rendering.

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

The Web and `sdk` bundles mount this plugin independently of the `present` tool. Custom compositions need only `systemPrompt`:

```yaml
- id: deliverable-file-references
  name: '@deepseek-ai/dsh-deliverable-file-references'
```

There are no configuration fields. Mount [`dsh-tool-present`](../tool-present/README.md) separately to execute file deliveries. Disable this row to omit its guidance.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [plugin entry](src/index.ts) registers `ui:deliverable-file-references` at the shared `DELIVERABLE_FILE_REFERENCES` order. Cordis removes the section on unload. It reads no files and starts no GUI or transport.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [System prompts](../../core/system-prompt/README.md) — section assembly and ordering.
- [Present tool](../tool-present/README.md) — executable file-delivery declarations.
- [Web deliverables](../../client/ui-deliverables/README.md) — file cards and file opening.

<a id="model-experience"></a>
## Model Experience

### File-reference guidance

#### What the model sees

Each assembly includes the same static paragraph:

##### Shared guidance

```markdown
Prefer showing the primary results within your final response alongside a brief explanation. Use ![Description](<path/to/image.png>) when an image supports an explanation or comparison. Use [Description](<path/to/image.png>) when referring to an image or listing files. Enclose Markdown file destinations in angle brackets, especially paths containing spaces. Do not call present just to list edited source files, or run commands to check whether a diff view will appear. Use present to publish complete deliverables, including images, Office documents, spreadsheets, and slide decks, when separate access helps the user. Hosts that support file cards can show the presented file with preview and open actions. Avoid repeating results already shown inline unless the separate card adds useful access. Outside commands, configuration expressions, and code blocks, link every mention of an existing file, including repeats and tables, to its full path relative to the working directory or absolute; append #L24 or #L24-L30 to the target for known lines. Use the filename or a clear alias as the label, adding only enough parent directories to distinguish files; keep full paths out of labels. Default to the name alone; when precise locations matter, append :24 or :24–30, with no # or L in the line suffix.
```

#### Token effect

One fixed paragraph while mounted, with no tool schema or extra model request.

#### KV Cache effect

The paragraph stays at first-party order 9000 across turns. Mounting, removing, or changing it changes the assembled prompt prefix; it adds no per-turn values.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Guidance requires a host that supports file links or deliveries; this plugin does not implement rendering, file access, or the `present` tool.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
