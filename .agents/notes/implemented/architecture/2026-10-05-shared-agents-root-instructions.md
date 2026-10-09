# Agent Note: Shared agents root joins the user-global instruction chain

Status: implemented

English | [中文](2026-10-05-shared-agents-root-instructions.zh.md)

## Problem

DSH loads one user-global instruction file, `$DSH_HOME/AGENTS.md`. People who run several agent tools keep the instructions they share across those tools in the shared agent configuration root (`~/.agents/AGENTS.md`, or `$DSH_AGENTS_HOME`) that `dsh-skill-filesystem` already scans for skills. Those instructions reached DSH only when the person copied or symlinked them into the harness home, which duplicates one source of truth into DSH-owned data and leaves no way to tell which copy a session loaded.

## Decision

The user-global instruction scope has two ordered roots: `$DSH_HOME/AGENTS.md` first, then `<agentsHome>/AGENTS.md`. The instruction loader resolves the harness home from `$DSH_HOME` or `~/.dsh`, and `agentsHome` from `$DSH_AGENTS_HOME` or `~/.agents`. `resolveAgentsHome` and `agentsHomeDisplay` in `dsh-home-paths` own that resolution for both `dsh-agent-instructions` and `dsh-skill-filesystem`, so the shared root has one resolver whose tilde expansion and blank-environment handling match the harness home.

The two files are candidates of one candidate group. They deduplicate by trimmed content, so identical copies render once from the harness home, and an unobservable candidate preserves the group's last-good state. A duplicate of budget-retained content keeps being reconciled, so deleting or changing the retained candidate promotes it; a byte-budget omission leaves that candidate and its content duplicates unprobed. The harness-home file keeps the `user-global` scope key that earlier sessions recorded; the shared file carries `agents-global`, and reconciliation probes both roots on resume, so an external edit, a removal, or a newly created file appears as a change notice instead of a new baseline.

A user-global scope directory is an internal reconciliation key, so it stays out of model-visible prose: a global delta states `These user-global instructions apply to all work.` instead of naming a scope directory, and a project path whose first component would collide with one renders with a leading `.` so it keeps its own scope.

`USER_GLOBAL_DIRECTORIES` fixes the root order, and discovery, baseline reconciliation, and deduplication all iterate it. The harness home therefore decides content duplicates and keeps its position in the baseline, while distinct content from the shared root follows it.

## Alternatives considered

**Replace the harness-home file with the shared root.** The harness home owns DSH-specific configuration, and its `AGENTS.md` is the user-global file the package documents, tests, and renders today. Removing it would drop a DSH-only layer for anyone who shares instructions across tools, and sessions that recorded `user-global` state would lose their referent.

**Load the shared root only when the harness-home file is absent.** The two files then alternate as the session-visible user-global file, which makes a DSH-specific file silently suppress the shared one instead of composing with it.

**Load the shared file as a second candidate name in the harness home.** `instructionFileCandidates` names files within one directory; the two roots are different directories, so the option cannot express this chain without redefining candidate semantics.

**Rely on path identity instead of content for the duplicate case.** The common layout is `$DSH_HOME/AGENTS.md` symlinked to `~/.agents/AGENTS.md`, which is two paths for one file. Path identity drops neither, so the same text would render twice under two display labels.

## Consequences

- Shared instructions load without a copy or symlink, and the symlinked layout still renders once, from the harness home.
- A session that started before this change receives one transition when the shared file exists with content that differs from the harness-home file.
- `dsh-agent-instructions` exposes no `dshHome` or `agentsHome` config field; its two roots are process policy. `dsh-skill-filesystem` retains its explicit home fields, which select that provider's own skill roots.
- The two user-global files share one fate on probe failure: the group preserves its last-good state together, because one digest decides which member renders.
- `packages/context/agent-instructions/tests/agent-instructions.spec.ts` pins the two-root order, content deduplication, duplicate promotion after the retained candidate changes or disappears, the global delta wording, the `replace` and `remove` transitions, `$DSH_AGENTS_HOME` resolution, the `~/.agents` display label, and the escaped project directory name.
