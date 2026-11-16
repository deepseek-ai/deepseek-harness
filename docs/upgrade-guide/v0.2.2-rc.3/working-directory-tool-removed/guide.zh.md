---
kind: upgrade-guide
description: "模型工具 `working_directory`、它的包以及子代理工具的 `cwd` 参数被移除；只有 Host 操作移动 Session 的目录。"
---
# `working_directory` 工具与子代理的 `cwd` 参数被移除

[English](guide.md) | 中文

## 变更

模型工具 `working_directory` 及其包 `@deepseek-ai/dsh-tool-working-directory` 不再存在；`dsh-base` 与 `dsh-sdk-minimal` 组合包不再挂载 `tool-working-directory` 条目。`@deepseek-ai/dsh-tool-subagent` 注册的委派工具以及 `subagent_oar` 不再接受 `cwd`：子代理从调用方的工作区目录启动。

Session 的目录现在只通过 Host 操作改变：`enter_worktree`、新增的 `exit_worktree`、forge 面板、SDK 的 `setWorkingDirectory`（Python 中为 `set_working_directory`），以及目录消失时的恢复。每次变更都记录为 `workspace-root/change`；[持久化记录](../../../persistence-changes/2026-11-13-workspace-root-change.zh.md)说明已存储日志的读法和早期版本读者的行为。已存储的 Session 在原始项目中恢复：早期版本记录的目录变更被忽略。其中记录的 `working_directory` 调用仍是历史，新的调用返回 `unknown tool "working_directory"`。

受影响的对象：期望工具列表中有该工具或该参数的提示词、技能与评测集；引用 `tool-working-directory` 条目或该包的 profile 与 patch；进入过工作树或模型切换过目录的已存储 Session。

## 迁移

1. 从 profile、patch 和包清单中移除 `tool-working-directory` 行与 `@deepseek-ai/dsh-tool-working-directory` 依赖。仍然引用该条目的 patch 在加载时报告 `patch: entry "tool-working-directory" not found`。
2. 在提示词、技能和脚本化的模型轮次中，把 `working_directory({ cd })` 替换为相对 Session 目录的路径或绝对路径，命令使用 `bash` 或 `pwsh` 的 `workdir` 参数。读取目录改用用户上下文中的 `Current working directory:` 一行，不再调用 `working_directory()`。
3. 离开工作树时调用 `exit_worktree()`。它把 Session 送回创建或进入该工作树时所在的检出目录。要回到已有的工作树，在创建它的检出目录中调用 `enter_worktree({ name })`；[工作树工具指南](../create-worktree-tool-merged/guide.zh.md)说明该工具。
4. 从 `subagent` 与 `subagent_oar` 调用中移除 `cwd`，把子目录写进任务。需要其他起始目录的 Host 把自己选定的路径传给 `ctx.subagents.start({ cwd })`。
5. 在原始项目中恢复的已存储 Session 里，调用 `enter_worktree({ name })` 回到它的工作树。
6. 确认：`dsh --profile headless --dump-config` 不再列出 `tool-working-directory` 条目，首个请求的工具列表中既没有 `working_directory`，`subagent` 也没有 `cwd` 属性。
