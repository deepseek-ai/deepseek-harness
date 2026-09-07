# Agent Note: 规范工具输出约定

Status: implemented

[English](2026-07-20-canonical-tool-output-contract.md) | 中文

## 问题

工具主体过去直接编写面向模型的 `ContentBlock[]`，并可选择将其与不透明的 `meta` 包装在一起。因此，Native 模式的 Function Calling（函数调用）虽然拥有可供人阅读的投影，但程序化调用方没有稳定的领域值：PTC mode 会将内容块重新展平为字符串，动态工具会重复定义内容形态，策略也可以替换展示内容，却无法区分这项变更究竟是替换展示，还是替换操作结果。多个能力 seam 已经返回了信息更丰富的提供方值，却又在面向模型的工具边界丢弃这些值。

持久会话约定将这份展示内容视为回放时的权威来源，但如果持久化每一个信息丰富的中间值，就会扩大日志、使实现数据进入压缩（compaction）和迁移流程，还会错误地把执行期本地 API 变成会话格式的一部分。因此，系统底层需要在执行期间保留一个类型化值，并显式将其投影为现有的持久化内容和模型可见内容。

## 决策

每个工具都必须声明规范输出，并且只能返回该声明描述的值：

```ts ignore-check
output: {
  schema: OutputSchema
  render(args, value): ContentBlock[]
  presentationMeta?(args, value): JsonValue
}
```

`defineTool` 从统一的 `ValueSchemaSpec` 推导工具主体返回值和两个投影器的类型。原始定义和动态定义则提供编译后的 `JsonSchemaNode` 形式。注册时会拒绝缺失输出声明或采用不受支持的原始 schema 的定义，不提供兼容旧式内容返回值的路径。

每次成功分发时，注册表会将返回值快照为无损 `JsonValue`，依据 `output.schema` 校验并深度冻结，然后调用纯渲染器；对于直接的外层调用，还会调用可选的元数据投影器。渲染器、投影器、schema 或无损 JSON 处理失败都会被收敛为普通 `ToolOutputError` 结果。围绕 `tools/execute` 的包装层接收并返回规范的成功／失败联合；包装层自行产生的成功结果会再次通过已解析工具的输出声明完成归一化，而不会信任其独立编写的内容。每个规范结果都与创建它的不可变分发 token 绑定；因此，如果包装层返回来自其他调用或工具的缓存结果，系统会依据当前生效的输出声明重新执行归一化，而不会绕过这一步。

```ts ignore-check
type ToolExecutionResult =
  | { isError: false; value: JsonValue; content: ContentBlock[]; meta?: JsonValue; additionalContexts?: HookContext[] }
  | { isError: true; error: { message: string; info?: { name: string; code: string } }; content: ContentBlock[]; meta?: JsonValue; additionalContexts?: HookContext[] }
```

`tools/post-execute` 为成功结果提供两种互斥的投影方式。替换 `content` 只改变 Native／模型展示，并保留规范值和元数据。替换 `value` 会重新校验替代值，并重新计算两份展示投影。阻止操作会移除值并转为失败。因此，替换内容并不是保密机制：必须阻止程序化访问的策略，应当阻止调用或替换值。

规范值仅存在于执行期间。agent loop（智能体循环）持久化的 `tool/result` 只包含 `content`、`error` 和可选的 `meta`；PTC mode 的 `tool/code-dispatch` 持久化子调用渲染后的 `content` 与 `isError`。两个事件都不存储规范中间值，因此回放可以重现展示，却无法重建程序化结果。当工具声明 `presentationMeta` 时，系统只会为直接的外层调用计算它；嵌套 Code 分发没有元数据。Client 可以从原始参数与渲染后的内容派生[嵌套 terminal 卡片](../bug-fix/2026-09-05-nested-terminal-cards.zh.md)，无需这些元数据。外层 `run_code` 卡片则读取最终的 post-policy 内容，并且不声明展示元数据。通用以及工具自有的 spill 投影同样跳过嵌套分发，因为它们的规范值永远不会进入模型上下文。

第一方工具在保持现有 Native 文本不变的同时返回领域 DTO：

| 工具系列 | 规范值 |
|---|---|
| `read` | `{ path, offset, lines: [{ number, text }], totalLines }` |
| `write` | `{ path, operation: "create" | "update", before: string | null, after }` |
| `edit` | `{ path, before, after }` |
| `glob` | `{ paths: string[] }` |
| `grep` | `{ matches: [{ path, lineNumber, line }] }` |
| `web_search` ／ `web_fetch` | 归一化后的 `WebSearchResult` ／ `WebFetchResult` |
| `lsp` | `{ kind: "locations", locations, resolvedWorkspaceUri }` 或 `{ kind: "hover", hover }` |
| `bash` | `{ kind: "background", jobId }` 或 `{ kind: "foreground" } & ShellRunResult` |
| `terminal_open` ／ `terminal_list` ／ `terminal_send` ／ `terminal_read` ／ `terminal_signal` ／ `terminal_close` | 公开会话快照、有界的读取／发送 DTO、信号／关闭操作结果，或后台任务句柄 |
| `job_output` ／ `job_list` ／ `job_kill` | 不含所有者或通知管理信息的公开任务快照 |
| `subagent` | 后台任务句柄或 `{ kind: "foreground", runId, output: JsonValue[] }` |
| `workflow` ／ `ralph` | `{ runId, agentsStarted, result: JsonValue }` |
| `skill` | `{ name, provider, resourceBase?, content }` |
| `todo_write` | `{ todos, counts }` |
| `ask_user_question` | `{ answers: [{ id, selected, custom? }] }` |
| `exit_plan_mode` | `{ approved: true }` |
| `cordis_inspect` ／ `cordis_mount` ／ `cordis_unmount` | 检查文本或类型化的临时插件句柄 |
| `structured_output` | `{ recorded: true }` |
| `run_code` | `{ logs: string[], result?: JsonValue }` |

提供方和执行器的采集上限仍会实际限制规范值。仅用于格式化的限制归 `render` 所有；例如，`glob` 和 `grep` 会在 `value` 中保留所有已采集项，而其 Native 投影会保留配置指定的第一页，并尽力将其写入 spill 文件。通用 spill 会前置注册其 post-execute 监听器，并让该监听器先向后委托，因此无论插件加载顺序如何，普通工具自有的异步投影都会在通用字节数上限处理之前完成。文件系统变更工具根据 `args` 和规范的变更前／后值推导可回放的 diff 元数据，不再由工具主体返回 UI 状态。

MCP 桥接层通过 `McpResult<{...}> = { content: JsonValue[]; structuredContent? }` 保留协议内容块。当公布的 `outputSchema` 属于受支持的原始子集时，系统会强制校验；不受支持的 schema 则回退为 `JsonValue`，而不会假装已完成校验。Native 渲染仍使用现有的 MCP 到 `ContentBlock` 投影，MCP `isError` 则会变为失败的工具结果。

## 备选方案

- **向 PTC mode 返回渲染后的文本：**不予采纳。调用方仍需从自然语言中提取 job id、挂载 id、路径和结构化提供方结果。
- **在 `tool/result` 上持久化规范值：**不予采纳。嵌套执行值不属于模型历史记录，无需在回放后继续存在；持久化还会引入与 Native 重建无关的会话格式和存储承诺。
- **允许工具同时返回值和内容：**不予采纳。由作者分别维护的两份结果可能互相矛盾，策略也无法说明哪一份才是权威结果。渲染器会根据已校验值确定性地产生展示。
- **将内容替换视为值脱敏：**不予采纳。展示内容和程序化访问面向不同消费方；只隐藏前者会制造虚假的安全边界。
- **要求工具输出必须以对象为根：**不予采纳。标量、数组和 null 结果都是合理的 JSON API。只有由调用方定义的 subagent／工作流结构化输出仍受消费方的对象根规则约束。

## 影响

Native 和回放行为仍以内容为先，并保持逐字节兼容；执行期调用方则无需解析内容，即可使用经过校验的领域值。失败结果必须包含消息，并可选择附加内部类名／代码信息；成功与失败结果由判别字段区分，失败结果绝不会承诺存在值。工具作者必须一并设计值及其 Native 投影；增加这项声明是有意为之，因为它避免从自然语言内容意外推导出程序化约定。

中间值只受产生它们的能力和进程内存限制。日志不包含这些值，因此回放无法恢复；仅处理内容的 post 策略也无法隐藏这些值。这些都是执行期本地约定的明确属性，并非意外缺口。
