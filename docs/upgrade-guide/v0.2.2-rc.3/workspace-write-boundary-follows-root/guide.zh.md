---
kind: upgrade-guide
description: "workspace-write 边界跟随 Session 的工作区根而不是原始项目，链接 worktree 的 Git 目录变为可写。"
---
# `workspace-write` 边界跟随 Session 的工作区根

[English](guide.md) | 中文

## 变更

`ctx.sandboxPolicy.resolve({ session })` 返回的 `workspaceRoot` 是 Session 的工作区根，即它所在的检出目录。此前整个 Session 期间返回的都是 Session header 记录的原始项目。通过 `enter_worktree` 或 forge 的"新建工作树"选项进入 worktree 的 Session 现在只能在该 worktree 内写入；原始项目不再整体可写。Host 每次移动 Session 的目录，边界都随之移动，包括 SDK 的 `setWorkingDirectory`（Python 中为 `set_working_directory`）以及通过 `ctx.subagents.start({ cwd })` 启动的子代理；本版本之前记录的 `working-directory/change` 不移动边界。

对于链接 worktree，策略从检出目录的 `.git` 指针推导出仓库公共目录，只接受 Git 写出的 `<common>/worktrees/<name>` 布局及其 `commondir`、`gitdir` 指针，并加入 `additionalWritableRoots`，因此在 `workspace-write` 下可以在 worktree 内运行 `git commit` 与 `git checkout`。该授权也覆盖共享的 `.git/hooks` 与 `.git/config`，与主检出目录中的 Session 此前拥有的权限相同。在 Windows 上只有 harness 的 `write` 与 `edit` 工具执行该授权；受限进程保留工作区与私有临时目录权限。

文件树、目录列举与监听、交付物与变更摘要、新开的侧栏终端、`@` 文件补全、技能目录、项目指令发现和 LSP 工作区读取同一个根。`WorkspaceChangesSummary.cwd` 由 `root` 取代，`TerminalEnvironment.cwd` 表示该根。

受影响者：依赖 worktree Session 仍可写入原始项目的运维人员、通过 `additionalWritableRoots` 授权 worktree `.git` 的部署，以及读取 `WorkspaceChangesSummary.cwd` 的 Host 插件。

## 迁移

1. 从 `cordis.yml` 中删除只为链接 worktree 的 `.git/worktrees/<name>` 或公共 `.git` 目录而设置的 `additionalWritableRoots` 条目；保留无关目录的条目。
2. 任务在进入 worktree 后仍需写入原始项目时，用 `exit_worktree()` 或 forge 面板的“在项目中继续”离开，或让 Session 留在原始项目中；边界跟随该变更。SDK 客户端若只是为了改变相对路径的解析位置而移动目录，请改传绝对路径或 shell 的 `workdir`。
3. 在消费 `ctx.workspaceChanges.summary` 的 Host 插件中，把对 `WorkspaceChangesSummary.cwd` 的读取改为 `root`。
4. 确认：在链接 worktree 内打开的 Session 中，`workspace-write` 下 `git commit` 成功；`enter_worktree` 之后，对 worktree 之外原始项目的写入被拒绝。推导出的 `.git` 授权不出现在运行时上下文中，上下文只列出配置的额外目录。
