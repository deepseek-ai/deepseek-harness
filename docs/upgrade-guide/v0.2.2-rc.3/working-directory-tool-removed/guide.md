---
kind: upgrade-guide
description: "The `working_directory` model tool, its package, and the `cwd` parameter of the subagent tools are removed; only Host operations move a Session's directory."
---
# The `working_directory` tool and the subagent `cwd` parameter are removed

English | [中文](guide.zh.md)

## Change

The model tool `working_directory` and its package `@deepseek-ai/dsh-tool-working-directory` no longer exist; the `dsh-base` and `dsh-sdk-minimal` bundles no longer mount the `tool-working-directory` entry. The delegation tools registered by `@deepseek-ai/dsh-tool-subagent`, and `subagent_oar`, no longer accept `cwd`: a child starts in the caller's workspace directory.

A Session's directory now changes only through Host operations: `enter_worktree`, the new `exit_worktree`, the forge panel, SDK `setWorkingDirectory` (`set_working_directory` in Python), and recovery when the directory disappears. Each change is recorded as `workspace-root/change`; the [persistence record](../../../persistence-changes/2026-11-13-workspace-root-change.md) covers stored logs and readers of earlier releases. A stored Session resumes in its original project: the directory changes an earlier release recorded are ignored. Its recorded `working_directory` calls remain history, and a new call returns `unknown tool "working_directory"`.

Who observes it: prompts, skills, and evaluation sets that expect the tool or the parameter in the tool list; profiles and patches that name the `tool-working-directory` entry or the package; stored Sessions that had entered a worktree or whose model had changed directory.

## Migration

1. Remove `tool-working-directory` rows and `@deepseek-ai/dsh-tool-working-directory` dependencies from profiles, patches, and package manifests. A patch that still names the entry reports `patch: entry "tool-working-directory" not found` at load.
2. In prompts, skills, and scripted model turns, replace `working_directory({ cd })` with paths relative to the Session directory or absolute paths, and with the `workdir` argument of `bash` or `pwsh` for commands. The `Current working directory:` line of the user context replaces `working_directory()` as the way to read the directory.
3. To leave a worktree, call `exit_worktree()`. It returns the Session to the checkout the worktree was created or entered from. To return to an existing worktree, call `enter_worktree({ name })` from the checkout it was created from; the [worktree tool guide](../create-worktree-tool-merged/guide.md) covers that tool.
4. Remove `cwd` from `subagent` and `subagent_oar` calls and name the subdirectory in the task. A Host that needs another start directory passes a path it chose itself to `ctx.subagents.start({ cwd })`.
5. In a stored Session that resumed in its original project, call `enter_worktree({ name })` to return to its worktree.
6. Confirm: `dsh --profile headless --dump-config` lists no `tool-working-directory` entry, and the tool list of a first request contains neither `working_directory` nor a `cwd` property on `subagent`.
