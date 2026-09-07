# Agent Note: Skill 系统——面向 agent 的渐进式指令披露

Status: implemented
Archived: 2026-09-04

[English](2026-07-05-skill-system.md) | 中文

## 问题

agent（智能体）产品已趋同于一种 skill（技能）模式：保持请求提示词精简，仅列出可用的指令包，当模型判定某任务匹配时再加载完整正文。Codex、Claude Code、OpenCode 与 Kimi Code 在细节上各有不同，但都将发现元数据与完整指令分离，使工作区能承载可复用的行为而无需在每个轮次支付全量提示词开销。

DeepSeek Harness 使用同一原语，使项目特定的评审、插件编写和工具使用指南存放在工作区或用户的 agent 配置旁，而非硬编码到 agent loop（智能体循环）中。

## 决策

`@deepseek-ai/dsh-skill` 是纯提供方注册表（`ctx.skills`），`@deepseek-ai/dsh-skill-filesystem` 是随附的本地文件系统提供方，`@deepseek-ai/dsh-tool-skill` 负责持久化会话目录与面向模型的 loader 工具。`dsh-base` 将注册表、本地提供方和消费方作为独立配置行加载，使其各 profile 获得相同行为，同时嵌入式或远程提供方可在不修改注册表或消费方的前提下贡献 skill。每个配置行只暴露其所属包的配置。

专用的随包提供方可以贡献不可变的 skill，无需文件系统发现。交付的 CLI（命令行界面）默认将 `@deepseek-ai/dsh-skill-badge` 声明为禁用；启用其组合配置行，就会通过同一个注册表和消费方贡献官方徽章指令（见[包约定](../../../../packages/skill/skill-badge/README.zh.md)）。

提供方插件在 `apply()` 期间同步注册。提供方成员资格是由直接 effect 持有的状态：注册与 dispose（资源释放）同步地使已完成的目录失效，发现操作按需读取当前提供方映射而非监听注册表变更事件。提供方目录从等待的 `list()` 调用返回排序后的候选项，远程提供方在此过程中执行初始化、认证和发现，同时遵守查找的 abort 信号。注册表校验每个候选项，按排名、提供方注册顺序和提供方内部顺序以先到先得方式解决同名 skill 冲突，然后按 skill 名称排序摘要以保证消费方获得确定性结果。它仅缓存已完成的目录快照，并在发现过程中提供方／运行时修订版本发生变化时重试，因此卸载操作不会将一个陈旧且不可解析的 skill 冻结到会话目录中。运行时 `ctx.skills.register(...)` 仍作为嵌入式进程内 skill 的便捷方式保留，使用 project 优先于 user 的优先级；`runtime` 保留为注册表拥有的提供方名称。

本地提供方按先到先得的排名顺序扫描 cwd 敏感的项目根目录、自定义根目录和用户根目录：项目 `.dsh`、项目 `.agents`、`customSkillDirs`、用户 `.dsh`，然后是用户 `.agents`。用户 `.dsh/skills` 扫描跳过 `.system`，以免系统拥有的目录被当作普通用户内容处理。本地提供方不会合成内置系统 skill；已配置的 bundled 根目录和专用提供方会提供额外 skill。

每个 skill 是带 YAML frontmatter 的 `<name>/SKILL.md` 或 `<name>.md`。`name` 和 `description` 为必填；`whenToUse`、`metadata`、`disable-model-invocation` 和 `user-invocable` 为可选。名称采用 kebab-case。调用字段会投影到类型化的嵌套策略中，具体由[模型与用户独立调用决策](2026-07-28-skill-invocation-policy.zh.md)定义；解析器会拒绝旧的驼峰拼写。YAML frontmatter 使用 `yaml` 包解析，而非 `js-yaml` 或手写解析器：`yaml` 是本包已声明的现代解析器，足以满足有限的 frontmatter 需求，窄解析器要么拒绝用户预期可用的合法 YAML，要么膨胀为一个未经评审的 YAML 子集。

本地 skill 的文件系统 I/O 在加载了文件系统服务时通过 `ctx.fs` 进行：项目根目录查找使用 `resolve` 和 `stat` 探测 `.git`，根目录发现使用 `listDir`，skill 读取使用 `readText`。Node 文件系统作为后备，供在不挂载 fs seam 的最小上下文中加载 `dsh-skill-filesystem` 时使用。缺失的根目录、不可读或格式错误的 skill 文件、以及提供方 `list()` 的瞬态失败均降级为警告并跳过，使一个坏源不会导致所有 agent 请求失败；格式错误的候选项仍然快速失败，因为它们违反了提供方约定。

`dsh-tool-skill` 在会话的第一个 `agent/pre-step` 注入一个持久化的 user-role `<system-reminder>` 目录，作为带来源的 `user/message`，且仅当该 agent 的工具视图解析到本插件精确的 `skill` 注册时才注入。该目录仅包含排序后的 skill 名称与描述；不包含正文、路径、来源、提供方和路由提示。描述经过空白规范化、XML 转义，并受 `catalogDescriptionMaxLength` 上限约束，其默认值为 `500`，最小值为 `3`。完整的 skill 正文从不包含在目录中。（目录最初通过仅请求的[会话前缀扩展点](../../archived/feature/2026-07-07-session-prefix.md)（已归档）传递；[统一带来源消息的决策](../architecture/2026-07-22-unified-send-and-coalesced-user-messages.zh.md)将其移入持久化历史。）

注册表的 `list()` 返回全部胜出摘要，而模型与用户消费方应用[独立调用策略决策](2026-07-28-skill-invocation-policy.zh.md)定义的调用判定。`skill({ name })` 工具为当前 agent cwd 加载一个模型可调用的 skill，返回包含 `<skill_content name="...">`、`<skill_resources>` 和 `<skill_instructions>` 的工具结果。`resourceBase` 提供一个目录、URL 或不透明的提供方管理的基路径，用于显式引用的脚本、参考资料和资产；资源仅按需加载，不进行目录枚举。无法解析的名称报告该 skill 未知或不再可用；无效名称和 `invocation.modelInvocable` 为 `false` 的 skill 保留不同的工具错误。工具结果是面向模型的可见披露路径。

数据结构与目录／工具约定记录在 [skills.md](../../../../docs/subsystems/skills.zh.md) 中，服务签名见生成的[服务目录](../../../../docs/subsystems/skills.zh.md#cordis-surface)。

## 曾考虑的替代方案

**将完整 skill 正文注入每条系统提示词。** 否决，因为这破坏了渐进式披露，使每个请求都为可能不适用的指令付出代价。

**仅以斜杠命令暴露 skill。** 否决，因为模型主动加载是核心能力；面向人类的命令广播不改变发现机制。

**将本地文件系统扫描直接放入 `ctx.skills`。** 否决，因为编码 agent、Web agent 和未来的插件生态需要不同的 skill 来源。提供方注册表与 subagent seam 镜像：注册表拥有冲突解决和消费方，实现负责加载。

**使用系统提示词段落。** 否决，因为渲染后的系统提示词是单一字符串，而目录是一条 user-role `<system-reminder>` 消息。[仅请求的会话前缀扩展点](../../archived/feature/2026-07-07-session-prefix.md)（已归档）是最初的机制；统一带来源消息的决策移除该扩展点后，目录改为具有相同消息形状的持久化带来源注入。

**在 `~/.dsh/skills/.system` 下物化内置 DSH 编写 skill。** 否决，因为打包的 skill 不会在启动时写入用户主目录，嵌入式或远程提供方在配置后提供 skill。

**递归发现嵌套的 `**/SKILL.md`。** 否决。扁平文件和一级目录包覆盖了配置的根目录，同时使重复处理和目录顺序易于推理。

**手写 frontmatter 解析器。** 否决，因为已接受的 schema 包含一个开放的 `metadata` 对象。窄解析器要么拒绝用户预期可用的合法 YAML，要么膨胀为一个未经评审的 YAML 子集。

## 后果

agent-core 主干包含一个目录贡献者、一个本地提供方和一个面向模型的工具。skill 发现是 cwd 敏感的，因此以不同会话 cwd 值创建 agent 的调用方可以按设计观察到不同的项目 skill 覆盖。

目录对于固定的根目录集合和运行时注册修订版本是确定性的。本地提供方会监视已配置的根目录，并在发生相关磁盘变化后使已完成的目录失效；运行时注册和提供方释放也会使其失效。

## 延后

fork 的 skill 上下文（`context: fork`）、参数声明与提示（`arguments` 和 `argument-hint`）、以及逐 skill 的工具约束（`allowed-tools` 和 `disallowed-tools`）不在已交付的约定范围内。注册表、本地提供方和面向模型的工具不解析、不广播、也不强制执行这些字段。直接用户调用已作为 TUI 功能交付，基于共享调用策略和受信的 `get()` 原语；见[已归档的 TUI skill 斜杠命令](../../archived/feature/2026-07-21-tui-skill-slash-command.md)。
