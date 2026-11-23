---
kind: upgrade-guide
description: "workspace-write 边界跟随 Session 的工作目录而不是原始项目，因此 worktree 中的 Session 不再能写入原始项目。"
---
# `workspace-write` 边界跟随 Session 的工作目录

[English](guide.md) | 中文

## 变更

`ctx.sandboxPolicy.resolve({ session })` 返回的 `workspaceRoot` 是 Session 的工作目录，即它所在的检出目录。此前整个 Session 期间返回的都是 Session header 记录的原始项目。通过 `enter_worktree` 或 forge 的"新建工作树"选项进入 worktree 的 Session 现在只能在该 worktree 内写入；原始项目不再可写。Host 每次移动 Session 的目录，边界都随之移动，包括 SDK 的 `setWorkingDirectory`（Python 中为 `set_working_directory`）以及通过 `ctx.subagents.start({ cwd })` 启动的子代理；本版本之前记录的 `working-directory/change` 不移动边界。

仓库的 Git 目录位于链接 worktree 之外。因此在 `workspace-write` 下，`git add`、`git commit` 等写入它的命令在 worktree 内会被拒绝，除非有授权覆盖该目录。此前，位于原始项目内的 worktree 共用项目的边界，其中包含 `.git`。策略不读取任何 Git 文件；worktree 服务挂载[链接工作树授权](../../../../packages/experimental/sandbox-policy-git/README.zh.md)，它在 Windows 之外注册该目录。

文件树、目录列举与监听、交付物与变更摘要、在应用中打开操作和 Session 行读取同一个目录。`WorkspaceChangesSummary.cwd` 是该轮次开始时所在的目录，不再是原始项目。

受影响者：在没有该授权时于 `workspace-write` 下从 worktree Session 提交的运维人员与模型、依赖 worktree Session 仍可写入原始项目的运维人员，以及把 `WorkspaceChangesSummary.cwd` 当作原始项目读取的 Host 插件。

## 迁移

1. 没有 worktree 服务时，要让 worktree Session 在 `workspace-write` 下提交，请在 `cordis.yml` 中把仓库的 Git 目录（例如 `/repo/.git`）加入 `@deepseek-ai/dsh-sandbox-policy` 的 `additionalWritableRoots`，或在 Host 插件中用 `ctx.sandboxPolicy.registerWritableRoot(session, directory)` 为单个 Session 注册。该授权也覆盖 `.git/hooks` 与 `.git/config`，只用于可信任务。Windows 的进程忽略额外可写目录，因此该授权在 Windows 上对 `git` 不生效。没有生效的授权时，在启用审批的环境里模型会为每条这类命令请求提权。
2. 任务在进入 worktree 后仍需写入原始项目时，用 `exit_worktree()` 或 forge 面板的“在项目中继续”离开，或让 Session 留在原始项目中；边界跟随该变更。SDK 客户端若只是为了改变相对路径的解析位置而移动目录，请改传绝对路径或 shell 的 `workdir`。
3. 在消费 `ctx.workspaceChanges.summary` 的 Host 插件中，从 Session header 的 `cwd` 读取原始项目；`WorkspaceChangesSummary.cwd` 是所列 `path` 值相对的目录。
4. `cordis.yml` 若用沙箱策略的 `workspaceRoot` 限定 header 没有目录的 Session，请把 `@deepseek-ai/dsh-working-directory` 的 `defaultDirectory` 设为同一目录；现在由该目录限定这些 Session。
5. 确认：`enter_worktree` 之后，对 worktree 之外原始项目的写入被拒绝；在 macOS 或 Linux 上，worktree 内的 `git commit` 成功。
