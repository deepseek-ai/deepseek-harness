# Agent Note: Language-neutral default Workspace naming

Status: implemented

English | [中文](2026-09-23-language-neutral-default-workspace-naming.zh.md)

## Problem

[First-use default Workspace](2026-09-20-default-workspace.md) let the Client pick both the directory name and the stored title from its startup language: Chinese installations created `默认工作区`, English ones `Default workspace`, everything else `default-workspace`. The name a reader sees and the name written to disk were the same string, so one product decision carried two incompatible requirements. A path is addressed by shell commands, tool arguments, `@path` references, session logs, and backups, and must not depend on which language happened to be active when the installation started. A label is read, and should be in the reader's language. Switching language afterwards satisfied neither: the path was already fixed, and so was the label derived from it.

## Decision

The directory name and the stored title are one fixed, language-neutral string; only the on-screen label follows the reader's language.

`DEFAULT_WORKSPACE_DIRECTORY` (`default-workspace`) is owned by the [Workspace controller](../../../../packages/api/workspace-controller/README.md#first-use-workspace) and published from its own `./default-workspace` subpath — a pure fold with no imports, so client bundles inline it rather than requesting a module-table row the package does not publish. The Host joins it under `<Documents>/deepseek-harness`, and the registry titles the Workspace after the canonical directory's final segment, so the automatic title *is* that same name with no second source to keep in step.

`workspace.initializeDefault` therefore takes no request at all; `WorkspaceInitializeDefaultRequest` and its name validation are deleted, and the registry's resolver returns a path instead of a path and title. No language reaches the Host, so nothing there can disagree with the Client about naming.

Browser consumers label one Workspace through `workspaceDisplayTitle(title, localizedDefault)`: a title still equal to the automatic one reads as the localized default name, and every other title reads verbatim. The name lives in the `common` locale namespace (`workspace.defaultName`) because two packages show it — the Workspace browser resolves it once at the store read so rows, hover card, search meta, and the rename and delete dialogs all inherit it, and the Conversation workspace chip resolves it for the hero.

A rename is what stops a row following the language, and needs no stored flag: the dialog is seeded with the label on screen while the *stored* title decides whether confirming saves. The two differ for a Workspace still carrying its automatic title, so confirming the untouched prefill is a real rename that pins that name. Self-exclusion in the duplicate check moved to Workspace identity for the same reason — the seeded label equals the row's own displayed title without being a conflict with itself.

## Alternatives considered

- Marking the never-renamed state on `WorkspaceView` (a boolean the Host derives from `defaultWorkspaceId` plus the automatic title) removes the false positive below, but widens a shared transport type to carry presentation state the Host has no other use for. Comparing the stored title is the same test with no wire surface.
- Localizing the title inside the Client Workspace store would cover every consumer at one point, but a store that returns product copy owes the locale revision a re-projection and puts copy outside the `t` seat the i18n gate checks.
- Keeping the localized directory name and adding a separate stored title preserves the old path spellings, but leaves every installation's path decided by its first language — the defect this note exists to remove.
- Renaming an existing localized directory on language change would break recorded session `cwd`s, tool arguments, and `@path` references for a cosmetic gain.

## Consequences

Installations created before this change keep their existing localized directory and title. Nothing renames or relocates them; their titles no longer match the automatic name, so they read verbatim — which is what a user who never renamed a Chinese installation already saw.

A Workspace whose stored title is exactly `default-workspace` is labeled as the default even when it is not the registry's default — a folder of that name adopted from the picker, or a rename to that literal. Nothing but the label depends on the distinction. The Workspace browser's client-side duplicate-title check compares localized titles, so it reports a conflict for a second Workspace named the localized default while the Host, comparing stored titles, would allow it; refusing two rows that read identically is the better answer, and the Host still owns the authoritative uniqueness check.

Two *Session* labels derived from a working directory keep showing the raw path segment, because they name a directory rather than a Workspace: the Session Controller's `displayTitleOf` falls back to the cwd basename for a Session with no durable title, and the sidebar's search-result metadata falls back the same way for a Session with no owning Workspace. Both read `default-workspace` where they previously read the localized name. Routing them through `workspaceDisplayTitle` would spread the automatic-title test into Session naming for a case the Session title generator almost always fills in first.
