# Agent Note: 将实时配置保存在所属 profile 中

Status: implemented

[English](2026-09-19-profile-owned-live-configuration.md) | 中文

## 问题

独立的 settings 注册重复了 schema、默认值、持久化和通知，也让已存用户设置高于部署 overlay，却未保留值来自哪个组合来源。采用 Loader 已解析的 Config，使校验与消费者共享同一所有者，并保留已有生命周期判定。

## 决定

插件在 Cordis Config 中声明全部可配置值。无需重新挂载即可变化的字段使用 `.volatile()`；消费者在操作时读取其引用。Settings 只枚举这些字段并生成表单，不向业务提供配置。profile 编辑器写入 `cordis.patch.yml`，并通过普通 Loader 协调路径应用变化。

表单写入当前 profile。home patch 和命令行 overlay 仍是优先级更高的部署输入；如果它们会遮蔽某次修改，编辑器会在持久化前拒绝写入。两个插件实例通过各自不同的 profile entry id 寻址。嵌套 Include 保留独立所有权，不能通过该 profile 表单写入。

Cordis config patch 替换完整 entry config。编辑会保留普通字段、未编辑的秘密值和原始配置表达式。字段重置恢复当前继承值；整个 entry 重置后会移除其 config override，从而继承后续 bundle 变化。其他编辑会把该 entry 的完整 config 存入 profile 行：写入时组合出的普通字段加上全部 volatile 字段。此后 bundle 对这些字段的修改在该 entry 的 config override 被移除之前不会到达该 profile。在已发布的 bundle 中，修改默认权限预设会钉住 `permission.presets`，选择预设会钉住 `agent-presets`，编辑并行度会钉住 `agent-loop.agents`，编辑网页搜索会钉住 `web-search-deepseek.apiKeyEnv`；客户端会把这类行的每个 volatile 字段都标为已覆盖，而不只是被编辑的那个。要把写入收窄到被编辑字段需要 patch `config` 的合并语义，Include 不提供。

被移除的 `$DSH_HOME/settings.yaml` 会在 Settings 启动后、Loader 完成所有条目加载时一次性导入当前 profile：section id 即 entry id，其中 `ui-developer-tools` → `ui-settings`、`ui-onboarding` → `ui-settings-general`、`shell` → 当前平台的 shell 执行器条目。文件在第一次写入前改名为 `settings.yaml.imported`，因此导入不会重复；被拒绝的 section 会记录日志并保留在改名后的文件中。

## 考虑过的替代方案

保留 settings 作为配置适配器背后的第二份存储仍需要协调两份持久化文档，并决定并发修改或重启后哪份优先，因此不采用。删除的全局 settings 文档曾提供跨 profile 偏好；本设计明确将表单值持久化到各 profile。若重新引入共享偏好，必须采用显式共享 Cordis 层并明确写入目标。

## 后果

本决定只替代 [配置来源所有权](2026-08-04-configuration-source-ownership.zh.md) 中的非秘密 settings 层；其中的环境限制和凭据优先级仍适用。[Volatile 引用](2026-09-18-volatile-config-references.zh.md) 负责引用生命周期和普通更新行为。

真实 profile 测试覆盖多实例、持久化重启、非法编辑、过期修订、高优先级层拒绝、秘密脱敏及配置表达式。浏览器测试通过完整应用执行表单写入和重置，并检查实时编辑前后的运行时引用身份。
