# Agent Note: Resident office tool for Office operations

Status: implemented

English | [中文](2026-10-31-native-office-tool.zh.md)

## Problem

Office operation skills ran the LibreOffice Kit CLI through ordinary shell commands, as [progressive Office skills](2026-09-27-progressive-office-skills.md) decided. Kit's native engine starts helper processes, Workers, and font caches that the shell sandbox and PTC permissions restrict, so the same render could succeed in one deployment and fail in another. Each deployment had to publish a standalone Node executable and a CLI path into the skill body, which required Node and CLI configuration, a Python sidecar Node, an Electron check against the application binary, and a runtime-root containment check against the Electron shell's own Kit. Rendering for inspection wrote PNG files into a temporary workspace directory that the model then read with `read_image` and deleted, adding calls and cleanup obligations to every visual check.

## Decision

The [`office` tool](../../../../packages/document/tool-office/README.md) exposes `render`, `convert`, and `recalculate` as one resident Host tool. It calls the [Office kit](../../../../packages/document/office-kit/README.md) service, which loads Kit in the Host process through `/locate` and runs every operation through the queue, concurrency limits, byte reservations, and cache that Office previews use. Tool requests use `foreground` priority, the class of an open preview, so background prewarming cannot starve them. The SDK composition mounts the tool beside `office-kit`, and the Web bundle's standard and PTC agent presets mount it while its minimal preset keeps its fixed roster; when Kit is missing the tool stays registered and every call returns the service's `unavailable` message. The tool reads the service at each call instead of injecting it, so a composition that omits or disables `office-kit` still creates Sessions with the tool and each call fails as `unavailable`; a service loaded later serves the next call. Standard and PTC modes reach the same registration; nested PTC calls re-enter the ordinary execution pipeline.

`render` returns PNG images in the tool result. The tool commits them through the attachment store before the result is logged, so the model-visible images are reconstructable from the Session log, resume and fork restore them, and image offload applies to them. The complete result is bounded by image count, per-image pixels and dimensions, and total PNG bytes, each the lower of the tool configuration and the attachment store's limits; an over-limit selection fails instead of being truncated. A route without image input is refused before rendering.

`convert` and `recalculate` do not write into the workspace. The filesystem service intentionally provides only binary reads, and binary files in the workspace come only from the shell, whose sandbox and approvals already govern writes. The Office kit saves each output in an owner-only directory under its configurable `outputDirectory` (`$DSH_HOME/office-kit/outputs` by default), grouped by the root Session of the caller's subagent tree, and deletes it after `outputRetentionMs`, when `maxOutputStoreBytes` needs room for newer outputs, when that root Session is disposed, or when the provider unloads. A subagent's output therefore outlives the subagent, so the delegating agent can still copy it. The tool returns the absolute temporary path, format, size, and PDF page count with the instruction to copy the file with the shell now, because it is deleted when the conversation ends. A filesystem backend that cannot read Host paths, such as an SSH workspace, refuses these two operations before converting, because a remote shell cannot read the Host output store. Shell sandboxes allow reads of the Harness home on macOS Seatbelt, Linux bubblewrap, and Linux Landlock, so a confined shell can copy the file into the workspace.

The tool is resident rather than activated with an Office skill, and no skill wraps a single operation. Its schema is short and fixed, and the model-facing description names only task concepts. The demand-loaded [Office router and format skills](../../../../packages/skill/skill-office/README.md) name the `operation` to call and keep the when-to-render guidance; a standalone render, recalculation, or PDF export loads only the router. The skills no longer carry executable paths, so `skill-office` has no Node, CLI, or Kit location configuration, `/locate` has no CLI resolver, Desktop and the bundles publish no Office executable variables, and the Python sidecar's standalone Node remains only for the Python `deepseek_harness.office` module.

This decision partially supersedes [progressive Office skills](2026-09-27-progressive-office-skills.md): its router and format skills remain current, while its operation skills, ordinary-shell execution, and rejection of a dedicated renderer tool are replaced here.

## Alternatives considered

**Keep shell execution of the Kit CLI.** It reuses shell approvals and process management, but the native engine runs restricted under shell sandboxes and PTC permissions, and every deployment must maintain Node and CLI paths, an Electron Node check, and runtime-root containment.

**Keep one skill per operation.** Separate render, recalculation, and PDF export skills add a `skill` call before each standalone operation and repeat what the tool schema and results already state.

**Activate the tool only with the Office skills.** Step-owned `when` activation would remove the schema from ordinary requests, but adding or removing a tool declaration changes the request prefix and forces KV cache recomputation, and recording when it applies would need its own Session projection. A short resident schema costs a fixed amount per request instead.

**Write converted files into the workspace from the Host.** This saves the shell copy, but needs binary creation in the filesystem service or a second write path beside it, both of which would duplicate the shell's sandbox and approval decisions for workspace writes.

**Return converted files through the system temporary directory.** Linux bubblewrap mounts a private `/tmp` for confined shells, so the shell could not read the file there; the Harness home is readable under every local shell sandbox.

**Return image files instead of image content.** Saving PNGs for a later `read_image` call keeps one image path for all tools, but repeats the temporary-directory workflow this change removes and adds a call per inspection.

## Consequences

Visual inspection takes one tool call and no cleanup, and its images follow the Session's attachment, offload, and replay rules. The `office` schema adds a fixed cost to every request that mounts it, independent of whether Office skills load. Office operations behave the same in standard and PTC modes and across deployments, and the deployment-specific Node, CLI, and containment code is gone.

Converted files need a shell copy; compositions without a shell tool can render but cannot deliver converted files, and remote workspaces cannot convert at all. Temporary outputs disappear after retention or root Session disposal, so a resumed Session must convert again. Saving page images as files is not offered.

Verification covers the tool's schema, results, argument rules, limits, failures, cancellation, PTC dispatch, and disposal in its package tests; the output store's retention, eviction, release, and sweeping in Office kit tests; Loader compositions that return the `unavailable` message with Kit absent and with the `office-kit` row absent, then reach the service once the row loads; packaged Desktop smoke checks that render, convert, and recalculate real DOCX, XLSX, and PPTX files through the service; and recorded headless sessions whose tool declarations and loaded Office skills name the `office` tool, including a render that the tool refuses for a route without image input.
