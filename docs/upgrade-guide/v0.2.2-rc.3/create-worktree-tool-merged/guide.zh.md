---
kind: upgrade-guide
description: "模型工具 `create_worktree` 被移除；`enter_worktree` 创建工作树，或进入同名的已有工作树。"
---
# `enter_worktree` 取代 `create_worktree`

[English](guide.md) | 中文

## 变更

实验性包 `@deepseek-ai/dsh-experimental-tool-worktree` 不再注册模型工具 `create_worktree`。取代它的 `enter_worktree({ name?, from? })` 把 Session 移入它所在检出的工作树池（默认 `.agents/worktrees/`）中的工作树：

- 池中已有名为 `name` 的已登记工作树时，调用进入该工作树，不改变 Git 状态和文件。`create_worktree` 在名称已存在时失败。
- 否则调用从 `from`（默认 HEAD）创建新的分支与检出目录并进入，与 `create_worktree` 相同。省略 `name` 时用生成的名称新建。
- `from` 表示要新建工作树：名称已被占用时，调用以 `WORKTREE_ALREADY_EXISTS` 失败。

结果新增 `created`，新建工作树时为 true。进入已有工作树的结果没有 `baseCommit`，其 HEAD 分离时也没有 `branch`。`exit_worktree` 可以离开这两种工作树，把 Session 送回它来自的检出。

`ctx.worktrees.create` 的行为不变；新增的 `ctx.worktrees.enter(agent, { name })` 进入已有的工作树。

受影响的对象：提到 `create_worktree` 的提示词、技能与评测集；调用 `tools.create_worktree` 的 PTC 程序；读取工具结果的 Host 代码。已存储的 Session 中记录的 `create_worktree` 调用仍是历史，新的调用返回 `unknown tool "create_worktree"`。

## 迁移

1. 在提示词、技能、脚本化的模型轮次和 PTC 程序中，把 `create_worktree` 替换为 `enter_worktree`。参数 `name` 与 `from` 的含义不变。
2. 任务需要全新的工作树而名称可能已被占用时，传入 `from` 或省略 `name`，避免无提示地进入已有的工作树。其他情况读取结果中的 `created`。
3. 读取工具结果的代码要把 `baseCommit` 与 `branch` 当作可选。
4. 确认：启用工作树组合包后，首个请求的工具列表中有 `enter_worktree` 与 `exit_worktree`，没有 `create_worktree`。
