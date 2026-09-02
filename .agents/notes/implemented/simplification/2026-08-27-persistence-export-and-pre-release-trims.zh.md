# Agent Note: 持久化 export() 与预发布读取路径精简

Status: implemented

[English](2026-08-27-persistence-export-and-pre-release-trims.md) | 中文

## 问题

会话持久化 seam 正在迁移到基于句柄、具备跨进程所有权的 API（每个会话的 open/read/append/flush/close）。在这次替换之前，旧 seam 携带着新设计将放弃或替换的多个表面，每个都有自己的消费方与测试：面向消费方的路径查询（`locate`）、由能力标志控制的逐字读取（`supportsRawArtifacts` + `readRaw`）、协调器中约 300 行的同版本 legacy 事件形态迁移，以及会话列表冷空白探测使用的基于 `locate` 的大小门槛。若在 seam 替换中一并移除它们，会让本已庞大的变更进一步膨胀；先移除它们能把核心替换缩小到 seam 本身。

## 决策

**单一逐字导出方法。**`SessionPersistence.export(id, signal?)` 返回该会话的原始产物（`SessionRawArtifact`：解析后的 header、逻辑文件名、解码后的逐字文本）或 `undefined`。基类默认解析为 `undefined`；JSONL 用原先的 `readRaw` 行为覆盖它。`supportsRawArtifacts` 与 `readRaw` 不复存在。apiproxy 的 ZIP 下载通过 list 成员关系而非能力标志区分不受支持的后端（会话存在于 `list()` 中但 `export()` 为 undefined → 501）与不存在的会话（404）。已被[句柄 seam](../architecture/2026-08-27-handle-based-session-persistence.zh.md)取代：WebUI 下载只需要逻辑日志，因此 `export()` 被整体移除，ZIP 路由改为从读句柄序列化 JSONL，501 路径随之终结。

**不提供面向消费方的路径查询。**`locate` 不是服务方法。`SessionLocation` 仅作为拒绝诊断保留：JSONL 后端在内部推导工件路径，使 `SessionFormatUnsupportedError` 能指向构建所拒绝的原始日志。基于 `locate` 构建的三项消费方功能被移除或降级，而非移植：

- `DSH_SESSION_JSONL` 不复存在；shell-env 不再注册持久化贡献方。该变量只有在 `compression: 'none'` 时才是诚实的——默认的 `.jsonl.zstd` 产物无法从 bash 读取。
- Claude Code／Codex 钩子桥接层为保持协议格式，仍在线上 payload 中保留 `transcript_path`，但始终发送 `''`／`null`。钩子脚本同样无法解析压缩产物。
- session-controller 冷空白探测中基于 `locate` 的大小门槛被删除。探测本身运行在 stat 元数据之上：[基于句柄的 seam](../architecture/2026-08-27-handle-based-session-persistence.zh.md) 的 `stat()`/`list()` 快照携带可选的 `eventCount`/`sizeBytes`，session-controller 以 `coldBlankProbeMaxEvents`/`coldBlankProbeMaxBytes` 限定探测；超过两个阈值的冷会话，或位于两种提示都不提供的后端上的冷会话，报告 `blank: false`（未知）。

**删除 legacy 事件形态迁移。**读取只校验当前 v0 记录。已废弃的事件类型（`steering/message`、`mode/set`、`request/header-delta`）经由读取侧词汇门禁以 `SessionFormatUnsupportedError` 拒绝。消息标识机制之前的消息 payload 与 `request/header` 的 `fallback` 原因经由会话校验拒绝——在 load/inspect 路径上表现为 `SessionPersistenceCorruptionError`，在 `readFrom` 上表现为普通校验错误。react-loop 重构之前的轮次 envelope 没有校验器：过时的 `turn/start.trigger` 字段与粗粒度的 `aborted`/`disposed` 轮次结束原因会作为扩展形态数据不经投影地加载，这正是约定测试 "preserves extension turn/end reasons outside the closed reason set" 所钉住的、有文档记载的可合并扩展 fall-through。此举合并并取代了 pre-identity-message 与 pre-react-loop 两份导入 Note；其记录保存在下文。

## 已删除的同版本导入的合并记录

曾存在两个已上线的读取侧导入，因为消息标识机制（2026-07）与 react-loop 重构（2026-08）在未升级 `SESSION_FORMAT_VERSION` 的情况下改变了持久 payload：协调器会归一化四种精确的 pre-identity 消息 payload（铸造确定性的 `legacy-message:<id>:<seq>` 标识，工具结果替换项继承其目标的 id），并投影 pre-react-loop 形态（`steering/message` → 带标识的 `user/message`、移除 `turn/start.trigger`、终止原因映射——包括仅存在于持久化中的 `{ kind: 'legacy' }` aborted 原因）。二者都是只读、精确形态匹配，并且有意不构成通用的 v0 兼容层；当时被否决的替代方案是弃置第一方会话、就地改写已存储日志（违反仅追加）以及铸造不稳定的标识。

它们已不足以支撑自身的表面：尚无任何已打标签的发布，所覆盖的日志是数月前的开发期产物，而该机制的代价是协调器约 300 行代码、每次读取的逐事件归一化、后缀读取时 `readFrom` 回退到整个前缀，以及三个后端中的 fixture（测试前置数据）套件。放弃的能力是：pre-identity 日志会拒绝加载（明确报错，并在拒绝信息中给出原始日志路径），而不是继续恢复；pre-react-loop 日志则要么被拒绝（当其携带已废弃的 `steering/message` 类型时），要么在加载时把过时的轮次 envelope 字段原样透传，而不是投影为当前形态。重新引入条件：在第一个已打标签的发布之后，持久格式变更升级 `SESSION_FORMAT_VERSION` 并在版本门禁之下提供显式迁移——绝不再开一个同版本精确形态的例外。协调器约定与后端 spec 中的词汇拒绝测试验证该机制确实不存在。

## 考虑过的替代方案

**保留 `locate`（或将其移入独立的导出位置服务）。**不予采用：三个路径消费方都只有在禁用压缩时才可用，seam 会因此保留一个半失效的功能；逐字访问需求已由 `export()` 满足。

**在 `export()` 之外保留 `supportsRawArtifacts` 能力标志。**不予采用：`undefined` 加上 list 成员检查携带相同的信息，却只需一个 seam 成员而非三个。

**把迁移保留到第一个已打标签的发布。**不予采用：预发布立场（「在第一个已打标签的发布时移除」）已在其他所有地方拒绝旧的磁盘格式；这些迁移的唯一受益者是开发期日志。

## 后果

句柄重构之前的 seam 更小：一个导出方法、没有路径查询、没有能力标志，以及不含迁移表的协调器。代价是已记录在案的降级：钩子 payload 的 `transcript_path` 永远不会被填充（两个钩子桥接层 README 中记录的持久消费方缺口）；会话列表只在快照元数据探测阈值之内才把从未打开过的冷会话标记为空白；react-loop 重构之前写入的开发期日志会拒绝加载。ZIP 导出的 501/404 区分只在 `export()` 为 undefined 的路径上多一次 `list()` 调用。

## 相关资料

- [保留可忽略的外部会话事件](../architecture/2026-08-30-retain-ignorable-external-session-events.zh.md)——拥有本变更所依赖的仅读取侧未知类型门禁。
- [会话持久化作为抽象服务](../architecture/2026-06-14-session-persistence.zh.md)——拥有本次精简所缩小的 seam。
- [Zstandard JSONL 会话日志](../architecture/2026-07-19-zstandard-jsonl-session-logs.zh.md)——拥有这些读取与追加流经的帧容器。
- [会话标识与日志位置](../feature/2026-07-10-agent-session-identity-and-log-location.zh.md)——部分被取代：其 `DSH_SESSION_ID` 与 shell-env 注册表决策仍然有效；其 `locate`/`DSH_SESSION_JSONL`/`transcript_path` 决策在此移除。
