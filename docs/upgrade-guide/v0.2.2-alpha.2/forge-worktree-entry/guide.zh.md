---
kind: upgrade-guide
description: "插件页将独立的 Git 工作树卡片合入变更请求与工作树。"
---

# 变更请求与工作树使用同一个插件入口

[English](guide.md) | 中文

## 变更

Web 和 Desktop 通过**变更请求与工作树**同时启用评审面板、新会话的工作树选项和模型的 `create_worktree` 工具。独立的 **Git 工作树**卡片被隐藏。已经启用 Forge 组合包的 profile 也会新增模型工具。

已有 profile 不会自动迁移。选中的 `@deepseek-ai/dsh-experimental-tool-worktree` 组合包仍会运行，即使其卡片已隐藏，因此关闭 Forge 不会停用这个独立工具。同时选择它和 `@deepseek-ai/dsh-experimental-forge-bundle` 会插入重复的 `worktree` 与 `tool-worktree` id，使对应组件控件变为只读。使用统一开关前，请移除独立组合包的选择。

## 迁移

1. 停止 Web 或退出 Desktop。备份 `$DSH_HOME/profiles/<name>/package.json` 及同目录下的 `cordis.patch.yml`。未设置 `DSH_HOME` 时使用 `~/.dsh`；标准 profile 名称为 `web` 和 `desktop`。自定义 profile 使用其自身名称。
2. 编辑该 `package.json` 的 `dsh.profile.bundles`。移除所有 `@deepseek-ai/dsh-experimental-tool-worktree` 条目。若要通过统一开关保留工作树功能，添加一次 `@deepseek-ai/dsh-experimental-forge-bundle`；若已选中它，则保留该条目。若要关闭两项功能，则移除这两个组合包名称。保留其他所有条目和字段。
3. 保留现有的 `cordis.patch.yml` 覆盖配置：`worktree`、`tool-worktree` 和 `optional-forge-panel` 的 id 均未改变。若只使用 Forge 面板，不向模型提供工作树工具，在现有 patch 列表中添加或更新以下条目：

   ```yaml
   - id: tool-worktree
     disabled: true
   ```

4. 重启应用。在插件页确认**变更请求与工作树**的状态符合你的选择。没有禁用插件行的覆盖配置时，启用它会提供面板与 `create_worktree`，关闭后两者均移除。确认 profile 不再列出独立的工作树组合包。已有工作树、分支和 Session 记录均保留。

仅需要独立工具的 Headless profile 和自定义组合可以继续保留它，但不要同时选择 Forge 组合包。在 Web 或 Desktop 中，该独立选择仍然隐藏，需要通过 profile 文件管理。
