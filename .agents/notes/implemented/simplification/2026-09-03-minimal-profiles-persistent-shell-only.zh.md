# Agent Note: 极简 profile 只提供持久 shell

Status: implemented

[English](2026-09-03-minimal-profiles-persistent-shell-only.md) | 中文

## 问题

随附 Web `minimal` preset 与独立 `sdk-minimal` profile 在持久 shell 之外还提供 `str_replace_editor`。Shell 已经可以检查和修改文件，editor 仍会为每个极简模型请求增加第二种文件修改接口及其完整 schema。它还要求挂载一个专用 `fs-local` 服务，而两份极简组合中的其他配置项都不使用该服务。

只使用持久 shell 可以为模型提供一致的文件操作接口，并让 harness 组合与这一接口保持一致。如果保留 editor 的挂载，只通过呈现层过滤隐藏它，那么呈现配置变化时，该能力仍可能重新出现。

## 决策

随附的极简组合只提供一个按平台选择的持久 shell：Linux 与 macOS 使用 `bash`，Windows 使用 `pwsh`。两份组合都不挂载 `@deepseek-ai/dsh-tool-str-replace-editor`、文件系统工具或支撑 editor 的 `fs-local` 服务。固定的 complete persona、运行时上下文与 compaction 的缺失、shell 超时和各启动路径的宿主服务保持不变。

独立 editor 包仍可用于显式自定义组合。受信任的用户自定义 preset 或更高优先级的 profile patch 必须将 editor 插入 Cordis tree，并在同一服务作用域内提供文件系统后端；随附的 `minimal` 与 `sdk-minimal` 默认组合不会插入它。[Python SDK 指南](../../../../docs/user/guide/python-sdk.zh.md#opt-in-to-str_replace_editor)提供可执行的 patch 示例。

共享的[持久 Bash 消费方](../../../../packages/shell/tool-bash-persistent/README.zh.md#model-experience)保留跨调用状态，并采用单次 shell 的命令状态文案。完成的命令追加 `[Command finished with exit code N]`，成功时也包含该标记；超时输出包含 `[Command timed out or OOM]` 和 shell 重置说明。追加状态标记前会移除输出末尾的全部换行。两份极简 Bash 描述都说明网络访问取决于任务环境。使用该消费方的显式组合共享相同的输出行为；持久 PowerShell 的描述与输出保持不变。

精确组合测试会断言单工具清单以及 preset 内不存在文件系统服务。`sdk-minimal` bundle 测试与构建后配置转储会断言配置项和依赖 allowlist 都不含 `fs-local` 或 `dsh-tool-str-replace-editor`。Web 与打包 Python 的模型可见快照会固定单工具 schema 清单。SDK profile 冒烟测试会执行指南中的 editor patch，并验证文件创建和查看。

本决策部分取代[极简裸运行时](../feature/2026-08-11-minimal-profiles-bare-two-tool-runtime.zh.md)中的工具选择，以及[base 编辑器决策](2026-09-05-base-default-file-editor.zh.md)中的极简例外。这些 Agent Note 继续负责提示词所有权、无 compaction 行为和基于 base 的文件编辑。[应用架构](../../../../docs/architecture.zh.md)负责 profile 启动与 bundle 分层。

## 考虑过的替代方案

**保留 editor 配置项并隐藏其 schema。** 不予采用，因为呈现层或限制层会让该能力继续留在极简组合中，并使其缺失依赖另一项设置。

**从发行物中删除 editor 包。** 不予采用，因为显式自定义组合仍是有效消费方。本需求只涉及两份随附的极简默认组合。

**只在 `sdk-minimal` 中保留 editor。** 不予采用，因为两条极简路径会向同类模型提供不同的工具约定，而且打包 SDK 路径仍会承担 schema 成本和未被其他配置项使用的文件系统服务。

## 后果

极简 agent 通过持久 shell 检查和修改文件。模型请求只携带一个工具 schema，组合不拥有文件系统服务。editor 包和显式 editor 组合仍然可用。Web 与 SDK 回放快照会同时固定持久 Bash 的状态标记、shell 状态和文件操作结果。
