# Agent Note: PTC mode 的类型化工具返回值

Status: implemented

[English](2026-07-20-ptc-typed-tool-returns.md) | 中文

## 问题

PTC mode 过去会把每个嵌套工具的结果从 `ContentBlock[]` 重新投影为一个字符串。这样虽然保留了适合人类阅读的 Native 呈现，却丢失了工具已经生成的规范结果：程序只能从自然语言中提取 job id 和动态挂载 id；结构化搜索与工作流结果失去原有形态；非文本块则变为占位符。生成的 SDK 可以描述参数，却无论工具实际输出为何都只能承诺 `Promise<string>`。

运行时还把绑定值和程序最终返回值当作展示数据。日志和完成值分别设置上限，导致过大或无法克隆的完成值可能被替换为检查后生成的文本，而中间值本来就不会进入模型上下文。这种设计使程序化组合产生信息损失，也混淆了内存边界与提示词边界。

[规范工具输出约定](../architecture/2026-07-20-canonical-tool-output-contract.zh.md)确立了单一、经过校验的执行期值，并将 Native 渲染器与之分离。PTC mode 应直接消费该值，在跨越 worker 边界时完整保留它，并且只限制程序有意返回给模型的最终输出。

## 决策

PTC mode 是可见工具注册表的类型化投影。每个成功的绑定调用都会解析为 post-execute 策略处理后的最终规范 `JsonValue`，失败的绑定调用则会以真正的 `ToolCallError` 拒绝 Promise。中间值只存在于本次运行中，并完整跨越 worker 边界。外层 `run_code` 的日志、完成值或失败诊断会进入可配置的输出账本以及面向模型的输出落盘流水线；如果成功结算的子调用最终 Native 内容包含图片，其完整有序内容还会经父结果延后为写入日志且带来源归属的上下文。

本文档定义叠加在原始 [PTC mode 基础](2026-06-15-ptc.zh.md)之上的返回值与失败约定。统一 schema 词汇由 [JSON 值 schema DSL Agent Note](../architecture/2026-07-20-unified-json-value-schema-dsl.zh.md)负责定义；Native 渲染与策略投影仍由规范输出 Agent Note 负责定义。

### 生成的 SDK

每次组装提示词时，注册表都会把每个可见工具的参数 schema 及其分离的规范输出 schema 投影为一份确定性声明：

```ts ignore-check
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface ToolArgsMap {
  // one exact inferred entry per visible tool
}

interface ToolOutputMap {
  // one exact inferred entry per visible tool
}

type ToolName = keyof ToolOutputMap

declare class ToolCallError extends Error {
  readonly name: 'ToolCallError'
  readonly toolName: ToolName
}

declare const tools: {
  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>
}
```

`jsonSchemaToTs()` 覆盖统一 schema 支持的所有节点：对象、数组、字符串、数字、整数、布尔值、null、无约束 JSON、标量 `enum` 与 `const`，以及 `oneOf`。提示词生成期间，不支持的原始结构会回退为 `unknown`，而不会导致组装失败。工具名会保留精确键名，包括必须使用引号访问的名称。

### 绑定值与失败

分发前，桥接层会把绑定参数快照为无损 JSON，再对分离后的值生成一次快照，供独立的持久摘要事件使用。宿主侧的值分离、执行数据的不可变处理与输出 schema 投影均采用迭代遍历，而不使用嵌套结构化克隆或递归冻结。`undefined`、非有限数、`-0`、稀疏数组、循环引用、函数和非普通对象都会使该调用在工具运行前被拒绝。成功分发会返回 `ToolExecutionResult.value`；Native `content`、元数据和内部错误信息不会传入程序。含图片的最终内容不是第二份绑定值：桥接层会在外层结果之后转运它，使下一次模型请求可以看到持久图片；post-execute 阻止／内容替换仍具有权威性，纯文本结果不会重复。

PTC mode 通过运行时请求中的 `{ name: "ToolCallError", memberNameProperty: "toolName" }` 声明其以异常拒绝 Promise 的能力。运行时 Service Definition 只把这些名称视为数据：worker 会动态生成并注入真正用于 `tools` 绑定失败的构造函数，因此无需让通用运行时了解工具，`error instanceof ToolCallError` 也能成立。worker 使用模块初始化时捕获的 Error 构造函数与属性定义内建方法，配合原型为 null 的属性描述符，构造失败对象并定义其公开字段，因此模型代码的修改不会把约定承诺的 reject 变成 worker 失败。该错误包含标准的 `Error` 消息和确切的 `toolName`，并有意省略 `ToolFailure.info`、错误代码与 Native 内容。这是一项用于控制流的异常约定，而不是供程序分类的失败联合。

绑定参数与绑定返回值会在不可信 worker 协议的两端重新校验为无损 JSON，且不设字节上限。每个分离后的值在通过结构化克隆跨越边界前，都会编码为扁平的前序 token 流，其传输结构的嵌套深度有界；接收方再以迭代方式重建该值。因此，有效应用数据的嵌套深度既不受 JavaScript 调用栈深度上限限制，也不受特定平台对嵌套结构化克隆施加的上限限制。模块初始化时，worker 会捕获自身 JavaScript 运行域中 `Array.prototype` 和 `Object.prototype` 的引用、仅用于识别其他运行域普通容器原型、可获取原生函数源码的内建函数，以及 JSON 边界用于结构处理和计量的全部内建方法。属性写入使用原型为 null 的属性描述符；内部的数组与集合操作直接调用捕获的方法，不会访问可变的全局或原型槽位。因此，即使模型代码替换 `Object.keys`、`Array.isArray`、集合方法、字符串方法或 `Buffer.byteLength` 等辅助方法，重写内建原型的构造函数槽位，或向 `Object.prototype` 添加形如属性描述符的字段，也不会改变校验、协议传输或字节计量。面向其他运行域的原生函数源码检查仍会拒绝由用户编写、冒充 `Object` 或 `Array` 的构造函数。为保持依赖轻量，运行时 Service Definition 将结构等价类型命名为 `CodeJsonValue`，从而无需依赖会话侧拥有的规范类型；生成的 SDK 和工具 API 则使用 `JsonValue`。这些值不会经过提示词截断、上下文 spill 或持久化。因此，程序可以完整筛选已经采集的搜索、工作流、任务、文件系统与 MCP 值，同时提供方和执行器的采集上限仍会实际生效。

### 外层结果与输出账本

运行时接受以任意 JSON 类型为根的精确无损完成值。返回 `undefined` 表示省略完成值；返回 `null` 则是显式结果。`run_code` 暴露规范外层值 `{ logs: string[], result?: JsonValue }`。其 Native 渲染器先输出日志；字符串结果保持原文，其他所有 JSON 根值则使用迭代式美化渲染器。总缩进长度上限为 10 个字符，更深的子树保持紧凑格式，既保留既有的浅层文本，又确保遍历不受调用栈深度限制，且格式化输出大小与规范 JSON 大小呈线性关系。

`WorkerThreadCodeRuntime` 以可配置的 `maxOutputBytes` 取代彼此独立的日志与值上限，默认值为 `67_108_864` 字节。worker 会将已捕获日志序列化为 JSON 字符串后的精确字节数计入账本，并在发送终态消息前，根据组合账本的剩余额度预检分离后的完成值或程序异常。因此，即使抛出的字符串或堆栈极大，通过 worker 端口的也只会是固定的 `output-limit` 诊断。宿主侧会针对伪造流量以及 worker 无法观察的原生管道写入，重复执行这套面向不可信对端的账本校验。固定的 `CodeRunResult` 字段名、花括号、有界的错误类型标签及后续展示空白有意不计入这份可变负载账本。这两个阶段都不会实际生成超出上限的完成值序列化结果。结果不超过上限时会保持精确。完成值无法通过无损 JSON 快照时，以 `invalid-output` 失败；值、诊断或包含日志的组合结果超过上限时，以 `output-limit` 失败，而不会变成检查格式化后或截断的文本。

日志会在产生时立即流出，因此运行被终止时仍可保留已经纳入额度的输出。绕过 worker 中已改写流写入入口的原生 stdout 和 stderr 写入会经由彼此独立的管道传输，因此运行时在终态结算期间仍会继续在上限内捕获输出，直至 worker 完全终止，然后才组装结果。超过上限后，运行时会返回一个显式的有界失败，并携带可容纳的已捕获前缀。该外层结果随后通过普通的 `run_code` 渲染与 spill 策略；策略可以保存已捕获的文本，并暴露其配置指定的头尾预览。spill 层无法恢复运行时在硬上限之外拒绝的字节。

计算时间、墙钟时间、worker 堆内存、取消和每次运行使用全新 worker 的隔离仍是互相独立的限制。外层账本从不计入中间绑定值，因此生成快照、扁平协议格式的编码与解码、结构化克隆开销，以及进程或 worker 的可用内存构成了这些值的实际边界。

### 类型化句柄与生命周期

后台生产方返回类型化的规范句柄，例如 `{ kind: 'background', jobId }`，同时保留既有的 Native 语句。已预先中止的后台调用仍是失败，因为成功输出承诺返回 id，而此时并未创建任务。`ctx.jobs.start()` 发布 id 后，工作由任务自有的取消机制控制：外围 `run_code` 调用完成，或随后被取消，都不会终止该任务。后续程序可以把返回的 id 传给 `job_output`；任务取消则由 `job_kill`、所有者的 dispose（资源释放）或服务 teardown 流程负责。前台执行仍与本次调用的信号耦合。任务生命周期约定由[后台任务运行时 Agent Note](../architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)定义。

临时 Cordis 插件遵循同一规则：`cordis_mount` 返回 `{ id, pluginName, state, provides, waitingFor }`，因此程序可以直接读取 `mounted.id`，检查 active 或 pending 状态，并把该 id 传给 `cordis_unmount`，无需解析稳定的 Native 语句。

### 持久化、元数据与 spill

嵌套分发在 `tool/code-dispatch` 上记录子调用完整渲染后的 `content`/`isError`，但不会持久化规范值。`tool/result` 继续只持久化渲染后的内容、错误和可选元数据。包含图片的成功最终内容序列还会包装成带来源归属的用户消息，并经外层结果延后；普通会话事件使该模型可见输入可以重建。该功能本身不要求结构性 Session 格式变更；已发布的 v0-to-v1 恒等边会保留这些记录，回放仍无法重建程序的规范中间值。

不透明的 `exec.parent` token 用于标识嵌套调用。由于这些调用没有直接对应的结果卡片，而且其规范值永远不会进入上下文，展示元数据以及通用或工具自有的 spill 投影都会跳过它们。只有外层 `run_code` 调用会生成一张卡片，并且可能对 post-policy 处理后的最终展示执行 spill；`run_code` 有意既不声明结果展示器，也不声明展示元数据，因此 UI 适配器会通过通用的原始内容回退机制，使用持久化的 `tool/result.content` 补全该卡片。

## 测试

编译期测试与快照测试锁定了精确的 `ToolArgsMap`、`ToolOutputMap`、`ToolName`、schema 到 TypeScript 的覆盖范围、特殊名称，以及组装后的 PTC mode 图片转发。注册表与真实 worker 测试覆盖标量、数组、对象和 null 值；字符串原文渲染；缺席的 `undefined`；消费方声明、实际用于拒绝 Promise 的异常类，包括 `ToolCallError`；无效参数与完成值，包括伪装为内建原型的伪造原型；模型代码修改过的 JSON 边界全局对象、原型方法、构造函数槽位，以及继承而来的属性描述符字段；上述修改后的类型化绑定失败；不设上限的大型中间绑定值；嵌套输出落盘抑制；通用含图片上下文延后以及 post-execute 替换／阻止优先级；64 MiB 上限内外的精确计量；日志、值与诊断的组合计量；抛出的超大堆栈；有界失败的输出落盘；不可信对端伪造的流量；以及构建后包的执行。

无密钥的真实 worker 集成测试锁定了自然语言结果无法安全支持的两种句柄工作流。后台 bash 调用返回 job id，外层运行结束，之后的运行再根据该 id 轮询直至任务完成；其他用例分别证明，预先中止不会创建任务、发布后的调用取消会保留任务、前台执行仍与信号耦合，并且由 `job_kill` 负责取消。Cordis 程序会直接读取 active 或 pending 挂载的 id 和 `waitingFor` 字段，按该 id 卸载，并在不解析渲染文本的情况下确认挂载已移除。

## 考虑过的替代方案

**返回 Native 文本并附加可选 JSON：**不予采纳。程序会面对两套相互竞争的成功约定；可选值不存在时，仍需使用工具专属的解析规则。规范值才是 API；Native 内容只是它的展示。

**让每个绑定返回成功／失败联合：**不予采纳。失败没有稳定的程序化分类体系。reject 保留普通的 `try`／`catch` 控制流，并且只暴露工具名与可供人阅读的消息。

**限制每个中间绑定值：**不予采纳。中间值不会进入模型上下文，任意截断会破坏程序化组合。明确的边界仍是生产方的采集约定与进程内存。

**静默检查格式化或截断过大的完成值：**不予采纳。把 JSON 值改成字符串既有损又违反类型。显式的 `output-limit` 失败让模型可以选择返回更小的结果，而保留的日志和诊断仍可使用普通的外层 spill 机制。

**要求每个丰富叶子工具检查 `exec.parent` 并自行延后。** 不予采用，因为这会把叶子工具与 PTC mode 内部机制耦合、重复策略处理，并遗漏未来丰富工具。分发桥接层负责从已经结算的最终结果通用转发。

**把 Native 丰富内容暴露为每个绑定规范值的一部分。** 不予采用，因为规范值是无损 JSON 且由工具定义；附件块是具有持久生命周期语义的模型投影。保持值与投影分离，既能保留类型化程序，也不会从后续模型上下文中丢弃图片。

## 后果

PTC mode 程序可以通过稳定值组合工具，无需逆向解析 Native 自然语言。Native 和 Both Mode 保留现有文本与 UI 展示，PTC mode 则获得输出 schema 类型和精确的运行时 JSON。工具作者必须把规范值视为程序化 API，并将仅用于展示的格式化放入渲染器。

worker 会以嵌套深度有界的扁平协议格式传输数据并执行无损校验，但不会降低中间值的开销，也不会使其具备持久性。外层输出溢出会显式导致运行失败，错误处理则有意由人类引导，而不是依赖带版本的错误代码联合。

## 已知限制与暂缓事项

- 即使工具输出可以采用任意 JSON 根，subagent 和工作流中由调用方定义的结构化输出仍通过消费方级别的门禁保持对象根限制。
- Post-execute 分别提供值投影与展示投影；替换内容不是保密机制，因此策略若需向程序化调用方隐藏内容，就必须阻止调用或替换值。
- 中间规范值仅存在于执行期间，无法用于回放，因为持久事件只存储展示和有界摘要。
- 中间值没有字节上限，可能因值的保留、扁平协议格式副本或结构化克隆开销而耗尽进程或 worker 内存。
- 64 MiB 硬上限只适用于外层可变负载，不计固定的结果封装语法与展示空白；spill 无法恢复超出该上限后被拒绝的字节。
- 提供方或执行器的采集上限可能在规范值到达 PTC mode 前就已丢弃部分源数据。
- 不支持的 MCP 输出 schema 会回退为 `JsonValue`；已准入的 MCP 图片使用通用延后投影，而音频和嵌入资源载荷仍只提供诊断。
- 每个外层 `run_code` 只有一张结果卡片，嵌套调用不会各自生成卡片。
- PTC mode 失败只暴露 `ToolCallError` 的消息与工具名，不提供程序可用的错误代码联合。
