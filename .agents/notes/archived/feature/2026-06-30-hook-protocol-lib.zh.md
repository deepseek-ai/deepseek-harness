# Agent Note: dsh-hook-protocol——Claude Code / Codex 钩子协议格式共享核心库

Status: implemented
Archived: 2026-09-04

[English](2026-06-30-hook-protocol-lib.md) | 中文

## 问题

钩子子系统提供两个桥接插件：一个运行用户既有的 Claude Code（CC）钩子，另一个运行 Codex 钩子。参考实现（`~/repos/refs/claude-code`、`~/repos/refs/codex`）表明一个决定性事实：**Codex 有意重新实现了 CC 钩子协议的一个子集。** 它的引擎读取相同的 `hooks.json`，使用相同的 matcher-group 形状、相同的 exit-code/structured-stdout 输出约定，以及相同的命令钩子执行模型。Codex 的源码甚至以 Claude 的引擎命名，并在注释中标注了「有意偏离」之处。因此，如果不做抽取，两个桥接插件将大量重复协议逻辑。

本 Agent Note 引入 `@deepseek-ai/dsh-hook-protocol`，一个**库**（不是插件——它不注册也不注入任何东西），持有两个桥接插件共同依赖的真正相同的原语。共享与方言专属之间的分界是本设计的重心。

## 决策

在 `packages/hooks/` 分组下新建 `hook-protocol` 作为纯库。它负责四类原语和 `hook/*` 会话事件；每个桥接插件（`dsh-hooks-claude-code`、`dsh-hooks-codex`）拥有真正不同的部分。

**共享（本库）：**
- **Matcher** — `matcherDiagnostic(pattern, mode)` 与 `matchesMatcher(pattern, query, mode)`。两种方言的唯一差异收敛到 `mode` 参数：`claude` 将纯 `[A-Za-z0-9_|]+` pattern 视为字面量（管道符表示多个精确匹配备选项），其他 pattern 视为正则；`codex` 始终使用未锚定正则。缺省/`''`/`'*'` 匹配一切。每个桥接插件会在解析 group 前忽略不支持的事件，丢弃受支持但没有 matcher 匹配对象的事件上的 matcher 字段，校验其余可运行 group；其中任何无效正则都会导致整份配置加载失败，并给出包含方言／pattern／事件的稳定诊断，不会注册任何钩子监听器。运行时匹配仍会将无效正则隔离为不匹配，因此直接调用本库绝不向 agent loop（智能体循环）抛异常。
- **执行** — `runHook(bash, hook, options)`。通过 `ctx.shell` seam 而非自建 `spawn` 运行命令钩子：执行器已提供清洗但可覆盖的 env、进程组 kill 和超时，正是协议所需的能力；`dsh-shell` 的 `stdin`/`env` 字段（正是为此添加的）是进程内桥接插件被允许使用的受信插件 API。它将桥接插件构建的 payload 序列化到 stdin（仅 CC 时追加尾部换行），遵守钩子的 `timeoutSec`（否则使用 `DEFAULT_HOOK_TIMEOUT_MS`，即两种方言共享的 10 分钟参考默认值），且从不抛异常（执行器拒绝变为 non-blocking-error 的 `HookOutput`）。
- **解码** — `parseHookOutput(exit, stdout, stderr)`，exit-code + structured-stdout 编解码器，产出方言无关的 `HookOutput`。Exit `0` → 宽松 JSON 解析 stdout；exit `2` → blocking error，`stderr` 为原因（以 `decision: 'block'` 呈现，调用方无需单独处理 exit-code 分支）；其他 → non-blocking error。解析 CC structured-stdout 中在某条路径上有消费方的字段（`continue`/`stopReason`/`decision`/`hookSpecificOutput.{permissionDecision,additionalContext,updatedInput}`/`systemMessage`）；桥接插件只采纳对其方言有意义的子集。在任何路径上都没有消费方的字段不予解析（CC 的 `suppressOutput`——钩子 stdout 在此处从不进入 transcript（文本记录），因此无需抑制；见 [收紧钩子协议约定 Agent Note](../simplification/2026-07-04-tighten-hook-protocol-contract.zh.md)）。
- **合并** — `mergeHookOutputs(outputs)`，将多个匹配钩子的输出折叠为一个最严格的 `MergedHookOutcome`：权限优先级 **deny > ask > allow**，停止状态从首个 `continue:false` 起保持不变，阻止原因以 `\n\n` 拼接，上下文/system-messages 按序累积。
- **`hook/*` 会话事件** — `hook/invoked` / `hook/result`，通过声明合并进入 `SessionEventMap`（仅日志，如 `compaction/*`——不是 `SurfaceEventType`），配有 `appendHookInvoked`/`appendHookResult` 辅助函数，确保 invoked/result 配对与由所有者定义的执行关系在各桥接插件间保持一致。`appendHookResult` 还负责定义持久化记录的语义：decision 字符串（钩子解析出的 decision，否则 `continue:false` 时为 `'stop'`，否则为 `'pass'`）和 500 字符的 `stderrSummary` 截断均从本库的 `HookOutput` 派生，而非各桥接插件各自实现。

**方言专属（桥接插件）：** 构建每个事件的 stdin payload（CC 的 base 字段集+各事件字段集 vs Codex 的 snake_case 加 `turn_id`/`model` 额外字段）、CC 方言的 env 与 `${CLAUDE_PLUGIN_ROOT}` 替换，Codex 则两者皆无，以及将方言无关的 `HookOutput`/`MergedHookOutcome` 映射为 harness 各扩展点专属的类型化 Decision（`PreToolDecision`、`PreStepDecision`、`ContinuationDecision`、`PostToolDecision`）。

## 曾考虑的替代方案

**单一参数化引擎。** 否决，因为 payload 构建与 decision 映射在方言间确实不同。Matcher、编解码器、执行、合并规则和事件保持共享；每个桥接插件保留自己的 payload 和映射，使其协议格式行为在代码中可就地阅读。

## 后果

每个桥接插件以原子方式解析配置、构建方言 payload、调用共享的 runner 与合并逻辑、映射 decision、追加 `hook/*`。协议测试覆盖每种 matcher 模式与诊断、exit-code 与编解码器字段、runner 接线、合并优先级和审计辅助函数，逐文件 100% 覆盖率；桥接插件测试验证库的加载路径并锁定精确警告。无密钥 ACP（Agent Client Protocol）快照通过真实 Loader/app 路径启动两个桥接插件，在非法 matcher 之前放置一个合法的阻塞 group，然后证明请求仍到达回放模型且没有持久化任何 `hook/*` 行，从而避免手工挂载的上下文掩盖部分注册。`updatedInput` 已解析但仅记录日志并发出警告，直到 [input-rewrite 提案](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.zh.md)落地。
