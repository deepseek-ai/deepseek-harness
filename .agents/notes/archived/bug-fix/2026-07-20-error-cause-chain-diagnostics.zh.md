# Agent Note: 在每个诊断边界渲染错误 cause 链

Status: implemented
Archived: 2026-09-04

[English](2026-07-20-error-cause-chain-diagnostics.md) | 中文

## 问题

TUI 连接不可达的 DeepSeek 端点时，失败只显示一条 `fetch failed` 通知，没有任何进一步细节。两个独立缺口共同造成了这个死胡同：

1. undici 的 `fetch` 把所有传输层失败（DNS、连接被拒、TLS、代理）包装成裸的 `TypeError: fetch failed`，可操作的细节——`ECONNREFUSED`、`bad port`、Happy Eyeballs 的 AggregateError——都在 `error.cause` 上。harness 里的每个诊断边界都只渲染 `error.message`（或对 Error 等价的 `String(error)`），于是包装层在 TUI 通知、持久化的 `turn/end` reason 和所有日志行里都掩盖了诊断信息。
2. readline 入口（`dsh-stdio`）完全不渲染失败原因：`reason.kind === 'error'` 的 `turn/end` 只打印下一个 `> ` 提示符，同样的失败在 `demo:repl` 里就是纯粹的沉默。

## 决策

- `dsh-llm` 导出 `errorChain(value)`：渲染抛出值及其完整 `cause` 链（`outer: inner: …`）与 AggregateError 成员（`msg [m1; m2]`），并容错循环 cause 和恶意强制转换。它只是用于诊断输出的渲染器；路由仍然基于 `HarnessError.code`。
- DeepSeek 适配器把拿到响应之前的传输失败包装成 `LlmError('TRANSPORT')`，写明配置的 `baseURL` 并将原始拒绝值作为 `cause` 串入错误链。被中止的请求变为 `LlmError('ABORTED')`；由于轮次信号已处于中止状态，agent loop（智能体循环）仍将该轮次归类为取消而非恢复。
- 每个诊断边界改用 `errorChain` 而非 `error.message`/`String(error)`：agent-loop 的持久化 `turn/end` 错误消息（`errorData`）、其日志警告、TUI 的 `agent/error` 通知与启动失败行、以及 `dsh-stdio` 的启动失败日志行。实时 `agent/error` 事件与 `SettleReason` 以 `unknown` 原样保留抛出值；各诊断消费方自行渲染，而不是由循环把它包装成另一个错误。`dsh-agent-loop`、`dsh-stdio`、`dsh-tui` 里各自的 `renderThrown` 副本被删除，统一使用这一个共享渲染器。
- `dsh-stdio` 渲染失败的 `turn/end` reason：`[turn failed <code>] <message>`、`[turn aborted] <reason>`、`[turn rejected] <reason>`、`[turn interrupted by a previous process exit]` 以及输出 token 上限通知。通过声明合并扩展出的未知 kind 按普通轮次结束处理。

`errorChain` 与 `HarnessError` 一样放在 `dsh-llm` 里，理由相同：它是每个消费方都已导入的叶子包，共享不增加新的依赖边。

## 考虑过的替代方案

**在每个错误的构造函数里渲染链（把 cause 写入 `message`）。** 否决：当消费方同时遍历 `cause` 时会双重渲染（适配器修复的第一版产出了 `… fetch failed: bad port: fetch failed: bad port`），并且破坏了想按内层错误路由的消费方所需的结构化链。

**只做一个感知 `cause` 的日志导出器。** 否决：持久化的 `turn/end` reason 和 TUI 通知不是日志行；被掩盖的消息会留在会话日志——轮次内失败的唯一持久记录——以及主要 UI 中。

**逐包升级 `renderThrown`。** 否决：三个包已经各自持有几乎相同的私有副本；分别升级只会固化共享渲染器所要消除的重复。

## 后果

- 传输失败现在在 TUI 通知、readline transcript（文本记录）和持久化会话日志里显示为 `DeepSeek API request to <baseURL> failed: fetch failed: connect ECONNREFUSED …`，代价是更长的诊断字符串。
- 持久化的 `turn/end` 错误消息包含 cause 细节。现有快照 fixture（测试前置数据）字节级一致地回放，因为其脚本化错误不带 `cause`（对这类错误 `errorChain(err)` 等于 `err.message`）；只有单元测试的期望字符串有变化。从真实传输失败录制的 fixture 会携带完整链。
- `errorChain` 渲染 `message` 而不带类名（`String(error)` 会渲染 `Error: <message>`），因此日志行里的裸 `TypeError` 会丢失类型标签，除非消息为空（此时回退到类名）。在这些诊断边界上，链细节被判断为比类名更有价值。
- `dsh-stdio` 对失败轮次的输出不再沉默；解析 transcript 的管道消费方会看到新的 `[turn …]` 行。
- `dsh-subagent`、`dsh-workflow`、`dsh-skill`、`dsh-workflow-worker-thread` 里剩余的 `renderThrown` 副本仍不渲染链；它们包装的是自带消息的包内错误，等诊断信息证明不足时再采用 `errorChain`。
