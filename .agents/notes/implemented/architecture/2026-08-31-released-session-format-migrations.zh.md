# Agent Note: 已发布 Session 格式在读取正文时通过相邻纯迁移边升级

Status: implemented

[English](2026-08-31-released-session-format-migrations.md) | 中文

## 问题

Session 格式 v0 已随 alpha 版本发布，因此结构化 writer 变更不能再把已有 JSONL 当作可丢弃的预发布状态。已存储事件正文通过读或写 `SessionHandle` 到达恢复、查询、导出、分叉与继续路径。只迁移一个消费方会让调用方看到不同的逻辑 generation，或只在后续 writer 到达旧文件时失败。

迁移必须保留精确源路径、字节与 inode，包括撕裂的物理尾部，同时为每个已发布格式提供一个无歧义的规范文件名。普通 JSONL 与 Zstandard 是同一逻辑格式的编码选择，不能产生两套并行迁移实现。

## 决策

`SESSION_FORMAT_VERSION` 是单调递增的当前 writer 整数。每个相邻 `vN -> vN+1` 转换由一个与 profile 无关的纯包负责。`@deepseek-ai/dsh-session-format` 只提供无损快照、唯一且无缺口的规划、仅 header 转换与整产物组合；`@deepseek-ai/dsh-session-format-catalog` 静态导入完整链，不依赖已挂载的 Cordis 插件。历史 codec 和归一化器位于具名迁移边包中，而当前 Session 与持久化代码只接纳最新逻辑类型。

每条迁移边都会冻结严格的源与目标语义，其目标物理 codec 则保持词汇中立，使普通事件增长可以留在同一格式版本内。目录通过已安装的 peer `@deepseek-ai/dsh-session` 及其当前 `KNOWN_SESSION_EVENT_TYPES` 还原最终代，避免冻结的历史迁移边反过来成为当前词汇 owner。

JSONL provider 在 `open` 为已存储 Session 返回句柄前完成 ensure-current 工作。它选择最高规范 generation、迁移受支持的历史正文，并从同一物理快照解码当前结果；公开 `SessionPersistence` 与 `SessionHandle` 接口不包含迁移操作。仅 header 的 `stat` 与 `list` 会重新扫描 Session 目录，在内存中转换受支持的历史 header，且绝不发布后继。`create` 独立于 header 可读性检查规范文件名，因此每个现有 generation 都会占用其 Session id。

取消属于提供信号的 `open`、`stat` 或 `list` 调用。发现、稳定读取、解码与发布前检查都会观察该信号；不可变后继一旦发布且其目录项已经同步，后续取消不会删除已提交 generation。

配置的 JSONL 编码拥有一个完整后缀：`.jsonl` 或 `.jsonl.zstd`。迁移读取稳定的精确源，解码可恢复逻辑前缀，在内存中组合全部必需迁移边，只为最终目标校验并同步同目录临时 stage，重新检查源 fingerprint，以不覆盖方式发布此前不存在的目标，同步 namespace，并在返回句柄前通过当前格式校验重新打开。源永不移动或改变；只有可丢弃临时 stage 可以被移动、链接或移除。迁移不会合成中断轮次事件：agent-loop 通过写句柄追加这些修复，而只读查询路径在内存中补齐它们。

规范文件名编码物理格式 generation：v0 是 `session.jsonl` 或 `session.jsonl.zstd`；每个正 generation 都是小写 `session.vN.jsonl` 或 `session.vN.jsonl.zstd`。`dsh-session-format` 拥有原始 basename 规则（`sessionFormatLogFilename`、`parseSessionFormatLogFilename`）；JSONL provider、session-log 导出归档与 recorded-session fixture 只追加压缩后缀。发布绝不重命名、替换或删除已提交 generation 路径。目标已经存在时，只有它是普通当前格式文件且字节与预期完全相同时才接受；其他目标都会拒绝。低 generation 为 operator 检查或显式复制而保留，但普通 runtime 操作选择数值最高的规范名称，绝不把保留的前任当作自动 fallback、restore 或 downgrade 支持。

当前格式快速路径从一个稳定源快照分类 header，不调用历史 converter，不写 generation，并把该快照交给当前格式解码，而不再次读取文件。解码日志进入现有按 revision 为键的有界 memo，供紧接的观察到恢复交接复用，而 `stat` 与 `list` 会有意重新扫描。多条迁移边保持原 generation 不变，并只发布最终目标；中间版本只存在于内存。源 fingerprint 重新检查会在内容变化时重启迁移，排他目标发布只在竞争胜者字节完全相同时接受它。跨进程 append 隔离不在此保证内。

第一条迁移边 `@deepseek-ai/dsh-session-format-v0-to-v1` 有意保持恒等形态：除版本和 v0 已接纳的有限历史归一化外，它保留逻辑 header、事件、序号、引用、时间戳、payload 与已配置的压缩选择。精确的 `session.jsonl[.zstd]` 源保持字节与 inode 相同，当前 writer 则编码新的 `session.v1.jsonl[.zstd]` 后继。这样可在出现改变基数的格式前先验证完整发布生命周期。

投影缓存记录把自己的折叠结果绑定到 Session header 的 `formatVersion`。`session_projcache` v7 reader 可以在结构上载入前代 domain 记录，但缺少格式代的记录不能播种当前 Session；权威日志会重新折叠它，下一次检查点写入完整的当前 identity。这样，任何在有界规范化或基数变化边之前产生的缓存行都不能绕过该迁移。

## 后果

较新 build 读取事件正文时可能持久增加一个更高 generation。精确旧 generation 仍然可用，但 runtime 此后选择最高规范文件名；保留不承诺旧 build 能安全 downgrade，也不保证新 build 在后继损坏时 fallback。只读文件系统会报告可操作的迁移失败，而不会返回与磁盘不一致的内存当前视图。

JSONL 发布在 POSIX 上使用硬链接创建与目录同步，在 Windows 上使用 write-through 且不覆盖的 `MoveFileExW`。竞争 writer 已先创建目标时，只有已提交字节完全匹配才接受。每个 Session 只支持一个进程内 writer。未来逐 Session 跨进程锁可以关闭剩余的源检查到发布竞态，而无需改变格式迁移边接口。

保留的 generation 不是实时流 WAL。未来可选 WAL sidecar 可以在硬崩溃间保留未完成 assistant 流。显式 generation 检查或复制、保留策略工具、压缩转换与流式整产物转换都是独立功能；自动 fallback 与 downgrade compatibility 并非隐含 future work。

本记录取代 [Session 日志版本机制](2026-08-10-session-log-version-mechanism.zh.md) 中仅在继续时持久化和迁移链仍推迟的规则。原记录继续负责何时递增版本，以及普通同版本 `ignorable` 事件行为。

## 验证

发布验证针对 `snapshots/`、`packages/` 与 `scripts/snapshots/python-sdk-single-exe/` 下每个带版本、来自持久化或投影的 `session*.jsonl` fixture 运行已提交 Session 格式语料门禁。fixture 专用的缺失信封与 request-header token 会先被实体化，再进入真实静态 catalog；每个 fixture 都会通过当前格式 restore 或历史迁移得到当前 v1 视图。Released-v0 replay 输入保持无后缀，而新鲜 v1 writer 输出对 parent 使用 `session.v1.jsonl`、对 child 使用 `session.<ordinal>.v1.jsonl`。Record 与 refresh 会保留每个已完成 generation，包括后续运行不再产生的 child role generation。Malformed 历史 fixture 在来源处修复，不通过依赖路径的 replay 策略准入。持续运行的门禁会动态发现语料，并拒绝每个 restore failure；独立组装式 JSONL 测试负责精确物理字节迁移。

句柄集成验证会一起运行纯格式、catalog、持久化 seam 与 JSONL provider 测试套件：420 个测试覆盖两种编码、不可变发布竞态、仅 header 观察、读写句柄、迁移拒绝、迁移后 append、取消与崩溃尾部行为，并达到逐文件 100% statement、branch、function 与 line coverage。仓库 typecheck 与 lint、含两个已声明 skip 的 113 个无密钥 recorded-session replay，以及 28 个 owner-local expected-output case 也都在合并 master 的 checkpoint 上通过。

组装后的 headless profile 测试会暂存 `session.jsonl`，通过随附组合恢复它，在构造 Session 前观察到 v1，验证精确 v0 字节与 inode 保持不变而 `session.v1.jsonl` 出现，并证明下一次 append 以 v1 为目标。JSONL 约定测试覆盖 raw 与 Zstandard 排他发布、撕裂尾部保留、源变化、目标冲突、最高未来版本拒绝、按 revision 复用已解析日志、列表重新扫描、临时文件清理、已提交重开与当前格式直通。

## 考虑过的替代方案

- **只在继续时迁移**——让查询、导出、分叉与后缀消费者停留在旧代际，并重复恢复策略。
- **返回迁移后的内存视图但不持久化**——让进程观察到与最高已提交 generation 不一致的状态，并把失败推迟到后续 writer。
- **持久化每个中间版本**——消耗空间并产生没有 runtime 消费者的恢复状态；只有源与最终代际应持久。
- **让已挂载事件 owner 插件注册迁移**——使历史可读性依赖部署；静态 catalog 必须在功能插件挂载前工作。
- **让每个当前格式复用同一个文件名并迁走前任**——不予采用，因为迁移会移动或覆盖已提交证据，需要冲突与保留规则，并让文件名与存储格式不一致。规范不可变 generation 名让发现流程直接选择最高版本。
