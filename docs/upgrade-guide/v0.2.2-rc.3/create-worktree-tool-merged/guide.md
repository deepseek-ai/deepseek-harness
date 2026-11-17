---
kind: upgrade-guide
description: "The `create_worktree` model tool is removed; `enter_worktree` creates a worktree or enters an existing one of the same name."
---
# `enter_worktree` replaces `create_worktree`

English | [中文](guide.zh.md)

## Change

The experimental package `@deepseek-ai/dsh-experimental-tool-worktree` no longer registers the model tool `create_worktree`. Its replacement `enter_worktree({ name?, from? })` moves the Session into a worktree in the pool of the checkout it is in, `.agents/worktrees/` by default:

- When the pool holds a registered worktree named `name`, the call enters it and changes neither Git state nor files. `create_worktree` failed for an existing name.
- Otherwise the call creates a new branch and checkout from `from`, HEAD by default, and enters it, as `create_worktree` did. Omitting `name` creates one with a generated name.
- `from` asks for a new worktree: with a name that is taken, the call fails with `WORKTREE_ALREADY_EXISTS`.

The result adds `created`, true for a new worktree. A result for an existing worktree has no `baseCommit`, and no `branch` when its HEAD is detached. `exit_worktree` leaves either kind and returns the Session to the checkout it came from.

`ctx.worktrees.create` keeps its behavior; the new `ctx.worktrees.enter(agent, { name })` enters an existing worktree.

Who observes it: prompts, skills, and evaluation sets that name `create_worktree`; PTC programs that call `tools.create_worktree`; Host code that reads the tool result. A stored Session keeps its recorded `create_worktree` calls as history, and a new call returns `unknown tool "create_worktree"`.

## Migration

1. Replace `create_worktree` with `enter_worktree` in prompts, skills, scripted model turns, and PTC programs. The parameters `name` and `from` keep their meaning.
2. Where a task needs a fresh worktree and the name may be taken, pass `from` or omit `name`, so an existing worktree is not entered silently. Otherwise read `created` in the result.
3. Where code reads the tool result, treat `baseCommit` and `branch` as optional.
4. Confirm: with the worktree bundle enabled, the tool list of a first request contains `enter_worktree` and `exit_worktree` and no `create_worktree`.
