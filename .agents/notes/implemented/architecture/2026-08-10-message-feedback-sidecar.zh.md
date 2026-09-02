# Agent Note: 绑定生命周期的消息反馈伴随记录

Status: implemented

[English](2026-08-10-message-feedback-sidecar.md) | 中文

## 问题

现有 `/feedback` 命令记录不可变的 Session 级 `feedback/record` 事件。在 `FEEDBACK_ONLY` 下，该事件可以释放待处理的遥测前缀，因此它不适合作为挂在单条 assistant 消息上的可编辑好评／差评与可选备注的权威来源。消息反馈需要独立的更新与删除语义，且不得进入权威 Session 日志、改变投影、到达模型上下文，或隐式表示遥测同意。

只按 `SessionId` 建索引的伴随记录可能在该 id 以不同 header 身份重建后，继续存活于其所描述的日志生命周期之外。Session 级 revision 还会让无关消息的编辑彼此冲突，而普通 storage-domain 读／写不提供跨进程 compare-and-swap。Session disposal 只是从 live store 脱离，并非持久删除；当前 Session 持久化 seam 也没有可拥有真实级联的删除操作。

## 决策

`@deepseek-ai/dsh-message-feedback` 拥有 `ctx.messageFeedback` 服务，并把消息反馈存为每个 Session 一条 storage-domain 伴随记录（sidecar）。该伴随记录既不是 Session 日志内容，也不是 Session 投影。它不发出 `feedback/record` 事件，也不执行遥测交接；command-feedback 与 message-feedback 约定保持独立。

每条可用记录都绑定到经检查的 Session header 身份 `{createdAt, cwd}`，而不只是其 `SessionId`。生命周期不匹配按不存在处理：`list` 返回空条目，`put` 可以用绑定当前身份的新记录替换陈旧行。因此，以不同 header 身份复用的 id 不会继承陈旧反馈。fork 拥有自己的 Session 身份，且不复制伴随记录：即使 fork 种子包含相同的 assistant 消息，反馈仍只属于人类记录它的那个 Session。

`put` 只在被观测的日志——live 持有者的内存事件，否则是经由持久化读句柄读取的持久日志——包含非空、append-origin 且 `MessageId` 与目标相同的 `assistant/message` 时才接受该目标。replacement-origin 消息、仅承载 usage 的空 assistant 记录以及非 assistant 目标都会被拒绝。观测是 cold-safe 的：它不会仅为验证反馈而发布或恢复 Agent，也不会提交 cold 日志修复。cold 路径由 `stat()` 预检明确不存在；已进入目录的 Session 若读取失败，仍按基础设施故障处理。因此，请求若恰落在 live detach 到 header materialization 的极短窗口，可能返回 `session-not-found`，调用方在 retirement materialization 后重试。

`put` 提交伴随记录前，会先让目标日志通过 durability barrier。身份匹配的 live Session 经过权威 `ctx.sessions.flush` checkpoint，随后 live 与 cold 路径都会通过新开的持久化读句柄从序列零做物理复读。之后再次校验所得观测的 header 身份与目标。缺少 flush 参与方、身份变化、目标消失或物理读取失败都会阻止伴随记录写入，因此已提交反馈绝不会先于它引用的持久 assistant 消息。

每个消息条目都携带自己的 opaque version，以及 Host 分配的 `createdAt` 和 `updatedAt` 时间戳。`put` 只把调用方的 `ifVersion` 与目标条目比较，因此编辑一条消息不会使另一条消息失效。即使目标值已经相同，比较仍然严格执行，从而防止陈旧请求穿过 ABA 值循环；冲突会返回权威当前条目，调用方无需二次读取即可协调。携带匹配 version 的无变化请求会保留 version 与时间戳；实质更新保留 `createdAt`、替换 version，并保证 `updatedAt` 不倒退。删除已经不存在的条目也同样成功。version 是只能做相等比较的 token，不是调用方可以排序或自行合成的计数器。

按 Session 划分的变更队列覆盖生命周期检查、伴随记录读取、冲突判断与整行写入。这使同一个服务实例的变更串行化，并在单个 Host 进程内保持逐消息 compare-and-swap 约定。Plugin disposal 会关闭接纳、排空已进入队列的工作，然后关闭 storage domain。底层 storage-domain API 不提供跨进程条件写，因此实现不承诺跨进程线性一致性或防止丢失更新。

`maxNoteBytes` 是必填的部署选择，用于限制可选备注的 UTF-8 字节长度；Web Host bundle 将其显式设为 `8192`。该包通过 `TypertRemoteService` 与 `@Remote` 直接发布 Host `messageFeedback.list`、`messageFeedback.put` 与 `messageFeedback.delete` 约定。客户端 Remote 聚合挂载与 UI 由各自边界负责并保持延后；后续适配层只是该 Host 约定的薄消费者。

服务不伪造删除级联。`session/disposed` 与 `host/session-removed` 表示脱离 live ownership，而非持久删除，Session persistence 当前也没有删除接口。因此在带外移除日志后，伴随记录可能继续存在；不同的 `{createdAt, cwd}` 可阻止此类遗留记录变成后来复用该 id 的 Session 反馈。

## 考虑过的替代方案

**把编辑追加到 Session 日志并派生投影。** 不予采纳，因为可编辑 UI 元数据会变成权威且邻近对话的历史，fork 会回放并继承它，删除需要 tombstone，而复用 `feedback/record` 会把消息评分与遥测同意静默耦合。

**按全局 `MessageId` 建索引、在 fork 时复制，或使用一个 Session revision。** 不予采纳，因为消息 id 仅在某个 Session 生命周期内有意义，fork 后的对话需要独立的人类判断，而且无关消息的变更不应制造虚假冲突。

**在本次变更中为 `KvTable` 扩展跨进程 compare-and-swap。** 不予采纳，因为现有 storage-domain 后端没有共同的条件写原语。进程内队列符合受支持的单 Host 拓扑；真实的多进程保证需要后端级原子约定，属于独立工作。

**在 Session disposal 时删除反馈。** 不予采纳，因为 disposal 包含普通 detach 与 rollback 路径。把它当成持久删除会在 Session 日志仍存在时丢失反馈；清理必须等待真正的 Session 删除权威。

## 后果

消息反馈在本地持久化并可独立编辑，且不改变模型可见历史或遥测行为。同一 Host 中的并发调用方获得逐消息冲突检测与可安全重试的结果；多个写入者共享同一存储根目录的部署仍不受支持。不同的 header 身份会让陈旧记录被视为不存在，但不会将其回收；本约定无法区分保留相同 `{createdAt, cwd}` 的克隆日志。Host Remote 约定现在可用；客户端组装与 UI 可以保持为薄消费者，而不接管持久化或并发语义。
