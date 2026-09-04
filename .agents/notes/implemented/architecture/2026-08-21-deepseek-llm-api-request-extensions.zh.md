# Agent Note: DeepSeek LLM API 会话日志与插件包请求扩展

Status: implemented

[English](2026-08-21-deepseek-llm-api-request-extensions.md) | 中文

## 问题

权威会话日志包含请求边界、原始响应分片、组装后消息、工具活动、插件事件与失败事实，模型消息列表无法保留全部内容。OTel 会话遥测路径独立于模型请求投影和批处理该日志，使用部署方选择的共享模式，并刻意丢弃大多数 assistant 分片。因此，DeepSeek 官方 API 无法从普通请求消息或遥测流重建完整 harness 轨迹。

提供方侧诊断还需要产生当前请求的确切存活插件包版本。现有面向浏览器的插件清单会报告已配置 Loader 配置项与生命周期阶段，但既不拥有包 manifest（元数据清单）解析，也不拥有请求 Agent 的 standing preset 组合。

两个值都只属于 DeepSeek 官方适配器路径。把它们加入 `GenerateOptions` 或提供方无关的 LLM seam，会让 pi-ai 与未来每个适配器接触 DeepSeek 协议概念。

## 决策

`@deepseek-ai/dsh-deepseek-llm-api-extensions` 注册 `ctx.deepseekLlmApiExtensions`，即 `deepseek-official` 请求正文顶层字段的增量注册表。贡献方通过 `register()` 认领一个经声明合并的字段。适配器在序列化确切协议消息后调用 `prepare()`、传入请求取消信号，在 HTTP 前拒绝准备失败或基础字段冲突，合并分离字段，并在 HTTP 2xx 后调用捕获的 `accept()` 事务。即使贡献方忽略信号，注册表也会在取消后停止等待准备。接受失败仍以 `REQUEST_EXTENSION` 使请求失败；传输失败与非 2xx 失败绝不会接受贡献。未挂载注册表的组合会保留可复用基础适配器。随附组合会挂载注册表与两个贡献方：插件包元数据默认开启，会话日志上传默认关闭，需要设置 `session-log-deepseek.enabled: true`。无密钥 `deepseek-official` 回放会使用合成的空基础正文执行准备，并在第一个已记录分片前调用同一接受事务；它保持的是 2xx 后扩展副作用，而非字段字节。

提供方无关的 `llm` 包与 `llm-pi-ai` 不包含任何扩展类型、服务查找、字段合并或接受调用。

## 增量会话日志字段

`@deepseek-ai/dsh-session-log-deepseek` 以显式选择启用的方式拥有 `dsh_session_log`。启用后，每个携带存活会话 id 的请求都会发送该确切会话身份最大持久 `session-log-deepseek/delivery-accepted` 水位之后的连续权威事件后缀。该字段包含不可变会话 header 与完整事件信封。2xx 会为已发送的 `throughSeq` 追加新水位；该事件会进入下一次请求的后缀。Fork 日志会保留父级水位 id，因此子会话会在自己的身份下从序列零开始。并发接受可能乱序到达，最大水位仍保持权威。进程内 fold 会让每条会话事件只被扫描一次，并增量消费后续追加；新的会话对象或 HMR generation 会从持久历史重建该 fold。

失败方向为至少一次。传输失败或提供方拒绝不会记录水位。远端接受后、水位持久化前发生崩溃，会在恢复后触发重放，绝不会跳过序列。现有会话检查点会持久化该事件；上传插件不拥有第二份存储。

`events` 数组会直接包含完整的权威 `SessionEvent` 对象。发送方会复制事件的每个已有成员，不执行投影或脱敏；该字段自包含，无需根据 `messages` 重建内容。

## 插件包字段

`@deepseek-ai/dsh-plugin-package-inventory-deepseek` 从 `llm` 包家族中拥有默认开启的 `dsh_plugin_packages` 字段。它会读取宿主 Loader 树的存活非 group 配置项，并为存活请求 Agent 读取其 standing preset 树。Node 包解析会定位所属 manifest，无需导出 `./package.json`。普通配置项从其所属树解析；standing preset 根会复现 Loader 对宿主基址的显式覆写，嵌套 include 则保留自身基址。最近的匿名 manifest 会标记松散模块；具名 manifest 必须带有版本。系统以确定性顺序按确切名称／版本对去重，同时存活的不同版本仍会分开保留。

禁用、pending、failed、unloading、disposed、结构性、松散非包、普通依赖、编程式子 fiber 与内存动态插件配置项都不属于该包清单。这个定义会报告运行时可以证明的包支撑组合事实，而不会为任意回调发明来源。

## 暂缓的清单 cache

当前实现会为每个请求重新计算存活包集合，同时在进程生命周期内 cache manifest 身份。一项仅含宿主树的合成基准测试使用 Node v24.16.0 与 macOS arm64，测试对象为各不相同的存活相对插件包；测试先预热 20 个请求，再对 25 项和 100 项场景分别测量 500 个请求，对 500 项场景测量 250 个请求。「首次请求」包含未 cache 的 manifest 读取；「已 cache 提供方中位数」通过同一注册表返回预构建字段，因此仍包含 `structuredClone()` 与冻结开销，但不包含适配器 JSON 序列化和网络时间。

| 存活配置项 | 首次请求 | 当前稳态中位数 | 当前稳态 p95 | 已 cache 提供方中位数 |
|---:|---:|---:|---:|---:|
| 25 | 1.23 ms | 0.05 ms | 0.07 ms | 0.02 ms |
| 100 | 2.23 ms | 0.14 ms | 0.24 ms | 0.04 ms |
| 500 | 10.22 ms | 0.60 ms | 0.79 ms | 0.18 ms |

这些测量结果支持继续暂缓 cache：即使存在 500 个配置项，稳态耗时仍低于 1 毫秒；在不可避免的 JSON 序列化之前，预计节省约 0.42 毫秒。加入 cache 的触发条件是真实 profile 显示 `prepare()` 延迟达到实质水平，而不是固定的配置项数量阈值。

暂缓设计使用一个单调递增的清单 epoch。全局 `internal/status` listener 会在 Loader 配置项的根 fiber 跨越 `FiberState.ACTIVE` 边界时推进该值，从而覆盖依赖激活、禁用、卸载与 HMR，且不会产生基于时间的陈旧窗口。贡献方按 epoch cache 宿主快照，在 `WeakMap` 中 cache 每个 standing preset `EntryTree`，并按树与 epoch cache 宿主加 preset 的合并结果。系统以线性时间合并已经排序的快照，并对确切 `(name, version)` 对去重。计算完成前 epoch 发生变化时，系统会重试而非发布陈旧快照；已 dispose 的 preset 树仍可通过 `WeakMap` 被回收。

进程生命周期内的 manifest 身份 cache 保持独立，因为系统不支持在进程内替换包版本。

## 验证

注册表测试固定重复所有权、effect 作用域 dispose（资源释放）、分离字段值、并发且可取消的准备、保留接收者的接受操作、单次接受结算与失败聚合。会话测试固定默认关闭策略、显式启用后的首次完整／后续后缀交付、与基础正文消息无关的直接完整事件信封、增量水位 fold、持久化重启恢复、fork 身份围栏、乱序接受与 invariant 延迟加载。插件包清单测试固定默认开启与显式关闭策略、宿主与 standing preset 发现、冲突的 Loader 解析基址、manifest 解析、生命周期过滤及确切名称／版本排序。直接适配器 mock 测试证明 HTTP 前准备失败、取消、非 2xx 不接受、2xx 在后续流失败前接受，以及字段冲突。无密钥回放会固定 2xx 后扩展接受，TypeScript JSON-RPC 与 Python 打包运行时快照则通过两套 SDK 投影接受事件。真实 Loader 组合会固定默认包元数据与显式启用的会话上传，一个真实 API 请求会挂载两个随附扩展并证明官方端点接受它们；pi-ai 测试保持其协议请求不变。

## 考虑过的替代方案

**向 `GenerateOptions` 或 `ctx.llm` 添加通用元数据。** 已否决，因为这些值与接受时点属于 DeepSeek 协议语义；提供方无关请求会迫使每个适配器理解或忽略外来字段。

**把两个提供方硬编码进 `llm-deepseek`。** 已否决，因为适配器将导入会话、Loader、preset、包 manifest 与游标逻辑。注册表让传输只负责字段合并与 HTTP 接受。

### 为什么不使用请求相对消息引用？

一种递归的带标签表示可以用所属请求 `messages` 中的路径与 UTF-8 字节偏移，替换事件字符串的确切范围。测量使用 Node v24.16.0、macOS arm64 与可用的三份最大本地 Zstandard 会话产物；其压缩产物大小分别为 2,437,052、572,602 与 118,811 字节。延迟启用回放使用各会话最后一个已完成请求边界；稳态回放覆盖 411 个已完成边界。字节数覆盖完整且最小化的 DeepSeek 请求。

| 回放方式 | 原始 JSON | 引用 JSON | 节省比例 | 同步编码器耗时 |
|---|---:|---:|---:|---:|
| 延迟启用 | 29,668,725 B | 27,645,825 B | 6.82% | 合计 500.1 s |
| 稳态 | 389,295,815 B | 387,180,848 B | 0.54% | 合计 285.0 s |

三次延迟启用调用分别耗时 470.5、29.4 与 0.158 秒。115,071 个事件中只有 701 个（0.61%）选择引用。一项假设采用 level-6 整请求 gzip 的对照，使原始请求字节在延迟启用场景减少 89.38%，在稳态场景减少 73.42%；加入消息引用后，gzip 结果分别额外减少 21.68% 与 0.59%。

接收方还需要遍历带标签树、解析通向确切请求消息的路径、校验 UTF-8 范围，并重建每个引用事件。即使把接收方成本视为零，稳态字节节省、发送方同步成本以及对另一请求字段的依赖，也不足以支撑带版本的协议格式。

### 为什么不省略 assistant 分片或重叠事件数据？

实测 v1 真实 Session event 中约 98% 为 `assistant/chunk`。在引用编码后省略它们，会让完整 identity JSON 在延迟启用场景进一步减少 84.79%，在稳态场景进一步减少 6.49%，但会阻止无损重建并让 message provenance 悬空。V2 把紧凑 stream 嵌入 attempt settlement；`dsh_session_log` 仍会完整发送每个当前规范 event，且不会省略这些嵌入式 record。模糊或规范化替换也有相同重建缺陷。

**只在内存中保留上传游标。** 已否决，因为普通进程重启会重发完整会话。权威接受事件让重启恢复获得尽力而为的持久性，无需另一存储后端；剩余崩溃窗口只会产生允许的重复。

**清点每个存活 Cordis fiber。** 已否决，因为编程式与内存 fiber 没有权威 NPM 包来源。Loader 支撑的宿主与 preset 配置项能提供可精确解析的包身份。

**cache 一份全进程清单，或按 TTL 使其过期。** 已否决，因为单份不可变清单无法正确反映 Loader 生命周期与逐会话 preset，TTL 则允许元数据在过期边界之间保持陈旧。暂缓的 epoch 设计会根据权威存活状态转换执行失效。

**用内容 hash 或服务端清单引用替换完整字段。** 已否决，因为它会改变独立请求的重建方式，需要端点状态与后续协议版本。这属于请求字节协议变更，而不是计算 cache 优化。

## 后果

DeepSeek 官方请求会把存活包版本发送到解析后的 `baseURL`，包括已配置 gateway。显式选择启用会话日志后，请求还会携带完整的未接受会话新后缀。这些字段对模型不可见，不增加提示词 token，也不改变 KV Cache，但可能显著增大 HTTP 正文。Manifest 解析、字段冲突、接受记录或提供方 schema 拒绝会使模型请求失败，而不会静默丢弃元数据。

`delivery-accepted` 事件会成为权威日志的一部分，并在后续请求中自行交付。崩溃恢复可能重复后缀，但不会根据 assistant 输出推断接受，也不会创建第二份本地游标存储。缺少存活会话的直接调用会省略会话字段；宿主包清单仍然可用。

[DeepSeek 请求身份决策](../feature/2026-08-11-deepseek-request-user-id-header.zh.md)继续拥有 user／session header，且这些 header 仍位于正文之外。[会话遥测决策](../feature/2026-07-23-session-telemetry-otel-revival.zh.md)在另一项变更删除该 seam 与后端之前仍保持当前有效；本请求路径不改变 OTel 捕获或共享模式。
