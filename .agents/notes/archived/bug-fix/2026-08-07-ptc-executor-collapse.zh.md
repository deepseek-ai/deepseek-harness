# Agent Note: PTC mode 塌缩执行器而非仅通告面

Status: implemented
Archived: 2026-09-30

[English](2026-08-07-ptc-executor-collapse.md) | 中文

## 问题

`mode: 'ptc'` 只塌缩了通告面，没有塌缩执行面。`wireSchemas()` 只向模型发送一个工具——`run_code`——但执行器通过 `get()` 解析所有调用，而 `get()` 返回完整的可见工具表外加保留的传输工具。模型一旦发出原生工具名（`write`、`read`、`bash`、`subagent` 等），就能完全绕过 `run_code`：调用照常走完整流水线并执行成功，尽管它的 schema 从未被通告过。模型提供方不拦截未通告的工具名，因此不发 schema 等于没有约束。

包契约点名了这个反模式：当直接调用方可以绕过时，schema 省略不算强制执行；拒绝必须经执行器验证。

## 决策

`ToolRuntime` 通过新增的私有 `resolveExecution(name, scope, nested)` 解析可执行定义，在拥有该决策的操作边界上应用模式塌缩。当 `modeFor(scope)` 解析为 `ptc` 时，模型直呼（`nested = false`）只允许命名保留的 `run_code` 传输工具；任何原生名字都解析为 `undefined`，并以执行器既有的 `UNKNOWN_TOOL` 错误呈现，其消息会指出改走 `run_code` 的正确路径——因为这个名字对当前模型而言是**已声明过**的（已中止的调用方 signal 保留取消契约：`ABORTED_BEFORE_DISPATCH`，并应用可见工具的 finalizer）。有效的 scope 模式包括从 agent preset 继承的声明，因此其 wire schema 与执行权限保持一致。被塌缩的调用在 `createExecution`（`prepare` 的第一阶段）即终止——在可扩展策略流水线之前，因此 `tools/pre-execute` 监听器、approval `ask` 与 guard 永远不会观察到一个注定被拒绝的调用，人类也不会被提示去批准它。嵌套子调用（`nested = true`——即设置了 `parent` token，生产代码中只有 `run_code` SDK 绑定会设置）可以调用任意可见工具，因此程序保留生成 SDK 声明的全部绑定。

执行链路的四处查表——`executionMode`、`dispatchToolBody`、`postExecute`、`normalizeDispatchResult`——改走 `resolveExecution`。`createExecution` 通过共享的 `collapses(name, nested)` 谓词应用同一塌缩，以便在策略流水线之前区分被塌缩的调用与真正未知的名字。公共注册表视图（`get`）与 SDK 投影（`schemas`）语义不变：展示、检查与绑定枚举仍看到完整可见集合。通告（`wireSchemas`）与执行器现在一致。带非 JSON 可序列化参数的塌缩调用报告参数 `TypeError`（invalid-args 契约），而非 `UNKNOWN_TOOL`——函数体仍不会运行，策略也不会执行。

塌缩是安全相关的不变量，因此验收经执行器钉死：`ptc` 模式下模型直呼原生工具返回 `UNKNOWN_TOOL`；同一工具经 SDK 子调用成功；`native`/`both` 模式直呼与 `run_code` 本身行为不变。本 note 把执行边界叠加在基础 [PTC mode 基础](../feature/2026-06-15-ptc.zh.md) 之上，传输设计由后者拥有。

## 备选方案

### 按模式过滤 `get()` / 注册表视图

视图被展示方、`tool-cordis` 检查与 SDK 绑定消费；塌缩视图会从程序表面隐藏仍必须绑定的工具，并改变所有消费者的公共解析契约，而不只是执行器。

### 在 agent-loop 入口过滤

loop 不是唯一的执行器调用方，且真正要紧的区分（模型直呼 vs 传输子调用）挂在执行输入上，不在 loop 边界。入口过滤还会重复编码注册表已经拥有的模式语义。

### 通过内置 guard 拒绝

guard 是可选的插件扩展；安全不变量不能依赖部署恰好组装了正确的插件。模式决策归注册表所有，必须由它自己执行。

### 只保留 schema 省略（维持现状）

没有提供方保证拦截未通告的名字；被报告的会话证明拦截不会发生。

## 后果

- `mode: 'ptc'` 现在兑现其通告：模型直呼原生工具变为 `UNKNOWN_TOOL`，模型可以通过改走 `run_code` 自行纠正（已中止的调用仍按取消契约解析为 `ABORTED_BEFORE_DISPATCH`）。
- `both` 与 `native` 行为不变；SDK 子调用不变（判别信号是 `parent` token）。
- 被塌缩的调用在 `prepare` 阶段即被拒绝——在可扩展策略流水线之前：pre-execute 监听器、approval `ask` 与 guard 永远不会观察到它。`executionMode` 同样 fail-closed（`exclusive`），调度无可观察差异。
- 原生工具指引段（`tool:read`、`tool:write`、`tool:bash` 等）保留在系统提示词中，因为它们同时描述了通过生成 SDK 及原生函数调用可用的能力，其中若干段还承载着任何单个工具描述都装不下的跨工具路由策略（`read` 优先于 `bash cat`、默认 fs-observation-policy 要求先 `read` 再 `write`、一两个委派用 `subagent` 而非 `workflow`）。防止模型直呼原生工具的是执行器塌缩，而非提示词过滤。
- 提示词会**声明**这条塌缩，位于 first-party 逐工具指导之前的 `tools:ptc-only` 段。那些段只写出工具名而不限定其可达方式，因此只读到它们的模型会发出原生调用，为一个同一份提示词刚刚声明过的工具收到 `UNKNOWN_TOOL`，进而判定部署不一致，而不是自行纠正。拒绝信息给出正确路径也是同一原因。TypeScript SDK 段在生成声明旁再次区分两者，将其标为只能在程序内使用的绑定，并说明只有单独提供的工具 schema 才赋予直呼权限。声明列表可能被误读为原生工具可用性，因此当当前 `bash` 参数 schema 接受示例参数时，该段会给出以 `run_code` 包住 `tools.bash(...)` 的完整调用。`both` 下该规则渲染为空：它的原生调用确实会执行，在那里声明就是假话——这也是 `both-mode-turn` 不再与 `ptc-turn` 共用期望提示词的原因。
- 未来任何设置 `parent` token 的组合传输，其子调用自动走全表，与该 token 已有的嵌套调用语义一致。
