# Agent Note: minimal profile 使用裸双工具运行时

Status: implemented

[English](2026-08-11-minimal-profiles-bare-two-tool-runtime.md) | 中文

## 问题

Web `minimal` preset 与独立 JSON-RPC minimal 组合对外提供持久 `bash` 和 `str_replace_editor`，但支撑服务与目标训练运行时不一致。两者都挂载上下文压缩，而 Web preset 继承宿主的沙箱文件系统，JSON-RPC 组合则挂载 `fs-sandbox` 和文件系统策略。因此，长会话可能替换历史记录，编辑器也会宣告并实施裸本地参考运行时并不具备的文件系统策略。

两条启动路径的配置所有者也不同。Web 在已运行的宿主上挂载逐 agent preset，Python SDK 则初始化一个完整的 stdio JSON-RPC 子进程。将二者视为可互换的同一个 Cordis leaf 会掩盖生命周期差异，而且 SDK 示例没有通过环境选择模型或系统提示词的入口。

## 决策

随附 Web minimal preset 对外提供持久 `bash` 与 `str_replace_editor`；独立 profile 在 Linux／macOS 上提供持久 `bash`，在 Windows 上提供 `pwsh`，并提供相同 editor。两者都不挂载上下文压缩提供方，为新建会话抑制每个 `dsh-system-prompt` runtime-context 贡献，并让编辑器使用 `@deepseek-ai/dsh-fs-local`。Web preset 在 agent entry 内隔离 `ctx.fs`，将 `fs-local` 与编辑器一起挂载，因此其他 Web agent 仍使用宿主文件系统提供方。其 persona 继续采用较早的 [minimal preset 组合决策](../../archived/bug-fix/2026-08-10-minimal-preset-owns-rl-composition.md)所拥有的固定 complete 提示词，并仅为该 agent 作用域实施 runtime-context 抑制。独立 spine 将同一设置转发给其进程拥有的 system-prompt 服务。Web 宿主保留沙箱与批准服务；独立 profile 挂载 danger-full-access 沙箱策略，不挂载批准服务。两者都不贡献面向模型的策略上下文。

独立的 [`@deepseek-ai/dsh-sdk-minimal` 组合包](../../../../packages/bundle/sdk-minimal/README.zh.md)仍是 `dsh --profile sdk-minimal` 后面的完整 JSON-RPC 进程组合。它挂载 SDK 启动与 JSON-RPC 服务、按平台选择的持久 shell 所需的本地 PTY 和子进程服务、`fs-local`、该 shell 的工具消费方、editor，以及位于 `$DSH_HOME/sessions` 的未压缩 JSONL 持久化。它不挂载 `token-meter`、`compaction-basic`、`fs-sandbox` 或 `fs-observation-policy`。持久 shell 消费该 profile 的 danger-full-access 沙箱策略；编辑器不受该策略限制。[docs/architecture.md](../../../../docs/architecture.zh.md) 负责该组合包的位置及其与 `dsh-base` 的分离。

`DSH_SYSTEM_PROMPT` 选择独立组合的 persona，`DSH_CONTEXT_WINDOW` 为没有确切目录元数据的模型提供后备容量。SDK 客户端的 JSON-RPC `initialize` 请求是唯一运行时模型选择。[`minimal.py`](../../../../python/sdk/examples/minimal.py)可以只把 `DSH_MODEL` 读作命令的默认 `model` 参数；显式 `--model` 不需要匹配的子进程环境值。端点与凭据变量继续由 DeepSeek 适配器现有的环境解析路径持有。

## 验证

Web 回放会启动完整 Web 宿主，通过 preset 服务创建 agent，并断言作用域文件系统为裸后端、不存在作用域压缩服务、没有追加 system-prompt 拥有的 runtime-context 消息，而且组装请求只包含固定提示词与两个工具。随后，它通过真实作用域服务执行持久 Bash 和编辑器。

SDK keyless 源码测试启动真实 `dsh --profile sdk-minimal`，使用环境选择的提示词完成一个回合，并断言生成的单组合包 manifest。Python SDK 打包运行时快照固定组装提示词、精确双工具目录，并固定不存在任何 system-prompt 所拥有的 runtime-context 消息。打包运行时覆盖会通过每种可用载体，使用环境选择的模型、模型容量和提示词值初始化独立 profile，然后执行所选持久 shell 与 editor。Cordis 校验会检查两份配置能否解析声明的插件和配置字段。

## 考虑过的替代方案

**以较高阈值保留 `compaction-basic`。** 不予采用，因为即便提供方在短测试中未触发，较长会话仍允许替换历史记录，而且 minimal 组合仍会依赖模型容量元数据与 token meter。

**在 danger-full-access 模式下保留 `fs-sandbox`。** 不予采用，因为沙箱提供方仍会使限权与提权成为编辑器能力的一部分。目标运行时要求裸本地提供方，而其不具备 `sandboxMode` 正是组合事实。

**为 Web 与 Python SDK 启动使用同一个 Cordis leaf。** 不予采用，因为 Web preset 向现有多会话宿主贡献 agent 作用域服务，而 Python SDK 必须启动包含 JSON-RPC 服务器及其进程级依赖的完整进程。

**把请求模型镜像到 `DSH_MODEL`。** 不予采用，因为直接适配器接受不在建议目录中的模型 id，并为它们解析后备上下文元数据。镜像会为同一项选择制造两个输入；SDK 初始化请求具有权威，`DSH_MODEL` 只保留为 `minimal.py` 的便捷默认值。

## 后果

Minimal 会话不会摘要或替换较早历史，也不会添加 runtime-context 快照；调用方必须让会话轮次保持在所选模型的上下文容量内，且不得依赖模型可见的常驻沙箱或批准策略说明。编辑器可以访问运行时进程可见的任何绝对路径，且不受持久 shell 沙箱策略影响。两条启动路径共享面向模型的工具、无上下文与无压缩保证，同时保留适合各自所有者的不同提示词和模型配置。Python SDK 路径只通过内置 `dsh` stdio JSON-RPC profile 通信。
