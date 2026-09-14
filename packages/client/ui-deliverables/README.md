---
description: "Produced-files and clickable file references for the Web GUI: the deliverables row a finished turn ends with, and inline-code links in the closing prose; for users and maintainers of the deliverables experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-deliverables

English | [中文](README.zh.md)

## Summary

This package renders the deliverables row a finished turn ends with — the files the mutation tools created or modified — and links matching inline-code references in the closing prose, so a mentioned file opens in the right Sidebar. The linked paths come from successful mutations and explicit deliveries, never from the closing prose — a produced file is listed whether or not the model remembered to name it. The shipped Web patch is the only composition that loads this package; removing its cordis.yml entry removes the guidance, row, and prose links together.

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

Mount this plugin alongside `ui-conversation`; a finished turn then ends with the produced-files row between the closing message's body and its action footer. Each chip opens the file through the owner's `openFile`, which the chat view routes to the right Sidebar as a text-preview tab, with relative paths resolved against the session cwd. The row offers no folder action: the Sidebar has no directory form, so an omitted-file remainder is a label only.

<a id="explicit-deliveries"></a>
### Explicit deliveries

The Web `standard`, `ptc`, and `cordis` presets expose `present` for final files accessible through the Session filesystem, including files created through Bash. Call it with `files: [{ path, description? }]` after creating the files. The [present tool](../../fs/tool-present/README.md) owns file-count limits and Session declarations. The closing turn shows one delivery as a full-width card and multiple deliveries in a two-column grid with 10px gaps. A list longer than four files starts collapsed and provides a control that reveals or hides the complete list. Each 60px-high card uses 8px vertical and 10px horizontal inset spacing, a 20px shared `FileTypeIcon` in a 40px frame, 13px filename text, 10px secondary text, and a 12px Open action. It shows the basename and description, or the file type when no description exists; a trailing parenthesized suffix in the description is omitted, and hovering the card replaces that line with the Sidebar-preview action. Clicking the card or the left side of its split Open control previews the file in the right Sidebar. The chevron opens the standard menu for the Host default application plus Show in Finder on macOS, Show in File Explorer on Windows and WSL, or Open containing folder through the default Linux file manager. Matching inline-code references preview the same source files in the right Sidebar; native opening requires an explicit card-menu action. Repeated declaration of a path selects its latest description before the closing reply.

The `present` tool row shows running, delivered, failed, or interrupted status; expanding a settled row reveals its recorded result. The collapsible card grid retains every delivered file. Both menu actions share pending state and show progress, acknowledgement, or an action-specific retryable error. Desktop information is read when delivery cards appear and invalidated on connection replacement; responses from a replaced connection cannot publish metadata. Selecting a native menu action returns keyboard focus to the available Sidebar Open button. Pending actions close the menu until another explicit gesture. A missing desktop disables the Open menu; a failed desktop-information read offers Retry. It requires a desktop and a suitable default application on the serving Host; a remote browser does not open applications on its own device.

### The row

The “Files changed” row lists successful file-tool mutations; final file deliveries require `present`. The first file section starts 20px below the closing prose, a following explicit-delivery section starts 16px below the row, and the action footer starts 20px below the last file section. The row uses CSS container-width bands to show a responsive prefix of up to six file chips. Flexbox shrinks and ellipsizes basename text, while CSS selects the matching localized `+ N files` label for omitted paths; the full path remains available as the title, and the row performs no JavaScript layout observation or horizontal scrolling.

### Inline-code links

The closing prose links produced or delivered paths: an inline-code token resolves by exact path, or by being exactly the basename of exactly one such path — a basename two paths share stays inert rather than guessing, so a mention can never open the wrong file. A resolved mention keeps its code chip and takes the markdown sheet's link language, with the full path as its title.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Node half registers the static `ui:deliverable-file-references` system-prompt section asking the model to mention primary files from successful creation or modification calls and to write those and any other changed-file references as Markdown inline code. The browser half registers a wrapper around `ProducedFiles` and explicit deliveries into the chat view's `conversation.chat.turnTail` hole. `deliverablesDefinition` folds each Turn's successful first-party mutation calls into `DeliverablesTurnData` from the validated raw arguments of `write`, `edit`, and mutating `str_replace_editor` commands. Reads, deletes, unsupported tools, malformed calls, and failed results contribute nothing. A new mutation tool needs an explicit Client contribution before it joins the list. The package also provides the `chatFileMentions` service the chat view consults per closing message; composing the plugin out removes both surfaces and leaves the view's empty chain at zero cost.

Native opening uses an authenticated POST addressed by the viewed Session, event sequence, and original file index. The Host reads the viewed Session header with the declaration and passes its cwd, or the deployment workspace root when absent, to `workspaceFiles.stat`. This uses the same composed filesystem as Sidebar previews and does not activate an Agent, including for child Sessions. Native actions require the canonical process path to map from a Host path back to that same process path. Providers without this mapping return 422 and the card directs the user to Sidebar preview; a same-named Host file is insufficient. The same configured desktop availability governs metadata and execution. Edits affect subsequent opens; deletion returns an error. No file-content copy or attachment is created. Plugin disposal cancels and awaits pending native-open requests.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the deliverables surface is not enough. They move from the row to the turn-tail hole and the decisions behind the vocabulary.

- [ui-conversation](../ui-conversation/README.md) — declares the `conversation.chat.turnTail` hole and renders the closing prose.
- [Workspace file links](../../../.agents/notes/implemented/feature/2026-07-31-web-workspace-file-links.md) — the decision behind the produced-files row; its Host open path is superseded by the [right Sidebar](../../../.agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.md).
- [Inline file mentions](../../../.agents/notes/archived/feature/2026-08-07-web-inline-file-mentions.md) — the decision behind clickable mentions in the closing prose.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

### Clickable file-reference guidance

#### What the model sees

One fixed paragraph instructs the model to name primary files from successful creation or modification calls in its final response and to format those and any other changed-file references as exact-path or unique-basename Markdown inline code, such as `out/report.html`.

#### Token effect

One fixed prompt paragraph whenever this package is loaded. The [present tool](../../fs/tool-present/README.md#model-experience) owns the delivery schema and result text.

#### KV Cache effect

The section is static at first-party order 9000 for the lifetime of the package mount, so it remains in the reusable prompt prefix and does not change across Turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current deliverables vocabulary. They are current package constraints, not a general file-linking comparison or a task backlog.

- **Mention matching is exact path or unique basename only** — a suffix mention stays inert; widening the matcher is deferred until a real closing-message shape needs it.
- **Terminal-created files require explicit delivery** — call `present` to make them available as delivery cards and clickable references.
- **Declarations do not preserve file contents** — reopening or transferring a Session requires source files accessible through the viewed Session’s filesystem. Missing files, directories, and final symbolic links return 404.
- **Directories have no destination** — chips open files in the right Sidebar's text preview, which shows files only; the former native folder handoff is gone rather than replaced.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Prompt, slot, dictionary, file-action route, and optional service registrations are effect-owned; the Session log owns declarations and the filesystem owns file contents.
