# Agent Note: 工具调用超时策略作为插件

Status: implemented

[English](2026-07-07-tool-call-timeout-policy.md) | 中文

## 问题

[超时/截止时间 Agent Note](2026-07-06-timeout-deadline-library.zh.md) 将计时与分类原语提取到了 `@deepseek-ai/dsh-timeout`，但超时策略仍然附着在各个能力和面向模型的 schema 上。`bash` 暴露了 `timeoutMs`；`web_fetch` 暴露了 `timeout_ms`；`web_search` 没有面向模型的超时参数，尽管提供方已经遵循 `exec.signal`；未来的 grep/glob 工具要么直接导入超时库，要么自行发明超时策略。对于一个插件 SDK 来说，这是错误的编写范式：工具作者通常只需将 `exec.signal` 转发给其调用的实现，而部署策略来决定预算。

与此同时，仓库中并非所有超时都是面向模型的工具调用预算。钩子通过直接调用 `ctx.shell` 执行命令钩子，而非通过 `ctx.tools.execute()`；`bash` 模型工具通过同一个后端复用前台执行、后台启动、后台轮询和钩子复用。一步到位地将所有超时移入工具插件会混淆这些路径，并有破坏钩子超时语义的风险。

## 决策

工具调用超时是仅适用于面向模型的工具执行的策略，由三部分组成：

- `@deepseek-ai/dsh-timeout` 仍是拥有 `deadline()` 和 `timeoutOf()` 的共享库。
- `@deepseek-ai/dsh-tools` 在 `tools/pre-execute` 和 `tools/post-execute` 之间有一个环绕分发的 waterfall（瀑布式事件）`tools/execute`。
- [仓库命名约定](../../archived/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md)使用 `@deepseek-ai/dsh-tool-call-timeout-policy`，准确说明该策略所限制的操作。插件从 runtime 读取每个工具声明的 `timeoutMs`，并通过派生新的 `exec.signal` 来包装有此声明的调用。

执行流水线如下：

```text
ctx.tools.execute(exec)
  -> tools/pre-execute
  -> tools/execute
       -> registry dispatch (the base next())
            -> tool.execute(args, exec)
            -> thrown tool errors normalize to ToolExecutionResult
  -> tools/post-execute
```

默认行为是保守的：未声明 `timeoutMs` 的工具不会从该插件收到 `TOOL_TIMEOUT` 截止信号。

### `tools/execute` 环绕分发扩展点

`@deepseek-ai/dsh-tools` 声明了一个 `tools/execute` waterfall，其基础 `next()` 是带规范化的分发 thunk——即同一个内部 `try`/`catch`，将抛出的工具错误（或未知工具错误）转换为 `isError` 的 `ToolExecutionResult`。监听器接收 `(exec, next)`：调用 `next()` 委托给分发（返回其结果，可选地包装），或返回替代结果以短路分发。整个流水线仍位于 `execute` 的外层 try/catch 内，因此抛出异常的监听器会变成 `isError` 结果，而非轮次失败。

catch 是基础 `next`（而非 waterfall 之外的东西）这一点至关重要：当提供方看到超时信号并抛出自己的上游中止错误时，注册表分发首先将其转换为普通错误结果，然后 `timeout-policy` 才能将最终结果替换为 `TOOL_TIMEOUT`。

### `timeout-policy` 插件

该插件是 `@deepseek-ai/dsh-tool-call-timeout-policy`，一个零配置的函数/命名空间插件（`name` / `inject` / `apply`），位于 `packages/guard/` 组。每个工具的预算声明在工具自身，而非本插件：`ToolDefinition` 携带一个可选的 `timeoutMs`，由拥有该工具的插件从自身配置中设置。例如 `dsh-tool-web` 将 `fetchTimeoutMs` / `searchTimeoutMs`（默认 30000）解析到 `web_fetch` / `web_search` 的定义上：

```yaml
- id: timeout-policy
  name: '@deepseek-ai/dsh-tool-call-timeout-policy'
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetchTimeoutMs: 30000
    searchTimeoutMs: 30000
```

超时放在工具定义上而非自由文本名称映射中，消除了拼错名称导致策略不生效的问题。`defineTool` 校验预算为正有限数。分发期间，执行器派生截止信号并将其赋给 `exec.signal`；注册表依据[工具取消约定](2026-07-19-cooperative-tool-cancellation.zh.md)，在执行工具体之前将该截止信号与调用方的原始信号融合。执行器随后恢复调用方信号，并将自身的超时转换为 `TOOL_TIMEOUT`；没有预算的工具原样通过。

信号替换采用**就地修改 `exec.signal`** 的方式，而非向 `next()` 传递新对象。Cordis 的 waterfall `next()` 忽略传入的任何参数，并以共享的 payload 数组重新调用下游监听器（`vendor/cordis/src/events.ts`），因此修改共享对象是包装器向注册表提供截止信号的方式。注册表会在进入工具体前再次融合已捕获的调用方信号；插件则在 `finally` 中将 `exec.signal` 恢复为调用方的原始值，使 `tools/post-execute` 永远不会看到本插件的截止信号。

`timeout-policy` 拥有 `TOOL_TIMEOUT` 代码的两种用途：传递给 `deadline()`/`timeoutOf()` 的内部截止代码（有作用域，使嵌套的外层截止被识别为普通取消）和结构化工具结果错误代码。其替换结果为：

```ts ignore-check
function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: `Error: tool call timed out after ${timeoutMs}ms` }],
    isError: true,
    error: {
      message: `tool call timed out after ${timeoutMs}ms`,
      info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
    },
  }
}
```

这是一个协作式截止。它不会通过竞争工具 promise 来杀死任意工作；工具或其调用的能力必须遵循 `exec.signal` 并达到完全停稳。因此声明 `timeoutMs` 意味着「此工具与 `exec.signal` 协作」，插件 README 将此作为其约定。

无需新的会话事件来保证可重建性：`TOOL_TIMEOUT` 是该调用的最终面向模型的 `tool/result`，因此现有会话日志已经记录了下一次模型请求所见的内容和结构化 `{ name, code }` 错误。

### 现有工具适配

`web_fetch` 和 `web_search` 已迁移。`dsh-tool-web` 保留对其面向模型 schema 的所有权，这些 schema 不暴露超时旋钮：`web_fetch` 没有 `timeout_ms` 参数，`web_search` 接受必填的 `queries` 数组，但不接受超时参数。工具体不导入 `@deepseek-ai/dsh-timeout`；它们将 `exec.signal` 转发给 `ctx.web`。

`dsh-web-fetch-http` 保留一个在提供方层面配置的 `timeoutMs`，作为较大的资源兜底值，服务于直接调用 `ctx.web.fetch()` 的调用方和配置错误的部署；它不拥有面向模型的超时。当 `TOOL_TIMEOUT` 信号先到达 fetch 提供方时，提供方作用域的分类将其视为上游 `WEB_ABORTED`，而外层 `tools/execute` 包装器将最终工具结果替换为 `TOOL_TIMEOUT`。一个已发布的 web 工具部署将提供方兜底配置为高于 `timeout-policy` 预算，使工具调用策略在模型调用中通常胜出。

`bash` 保持当前的后端超时路径。`dsh-tool-bash` 继续暴露 `timeoutMs` 和 `run_in_background`；`dsh-bash-local` 继续使用 `@deepseek-ai/dsh-timeout` 处理 `BASH_TIMEOUT`；钩子桥接继续调用 `runHook()` 并通过 `ctx.shell` 传递 `timeoutMs`。这保持了前台/后台/钩子行为的稳定。

`read`、`write`、`edit`、`todo_write`、`job_list` 和 `job_kill` 不加入工具调用超时。`job_output` 自己拥有有界等待，因为等待超时是成功的实时状态结果，而非工具失败。

未来面向模型的 grep/glob 工具可以基于 `ctx.shell` 实现而无需导入 `@deepseek-ai/dsh-timeout`：它将 `exec.signal` 转发给 `ctx.shell`，并声明自己的 `timeoutMs`（来自其插件配置）供执行器应用。如果 bash-local 的后端超时对这类工具造成问题，bash seam 可以后续添加调用方自有截止模式；那是一项独立的决策。

## 曾考虑的替代方案

**将插件命名为 `tool-timeout`。** 字面的 Agent Note 名称匹配了 `gen-tool-catalog` 完整性守卫的 `packages/*/tool-*` glob，该 glob 要求每个匹配项注册一个面向模型的工具。本插件不注册任何工具——它是一个 `tools/execute` 包装器——因此 `tool-*` 名称要么导致 `verify-tool-catalog` 失败，要么强制产生一个误导性的启动条目。包为 `@deepseek-ai/dsh-tool-call-timeout-policy`，位于新的 `packages/guard/` 组；cordis.yml 的 `id` 仍可为 `timeout-policy`。

**仅保留逐工具的超时处理。** 这是 `bash` 和 `web_fetch` 的既有形态，也与 Claude Code 和 Codex 对 shell 命令的做法一致。它对 web 类工具不利，因为每个新的支持超时的工具都必须自行选择校验方式、上限语义、文档、快照和分类。插件集中了策略和分类，让每个工具的 schema 专注于业务输入。

**立即将所有超时策略移出 bash-local。** 长期来看更干净——bash-local 将成为纯子进程执行器，所有调用方自行管理截止时间。但作为第一步不合适，因为钩子直接调用 `ctx.shell`，且 bash 模型工具的前台/后台语义与工具调用生命周期不同。保留 `BASH_TIMEOUT` 维持了这些路径的稳定，同时让工具调用超时在更简单的工具上先行验证。

**为所有工具使用全局默认预算。** 方便，但会让工具作者意外：任何偶然运行超过全局预算的工具在插件加载后就会开始失败。逐工具声明预算使采纳成为有意的行为。

**暴露面向模型的 `timeout_ms` 覆盖参数。** Claude Code 的 `WebFetch`/`WebSearch` 和 Codex 的 web 工具将超时排除在模型调用形状之外。模型覆盖会使超时成为提示词语义的一部分，并迫使 `timeout-policy` 引入 schema/参数剥离规则。Web 超时仅作为部署策略。

**让 `timeout-policy` 自行匹配工具参数。** 诸如「当 `bash.run_in_background` 为 true 时禁用超时」之类的规则引擎会让策略插件了解工具特定的参数语义。通过不将 bash 迁移到工具调用超时来规避此问题。

**使用 `tools/pre-execute` 加 `tools/post-execute` 代替新的环绕分发扩展点。** pre 监听器可以启动截止时间并修改 `exec.signal`；post 监听器可以分类并替换。这样做的问题是截止时间的生命周期会跨越两个独立的 waterfall：需要 call-id 映射、在每条 pre-deny/tool-throw/post-throw/dispose（资源释放）路径上清理，以及与其他监听器的排序规则。`tools/pre-execute` 也是允许/拒绝门禁，而非执行包装器。`tools/execute` 给超时一个词法作用域：启动、委托、分类、释放。

**使用 `Promise.race` 对非协作工具强制超时。** 与超时库 Agent Note 相同的理由否决：它在底层进程、fetch 或提供方操作可能仍在运行时就将控制权返回给调用方。插件只发送信号；终止仍是实现方的责任。

## 后果

- `@deepseek-ai/dsh-tools` 在拦截点有意拆分 pre/post 工具钩子之后，获得了一个环绕分发接口。其约定范围很窄——包装注册表分发，而非替代 pre 门禁或 post 结果策略——且基础 `next()` 是带规范化的分发，因此包装器永远不会看到未经处理的工具异常。
- 多个 `tools/execute` 监听器按普通 Cordis waterfall 顺序组合：调用 `next()` 的监听器包装下游监听器加分发；不调用 `next()` 直接返回的监听器短路它们。一个同时组合超时与未来重试/沙箱/指标包装器的部署通过注册顺序选择语义（「超时覆盖整个重试」vs「超时覆盖每次尝试」）。
- 通过声明选择加入会带来一种有意接受的误配置风险：工具可以声明 `timeoutMs` 但不遵循 `exec.signal`，这样的工具在超时时不会停止。注册表会等待这个尚未完全停稳的工具体结束，而不是与它竞速；同时插件约定声明：声明预算意味着协作；web 工具在已转发信号的工具上验证了这一模式。
- 过渡期间 `bash` 和已迁移的 web 工具有意使用不同的超时路径：`TOOL_TIMEOUT` 是面向模型的工具调用预算，而 `BASH_TIMEOUT` 仍是 bash 和钩子使用的 bash 后端超时。
