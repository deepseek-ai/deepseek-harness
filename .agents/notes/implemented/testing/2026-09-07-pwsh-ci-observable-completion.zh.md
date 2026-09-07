# Agent Note: PowerShell CI 完成信号与 profile 预期

Status: implemented

[English](2026-09-07-pwsh-ci-observable-completion.md) | 中文

## Problem

[托管 coverage 作业](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34033367752/job/101605386802) 因持久 PowerShell send 返回 `inferred_idle` 而非 `stdin_read` 判定失败。输出静默是受支持的有界推断，不是命令完成的证明。真实 shell 测试还在输出中查找被回显命令本身包含的文本，无法独立证明命令执行。

[快照作业](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34033367752/job/101605386868) 在成功输出 `PWSH_OK` 后仍拒绝两个 PowerShell 场景。其 fixture 缺少 headless profile 的策略事件与运行时上下文消息；prompt 和工具 schema pin 也描述了更早、更小的组合。没有 PowerShell 的主机会跳过这些用例，无法发现此类漂移。

## Decision

[真实 shell 测试](../../../../packages/terminal/terminal-bash/tests/local.spec.ts) 接受两种受支持的就绪层级，拒绝超时和退出结算，并在 scrollback 中观察格式化的子进程输出，证明环境持久化、当前目录与凭据清理。预期文本不出现在提交的命令中。私有文件屏障将执行阻塞到静默结算之后，只有下一次 send 结算后才释放，证明后续输出仍可被观察，而不延长生产时序。会话释放先于私有测试目录删除。

[单次](../../../../snapshots/session/pwsh-tool-turn/snapshot.yml)与[持久](../../../../snapshots/session/persistent-pwsh-tool-turn/snapshot.yml) fixture 及其拥有的 header pin 使用真实 PowerShell 可执行文件和已录制模型回复，经构建后的 headless profile 刷新。策略事件和可用工具保留在预期中；工具结果与最终回复仍为 `PWSH_OK` 和 `DONE`。

## Alternatives considered

- 增加静默或前台交接超时：这会改变延迟，却无法让精确就绪变得确定。[持久终端决策](../feature/2026-07-16-persistent-pty-sessions.zh.md) 保留精确与推断两种结果。
- 接受任一等待原因，但不观察执行：回显输入与延迟命令可能让测试错误通过。
- 过滤策略事件或禁用继承的 headless 工具：这会隐藏组合后的 profile，而非测试它。[快照语料决策](2026-08-24-session-log-snapshot-corpus.zh.md) 保持持久化输出与 header pin 的权威性。

## Consequences

文件屏障用例能确定性地拒绝仅接受精确就绪的断言，修复后的测试则在推断结算之后证明命令效果。此证据需要真实 PowerShell；本地跳过不算验证。聚焦的构建后回放同时检查 Session 输出与 header pin，不改动 normalizer。生产终端行为、时序配置与 CI 路由均不变。
