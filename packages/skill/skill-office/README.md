---
description: "One progressively loaded Office skill with per-format authoring files that directs rendering, conversion, and recalculation to dedicated tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-office

English | [中文](README.zh.md)

## Summary

The catalog lists one `office` skill. Its routing instructions load on demand and end with the configured Python environment; for authoring, they direct the model to read a Word, PowerPoint, or Excel format file beside the skill. The instructions direct operations to [`office_render`, `office_convert`, and `office_recalculate`](../../document/tool-office/README.md), with shell copies of output files. The Web application and SDK profiles mount the provider; only Desktop, or an SDK with a primary runtime, also mounts the bundled dependency query.

## Table of Contents

- [Use this package](#use-this-package)
  - [Progressive loading](#progressive-loading)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the skill provider beside the skill registry and `dsh-tool-skill`. The provider supplies the `office` instructions and appends a Python environment section. The model reads the format files with a file `read` tool, so compose a filesystem tool such as [`tool-fs`](../../fs/tool-fs/README.md). The instructions direct operations to `office_render`, `office_convert`, and `office_recalculate`, so compose [`tool-office`](../../document/tool-office/README.md) beside this provider.

```yaml
- name: '@deepseek-ai/dsh-skill-office'

```

| Field | Default | Meaning |
|---|---|---|
| `assetRoot` | Packaged `assets/` | Absolute directory containing the `office` skill folder with `SKILL.md`, `docx.md`, `pptx.md`, and `xlsx.md`. |
| `pythonEnvironment` | `'workspace-dependencies'` | Python that the `office` skill and its format files direct the model to; see below. |

`pythonEnvironment` selects one fixed section appended to the `office` skill; the format files refer to it. Both values first defer to an explicit user or applicable AGENTS.md environment requirement. `'workspace-dependencies'` directs the model to call `load_workspace_dependencies` and use the bundled Python and libraries it returns; mount it only with `dsh-tool-workspace-dependencies`. A custom composition that mounts this package without `dsh-tool-workspace-dependencies` must configure `pythonEnvironment: user`. `'user'` directs the model to the project's or user's existing Python on PATH, to check that the required libraries import, and to name missing packages instead of installing them globally without the user's agreement.

A relative `assetRoot` rejects registration. Catalog discovery and loading read `office/SKILL.md` and check that `docx.md`, `pptx.md`, and `xlsx.md` beside it are regular files. A missing or invalid skill file, or a format file that is missing or not a regular file, omits the skill from the catalog with a warning that names the path, and a file that disappears after discovery fails the load and removes the skill from the catalog. Other read errors, such as a locked file, leave discovery incomplete so the registry retries it. Loading instructions resolves no executable and prepares no engine; the Office tools report an unavailable LibreOffice Kit when called. Bash or PowerShell owns the approvals, sandboxing, and cancellation of copying converted files into the workspace.

<a id="progressive-loading"></a>
### Progressive loading

The model chooses skills from the task; the host does not inject complete instructions based on file extensions. With complete resources, the `office` skill is listed and loadable through `skill` or explicit user invocation as `/office`. Its result names the skill's base directory; to create, read, or edit a document, the model reads `docx.md`, `pptx.md`, or `xlsx.md` relative to that directory, one level deep and only for the formats the task involves. Loading `office` makes the three Office tools available from the next step; when they are not in the tool list, such as after a PTC resume or fork, the instructions direct the model to load `office` again. Legacy `.doc`, `.xls`, and `.ppt` files, which python-docx, openpyxl, and python-pptx cannot read, are converted with `office_convert` before editing. Requested appearance changes, including spreadsheet cell fills and text alignment, require rendering even without an explicit visual-check request, and so do new or changed slide content in presentations; an explicit request to skip rendering takes precedence. Standalone operations use the dedicated tools after routing without reading a format file. PDF export alone stops after checking that the copied output is nonempty and starts with `%PDF-`.

```mermaid
flowchart TD
    A["Initial catalog: one Office summary"]
    A -->|Non-Office task| N["Continue without loading Office instructions"]
    A -->|Office task| B["skill(office): task routing"]

    B -->|Create or edit| C["read(docx.md / pptx.md / xlsx.md)"]
    C --> D["Author and validate content, structure and data"]
    D -->|No additional operation needed| F["Deliver"]

    B -->|Images, visual inspection, appearance or slide changes| R["office_render: images in the tool result"]
    D -->|Images, visual inspection, appearance or slide changes| R
    R --> V["Inspect requested images"]
    V --> F

    B -->|Formula recalculation| X["office_recalculate, shell copy"]
    D -->|Formula recalculation| X
    X --> F

    B -->|PDF export| P["office_convert, shell copy"]
    D -->|PDF export| P
    P --> F
```

Documents and workbooks render only for requested images, visual inspection, or appearance changes, because their libraries verify content and Word reflows text. Presentations also render new or changed slide content, because python-pptx cannot measure text fit in fixed-size boxes; speaker-notes edits do not render. Preview images arrive in the `office_render` result, so no workspace files are created for inspection; replies report the inspection in text. Converted and recalculated files arrive as temporary paths that the model copies into the workspace with `cp` or `Copy-Item`. Loaded instructions remain in session history after an operation finishes. The diagram describes ordinary presets across supported clients; it does not change the shell-only definition of minimal or sdk-minimal.

Ordinary Word text edits inspect the target runs and formatting, then reopen the saved document to verify the edit. Successful checks end validation; package and metadata investigation requires a concrete problem or an explicit request.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider reads the description during catalog discovery and the body on demand. Registry precedence, scope, and invocation permissions apply to the skill, so a higher-precedence skill named `office` replaces the bundled instructions and their format-file routing. The loaded skill includes its resource directory for relative references; the provider checks the format files but does not read them. Disposal unregisters the candidate.

The provider registers no tools or activation projection. Loaded skill results remain logged through the generic skill loader. In PTC programs, print or return the full `tools.skill(...)` result so its instructions reach the model. Resume and fork use existing session history and tool declaration reconciliation. Loading a skill resolves no executable.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider registration, per-skill resource reads, and the appended Python environment section. |

| [`assets/office/`](assets/office/) | `SKILL.md` routing instructions and the `docx.md`, `pptx.md`, and `xlsx.md` format files. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Skill registry](../skill/README.md) — discovery and precedence.
- [Skill tool](../tool-skill/README.md) — model catalogs and loaded bodies.
- [File delivery](../../deliverables/tool-present/README.md) — current source-path delivery.
- [Office tools](../../document/tool-office/README.md) — rendering, conversion, and recalculation.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders the one-line `office` summary in the catalog and returns the routing instructions from `skill(office)`, and through the `read` tool, which returns a format file. The routing instructions end with a Python environment section that names either `load_workspace_dependencies` or the user's existing Python, according to `pythonEnvironment`; the format files refer to that section.

#### KV Cache effect

Skill and `read` results append to history, and loaded text or images remain after an operation finishes. With `tool-office` mounted, the first successful `office` load enables the three tool declarations on the next step; reading a format file does not. A skill omitted or removed for an unreadable skill file changes the catalog, which a later step publishes as a catalog update. Character estimates use `ceil(characters / 4)`: the summary is at most 50 tokens and the routing body, without the Python environment section, at most 230; the complete `office` body plus one format file is at most 230 tokens more than 70% of the recorded earlier estimate of that format's skill: 1,688 tokens for Word, 1,879 for PowerPoint, and 2,330 for Excel. The appended Python environment section stays fixed while the configuration stays unchanged, and counts toward the `office` body. The line-number prefixes that `read` adds are outside these estimates. Skill wrappers, the generic catalog, shell and Office tool declarations, and `load_workspace_dependencies` are separate costs, and these estimates are not server usage.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The provider does not install authoring libraries.
- LibreOffice output can differ from native Office applications.
- Legacy, encrypted, and macro-enabled files need an appropriate separate workflow.
- An omitted skill is reported only through `ctx.logger`; no product UI tells the user that installed resources are missing (tracking issue #7677).
- The resource directory is a Host path, while the model's `read` goes through the Session's current filesystem service (`ctx.fs`). With SSH or another filesystem backend that cannot reach Host files, `read` cannot open the format files, so only the `office` body's guidance reaches the model.
- A skill whose skill or format file is missing or whose metadata is invalid counts as a persistent failure, so the skill catalog is cached without it; restoring the file does not list the skill until the application restarts or the plugin reloads.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
