# Agent Note: Present declares workspace source files

Status: implemented

English | [中文](2026-09-08-present-workspace-source-files.zh.md)

## Problem

Users need to open and edit the files produced in their workspace, including shell-created files that have no editor mutation records. Preserving an independent delivered version adds content storage, copy verification, temporary-file retention, and a second editing destination to this workflow.

## Decision

The [present tool](../../../../packages/fs/tool-present/README.md) declares existing regular source files under the [Session filesystem access policy](2026-09-09-present-filesystem-access.md). It records paths and optional descriptions without reading or copying contents. The [deliverables plugin](../../../../packages/client/ui-deliverables/README.md) opens current workspace sources in the Host's default application. Edits are visible on the next open; deletion or movement makes the declaration unavailable. File-content preservation and copy-on-write storage are deferred until a persistence design owns them.

The tool description requires `present` after writing a file the user asked to receive and before the final response, including files created through Bash or code execution. A prose path reference does not replace the call. The recorded [SVG delivery scenario](../../../../snapshots/web/present-svg/snapshot.yml) uses a user request that does not name `present`, and checks the resulting file, delivery event, and card. Its UI snapshot covers the expanded Chat transcript; navigation and composer controls belong to their own scenarios, so unrelated chrome changes cannot invalidate file-delivery expectations.

The tool remains an ordinary package with shared filesystem and tool error classes. Its pure type entry owns the delivery event without importing Host code into the browser. The `standard`, `ptc`, and `cordis` presets mount it; `minimal` retains its two tools. Each plugin instance correlates its executions with successful final `tools/result` notifications before appending `deliverables/presented`. Native and nested calls share this rule. A later enclosing program failure does not revoke a completed nested declaration; blocked results publish none, and same-name scoped replacements cannot publish another instance's results.

An authenticated POST selects a declaration by viewed Session, event sequence, and original file index. The event carries no owning Session ID; relative paths in inherited history resolve against the viewed Session's workspace. The Host verifies regular-file existence and Host-path mapping before native opening. Route disposal cancels and awaits pending commands. The “Files changed” row lists successful file-tool mutations and retains its separate text-preview behavior. Its Chinese label is “本轮文件改动”; neither label implies final delivery.

File cards use the same split-control pattern as the Session header. The card and the left Open segment preview the source in the right Sidebar; the chevron opens the standard menu for default-app and file-manager actions. The Host selects the file in Finder or Explorer, or opens its containing folder through the default Linux file manager. Both native actions resolve the same saved declaration and verify the Session filesystem and Host path; neither accepts a browser-supplied replacement path. Host-derived desktop metadata keeps remote-browser labels and availability honest, and the route enforces the configured availability on each native gesture. One delivery spans the row; multiple deliveries use at most two columns, retain every declaration, and collapse after the first four cards until the user expands the list. Desktop metadata is invalidated with the connection generation so an old Host cannot keep native actions disabled or supply the wrong file-manager labels. Old metadata requests are cancelled and cannot replace the new generation’s response.

## Alternatives considered

**Immutable attachment snapshots and editable temporary copies** preserve delivered versions after source edits or deletion, but make desktop edits diverge from workspace files and introduce retention work without a current product requirement. This decision supersedes the [snapshot-delivery design](../../archived/feature/2026-09-08-web-explicit-file-delivery.md). Neither a download endpoint nor a fallback copy remains; both require an explicit future product decision.

**Opening attachment-store files directly** lets editors mutate immutable objects. A future persistent delivery system needs an owned editing and retention policy, such as copy-on-write, before exposing saved versions to applications.

**Generic artifact fields or a Host tool subpath inside the UI package** broaden unrelated APIs or couple preset installation to browser packaging. A tool-owned event and ordinary package preserve existing extension points and publication rules.

**Tool text as the durable index** cannot survive post-processing or result spill reliably. Execution identity and final successful results retain declaration ownership independently of displayed tool text.

**Descriptor-bound filesystem extensions** would change every provider without making an external desktop application's later path lookup atomic. Current checks verify file metadata and path mapping; concurrent swap-and-restore remains outside the path API's guarantees.

## Consequences

The Session log persists declarations but no attachment references or file contents from `present`. Session ZIP exports contain these declarations; transferring the log does not transfer workspace files. The event remains required-on-read because silently losing delivery declarations would alter reconstructed or forked history. Released Session format generations remain unchanged.

The removed file-size cap has no role in a metadata-only declaration; the configurable file-count limit still bounds result size. Cards show file names and descriptions, falling back to file types, without stale byte-size metadata. No artifact service or speculative storage fallback is introduced.

Focused tests cover content-free declarations, invalid inputs, blocked results, source-path identity, current bytes after edits, missing files, external paths and unavailable Host mappings, fork-relative paths, retry, cancellation, and disposal. The recorded Web scenario covers nested completion followed by enclosing failure, source edits, reload, deletion errors, card and prose opens without browser downloads, and content-free Session export.
