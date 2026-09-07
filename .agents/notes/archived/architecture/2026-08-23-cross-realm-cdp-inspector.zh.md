# Agent Note: 跨 realm CDP Inspector

Status: implemented
Archived: 2026-09-04

[English](2026-08-23-cross-realm-cdp-inspector.md) | 中文

## Problem

Host 诊断、浏览器 Client 观测和 JavaScript 调试来自不同 JavaScript realm。Host 主线程上的 debugger transport 无法在该线程暂停时投递 `Debugger.resume`；若每个 producer 直接生成 CDP，又会重复协议状态，并把应用观测逻辑绑到 Chrome 呈现协议。

## Decision

`@deepseek-ai/dsh-experimental-inspector` 是一个私有 Client/Host 双面 Cordis 插件包。Host 面启动 Node Worker，Client 面直接连接该 Worker。Cordis 只负责组合、服务发布、bootstrap 注入与 dispose；source 协议、Worker 状态、CDP server、V8 bridge 和 domain adapter 不检查 Cordis 运行时数据。

Worker 是唯一 CDP endpoint，也是 CDP 状态的唯一 owner。Host 与 Client producer 通过有版本的内部协议发送验证后的观测记录；Client Runtime、Console、Sources 和语义查询在同一条鉴权 carrier 上使用相互独立的类型化帧。realm registry 为每条 DevTools 连接提供相同的 Runtime、Console、Sources 和 Debugger capability slot，并用明确的 unsupported 成员保留 Host 与 Client 的支持差异。

## Realm 所有权

Host 主线程拥有应用对象和 `globalThis.fetch`。它通过专用 `MessagePort` 发送观测记录，绝不构造 CDP 消息。

Client 页面拥有浏览器观测、求值得到的值和 Client object handle。它通过带鉴权的 ingest WebSocket 直接与 Worker 交换 JSON 帧，因此 Host 暂停不会阻断 Client 投递或 Runtime 执行。

Inspector Worker 拥有 HTTP discovery、两条 WebSocket route、source generation、保留历史、realm session、CDP session 和 domain adapter。每条 DevTools 连接为 Host 和每个已连接 Client realm 分别建立一套 backend session。V8 object id 只留在 Node Runtime backend 内。Client object handle 只留在类型化 Client 协议内。单个 connection-local object table 把两类 backend handle 映射成 CDP object id，并投影同一种 RemoteObject、property、exception、Console 与 paused-frame 类型。

Chrome DevTools 消费一个 page 类型 target。Runtime 方法按 execution context 或 object id 路由；Debugger source 方法按 script id 路由。Host script 保留原生调试，Client script 只暴露只读内容，并拒绝 active debugging。`Profiler` 与 `HeapProfiler` 仍然只属于 Host；`Network` 与最小 page-target scaffold 在 Worker 内执行。

## Source 协议

MessagePort 与 WebSocket carrier 使用同一组 JSON 值和判别联合帧。source 标识一个逻辑 producer 和一个连接 generation，声明 capability 与 topic，发送初始 replace，再追加带 sequence 的 batch。Worker 在读取 domain 字段前拒绝畸形、超限、旧 generation 和未声明 topic 的帧。

投递有序且尽力而为。producer 不在应用路径上等待 acknowledgement。有界 producer 队列通过 sequence gap 报告被丢弃的前缀；Host MessagePort carrier 同时只允许一个 append batch 在途，并在 Worker 确认消费后发送下一批。无法解释的 gap 会让 Worker 请求新 snapshot。domain store 只保留有界状态，并在 source 断开时明确关闭未完成操作。

Runtime 帧使用封闭的 command 与 result 联合，而不是 method 字符串加无类型 parameter record。每个 request 携带 source id、source generation、DevTools Runtime session id、request id 和 command；每个 result 重复这些身份与 command 判别符。Console lifecycle/event、分块 source 读取和非 CDP 语义查询使用各自独立的关联帧。RemoteObject value、preview、property descriptor、call argument、exception、Console event、debugger frame、script 与 error 都有独立的精确 decoder。

## Client Runtime、Console 与 Sources

`Runtime.enable` 发布 Host 的真实 execution context，并为每个声明 Runtime 能力的已连接 Client source 发布一个负数 id synthetic execution context。不指定 context 仍然表示 Host。Client source replacement 会销毁旧 context，并以新的 generation 与 unique id 创建新 context。

Client Runtime 子集包括 `Runtime.evaluate`、`Runtime.getProperties`、`Runtime.callFunctionOn`、`Runtime.awaitPromise`、`Runtime.releaseObject`、`Runtime.releaseObjectGroup` 和 `Runtime.globalLexicalScopeNames`。Client 在页面 realm 中执行命令，并在按 DevTools Runtime session 隔离的表中保留实时对象。Client 只返回不透明 handle 与 JSON-safe metadata；Worker 验证结果并分配连接私有的 CDP object id。对象参数只能由同一 Client source generation 与 DevTools session 使用。source 断开、Runtime disable、DevTools 关闭、释放对象或释放 object group 都会移除对应 handle。

JavaScript exception 是携带 `exceptionDetails` 的成功 Runtime response；transport failure 使用独立的 error 联合。Worker deadline 会向 Client 发送 request-scoped cancellation。response 分配的 handle 在 Worker 确认该 response 前保持 provisional，因此 cancellation 和 late response 不会留下无法访问的对象。有限的命令 deadline、对象数、属性数、source 字节数与帧字节数约束保留或返回的状态。

Client Console observer 保持原始页面调用行为，并为每个已启用的 DevTools session 异步发出一份 event。每个 session 把 argument 序列化到自己的 `console` object group，因此断联、Runtime disable 或 `Runtime.discardConsoleEntries` 可以释放一条连接而不使其他连接失效。Context 与 Fiber argument 使用和求值结果相同的语义引用及 DOM 反向映射。

Client 从组装后的 web boot graph 发现本包 `lib/client.js` 的 URL。`Debugger.enable` 通过类型化 source operation 读取 metadata，`Debugger.getScriptSource` 重组有界 base64 chunk；source map 保持在公布的 URL 上可用。Client script breakpoint、step 与 call-frame 操作明确不受支持，因为页面 JavaScript 无法暂停自身 realm 后继续处理控制消息。target-wide pause 与 resume 继续控制 Host debugger。

## Host 调试

Worker 为每条 DevTools 连接建立独立 Node inspector Session，并连接 Host 主 isolate。Node Runtime、Console、Sources 与 Debugger backend 把原生 value 和 event 归一化成 Client backend 使用的同一种 realm model。公共 projector 为求值结果、Console argument、paused scope 和 call-frame result 分配 connection-local object id。breakpoint request 到达 Node 前会反向转换成原生 backend handle。默认 context 可以改显示名为 `Host`，但保留真实 id 和 metadata。

Host JavaScript 暂停时，Worker event loop、DevTools socket、Client ingest socket 与 Node inspector Session 仍可运行。Host 观测自然暂停到 resume。

## Fetch 采集

fetch 采集包装 `globalThis.fetch`，并默认开启。之后每次 fetch 都记录完整 URL、headers、请求体、响应 headers、响应体、时间、取消与错误。默认不脱敏任何字段；启用 Inspector 即把这些秘密交给本机 DevTools。

wrapper 把标准化 Request 交给原 fetch，通过独立采集任务读取 request/response clone，并在 fetch resolve 后立即把原始 Response 交给调用方。采集失败不得改变调用方的 fetch 结果。有限的单体与 journal 预算阻止无界保留；超过预算时保留已采集前缀并报告截断。

## Alternatives considered

**在 Host 主线程运行 CDP server。** 拒绝，因为断点会冻结负责投递 `Debugger.resume` 的 socket。

**经 Host web server 中转 Client 观测。** 拒绝，因为 Host 断点同样冻结中转，并使 Client 数据路径依赖 Host 响应。

**让 producer 直接生成 CDP 消息。** 拒绝，因为 Chrome 专用 request id、回放、enable 状态和排序会落入 producer，而不是领域观测。

**多个 DevTools client 共用一个 Node inspector Session。** 拒绝，因为 object id、object group、enable 状态与 debugger 操作属于单个协议 session；共享需要易错的虚拟 session 层。

**通过 WebSocket 发送 Client 实时对象或 CDP object id。** 拒绝，因为 JSON 无法保留对象身份或行为，而 CDP object id 只属于一条 DevTools session。Client-local handle 加 Worker 所有的逐连接映射同时维护这两条所有权规则。

**使用一个无类型 Runtime RPC method。** 拒绝，因为 method 字符串和任意 parameter object 无法保证 command/result 关联、对象引用所有权，也无法在 Runtime、Sources 与 Debugger 支持增长时做穷尽演进。

**把 protocol、Host 与 Client 拆成多个包。** 实验阶段拒绝。一个包保持能力以一个 Client/Host 插件部署，同时由源码目录与构建入口维护 realm 边界。

**用 Undici diagnostics channel 作为完整 fetch 数据源。** 拒绝，因为它能观察 transport lifecycle，却无法在不消费应用 stream 的前提下提供完整 request/response body。后续可以用它补充 transport 级 timing。

## Verification

- 真实 Worker 同时接收 Host MessagePort 与 Client WebSocket source，并通过一个 CDP target 暴露两者。
- 畸形、超限、旧 generation 与 sequence gap 帧不会破坏其他 source 或 Worker。
- Console 在 Host context 求值并接收 Host console event。
- Console 列出 Host 与 Client context；Client 求值、属性、函数调用、Promise await 与释放操作维持 RemoteObject 身份，且不在 realm 或 DevTools 连接之间共享对象。
- Host 与 Client Console event 使用相同 projector；Client argument 按 DevTools 连接隔离，Cordis argument 可以解析到 Elements node。
- Sources 接收 Host script 与构建后的 Client bundle；Client source 读取采用分块传输，active debugging 明确失败，而 Host 仍可被断点暂停、求值 call frame 并 resume。
- Host paused scope 与 call-frame result 使用和 Runtime 求值相同的 connection-local RemoteObject table。
- Network 回放 `Network.enable` 前的请求，并无遗漏、无重复地推送后续请求。
- 成功、失败、取消、重定向、文本、二进制、流式与截断 fetch 都保持调用方行为，并暴露配置允许的完整采集数据。
- dispose 停止采集、关闭入口、断开 V8 session、关闭 socket，并等待 Worker exit 后完成。

## Consequences

Worker 所有的 endpoint 在 Host JavaScript 暂停时仍保持 DevTools 控制可响应，并让 Host 与 Client 观测共享唯一 CDP 状态 owner。这项所有权带来以下安全、资源与兼容性成本。

完整 fetch 采集会有意把 credential 和 payload 暴露给任何能连接 CDP endpoint 的本机进程。loopback 监听是强制要求，但不是鉴权。

clone request/response stream 会增加 CPU、内存与 I/O 压力。有限预算能约束保留字节，不能让完整采集没有成本。

page 类型 synthetic target 依赖 Node 原生 inspector domain 之外的一组 Chrome DevTools 兼容响应。每个 no-op 都必须明确命名并有测试；统一吞掉未知方法会掩盖协议漂移。

Client Runtime 执行使用页面 JavaScript 求值，因此页面 Content Security Policy 可能拒绝它，也不承诺原生 DevTools command-line 或 REPL 语义。只读 Client Sources 不代表 active Client debugging；增加该能力需要一个在被检查页面 realm 暂停时仍能响应的执行 agent。
