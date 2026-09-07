# Agent Note: 持久 Bash 与字符串替换编辑器工具

Status: implemented
Archived: 2026-09-04

[English](2026-07-29-persistent-bash-str-replace-editor.md) | 中文

## 问题

部分部署需要只调用一次的 Bash schema，同时要求 shell 状态跨模型轮次保留；另一些部署需要与终端选择无关的 Claude 风格 `str_replace_editor`。把两个工具绑在一起或按某个基准命名，会阻碍复用并模糊配置归属。

## 决策

`@deepseek-ai/dsh-tool-bash-persistent` 消费 `ctx.terminals` 并注册一个 `bash(command)` 工具。它为每个精确 Agent 惰性创建一个交互式 shell，并串行化该所有者的调用。Cwd、导出的变量、已激活环境、函数和后台任务会保留。随机私有标记划分命令输出；保留的 scrollback 会向前分页，以恢复命令真正的输出前缀，若前缀已被丢弃则明确告知。经封装的命令以非零状态结束时，会追加 `[exit code: N]`；若 shell 在报告该状态前终止，则改为追加 `[shell exited: code N]`、`[shell killed by signal: SIG]`，或在后端既未提供退出码也未提供信号时追加 `[shell exited]`。`maxOutputChars` 限制保留的命令输出，而固定诊断可能使返回字符串更长。超时或取消会先关闭 shell，避免下一次调用复用状态不确定的会话，模型可见的超时／退出结果也会说明该重置。取消始终会重置 shell 并丢弃结果，即使已经能观察到完整状态标记也是如此，从而不会让模型未曾看到的状态变更得以保留。可配置描述默认只声明持久性事实，因此网络和软件包镜像等声明仍归部署所有。

`@deepseek-ai/dsh-tool-str-replace-editor` 独立消费 `ctx.fs`，注册包含 `view`、`create`、`str_replace` 与 `insert` 的 `str_replace_editor`。它提供带行号文本查看、过滤后的两层目录列表、唯一字面量替换、规范插入边界和有界输出。路径必须为绝对路径；文件查看会保留内容中的制表符，因此复制的文本仍可作为有效的字面量替换输入；变更会保留请求编辑范围之外的制表符；公开 schema 与错误则只使用 `old_str`。命令专属字段接受 `null` 占位参数：当前命令不使用该字段时，执行会将其视为未提供；必填检查保持不变；`view_range: null` 表示查看完整文件；`str_replace.new_str: null` 会被拒绝，只有省略该字段才表示删除。它可以与持久 Bash、一次性 Bash、沙箱 Bash 或无 shell 组合。

`dsh-system-prompt` 接受 `includeHarnessIdentity: false`，profile 组合同时拥有该配置行与所选 shell 工具配置行。`sdk-minimal` 将该值设为 `false`，且只挂载按平台选择的持久 shell，因此部署可以拥有精确 persona，而不会重复注册提示词或工具。既有默认值不变。

两个插件都进入 Python runtime 闭包。持久 Bash 的闭包还包含 PTY 服务／本地后端，以及该后端要求的沙箱服务。由于 `node-pty` 在 macOS 上会执行原生 `spawn-helper`，每个打包后的 macOS 运行时可执行文件都会携带一个 `-spawn-helper` 伴随文件；Linux 直接使用 `forkpty`。固定版本的 `node-pty` 补丁会先检查 `DSH_NODE_PTY_SPAWN_HELPER`，因此对当前提供非伴随 helper 的外部消费方而言，该变量仍是真正的覆盖项。未设置该覆盖时，补丁会在打包可执行文件的伴随文件存在时解析它，否则在普通 Node 运行中保留上游查找方式。若 helper 缺失或不可执行，macOS 构建器会在发布前失败。

随附的 [`minimal` agent preset](../../../../packages/preset/agent-presets/presets/minimal/agent.cordis.yml) 会组合这两个插件，以满足与 Claude SWE 兼容的 RL 约定。其 entry 本地 PTY realm 持有注册表、本地后端和持久 Bash 工具；编辑器在该 realm 旁注册，并使用宿主文件系统。preset 会固定完整系统提示词、跟随部署的工具呈现模式，省略其他所有面向模型的消费方，并将浏览器、Workspace、持久化、沙箱与权限服务留在共享 Web 宿主上。本地 PTY 后端会在创建 shell 时解析会话的有效沙箱模式。只要该所有者仍有打开的 shell 或仍在进行中的 spawn，另一种权限模式就会在对应的会话事件提交前遭到拒绝；编辑器则继续经由 Web 文件系统沙箱运行。这一组合边界由 [minimal-preset 决策](../bug-fix/2026-08-10-minimal-preset-owns-rl-composition.zh.md)负责说明。

## 考虑过的替代方案

**单一组合兼容插件。** 被拒绝，因为两个工具互不依赖，组合命名还会把可复用能力绑定到某个基准。

**复用一次性 Bash。** 被拒绝，因为 `bash -c` 无法跨调用保留 cwd 或环境状态。

**暴露终端管理工具。** 被拒绝，因为 open/send/read/close 与单个持久 `bash` 调用是不同的模型动作空间。

**修改原生 read/write/edit。** 被拒绝，因为这会扭曲其通用约定，而不是增加一个可独立组合的编辑器。

**拒绝每个已提供的 `null` 命令字段。** 被拒绝，因为模型生成的调用可能为当前命令不使用的可选字段序列化占位参数。当前命令仍会拒绝必填字段以及对删除操作有影响的 `str_replace.new_str` 字段为 `null`。

## 后果

Profile 可以通过配置 persona 和描述复现外部 Agent，而底层包保持通用。持久 Bash 需要拥有它的 Agent 与真实 PTY 后端；shell 退出、超时或取消会丢失状态。编辑器把安全与变更策略委托给挂载的文件系统栈。可为 `null` 的分支增加了命令专属字段的 schema 成本，使未使用的占位参数不会迫使模型重试；执行仍明确保留当前命令的必填与删除语义。minimal Web agent 保留 Web 权限，但必须先关闭持久 shell 才能更改权限模式。运行时 wheel 包的消费方仍无需安装 Node；Linux wheel 包包含一个可执行文件，macOS wheel 包还包含其私有原生 helper。
