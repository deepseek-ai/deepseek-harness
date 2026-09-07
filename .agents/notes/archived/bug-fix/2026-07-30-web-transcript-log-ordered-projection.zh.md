# Agent Note: 浏览器会话是按日志顺序投影的人类对话记录

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-web-transcript-log-ordered-projection.md) | 中文

## Problem

浏览器客户端从模型可见的 surface 构建会话：`FoldAdapter` 在历史窗口上运行核心 `SurfaceManager` 并读取 `surface.nodes`。一次成功的压缩（compaction）会用一个检查点节点替换一段 surface 范围，因此该替换一落地，Web 流就把它所遮蔽的每条消息折叠成一行灰暗的上下文——那是用户已经读过的对话。日志中什么都没丢失；缺陷完全在投影层，而[终端与宿主网关已按同一方式修复](2026-07-29-human-transcript-append-origin.zh.md)，浏览器留给了本次变更。

surface 顺序还让另外两个问题成为结构性的。一次替换之后它并非按 seq 升序——`SurfaceManager` 把高 seq 的检查点拼接到它所遮蔽范围的位置上——因此按数值 seq 归并进该数组的仅日志节点（斜杠命令行、被打断的冻结节点）可能被冲刷到检查点之前，再也无法交错回保留下来的尾部。而且由于分页不再为 replacement 副本消耗 `maxMessages` 额度，一页现在可以携带一个 `surfaceOp.start` 落在窗口之外的检查点；核心 fold 拒绝该范围，于是 `nodes()` 退回到一次宽容的线性扫描、打印一条 `console.error`，并发布一个描述该失败的 `foldDegraded` 标志。

## Decision

`TranscriptAdapter` 取代 `FoldAdapter`，并且从不查询 surface 顺序。它按日志顺序投影原始窗口：每个 append 来源的 surface 事件（`isAppendSurfaceEvent`）落在它自己的日志位置上，外加每次落地的压缩检查点一个 `CompactionSummaryNode` 标记。于是一次落地的压缩会保留它在模型侧遮蔽掉的对话，标记报告模型从哪里开始看不见那段历史，而不是把它抹掉。仅模型可见的 replacement 副本不进入记录：被裁剪的 `tool/result` 和重新生成的 `assistant/message` 只为模型重写一个节点，不在对话中标记任何边界。凡必须发送模型所见内容的一切仍读 surface；这是人类投影，两者现在在两个前端上都已分离。

节点顺序天然按 seq 单调，由此有三个结果。仅日志的 `command/run` / `command/done` 对折叠成 `CommandNode`，按 seq 插入一个本已单调的数组——无锚点，无重排。`Session` 保留被打断的冻结节点的归属，用一次普通排序按其分数 seq 归并，而这现在恰好就是流顺序。检查点所引被遮蔽范围落在窗口之外的窗口没有范围需要解析，因此标记正常渲染且不打印任何日志。

`foldDegraded` 从 `ConversationSnapshot` 消失，随之消失的是哨兵填充、它们所需的 `baseSeq` 算术，以及 `degradedSeqs()`。它们的存在只为满足核心 fold 的 `seq === index` 断言并在其抛错时存活；它们所描述的 fold 已不再运行。删除该标志是修复的一部分，而非修复之后的清理——`degradedSeqs()` 本身已几乎就是按日志顺序的投影，只是作为抛错后的落点而非本意到达。

标记的摘要文本、被替换条目数量和估算的被遮蔽 token 数量都来自检查点引用的 `compaction/summary` 事件，绝不取自成框的检查点载荷——那是为模型撰写的指令信封。窗口切分把该事件留在窗口外时这些字段不可用，与无调用的工具结果同一种软退让；后续补上该事件的分页会解析出它们。

[手动压缩命令](../feature/2026-07-30-queued-manual-compaction.zh.md)会把摘要事件的 seq 作为成功结果的 `CommandResult.sourceEventSeq` 返回，`command/done` 则持久化这项可选引用。Chat 只会配对成功且名称为 `/compact`、其引用恰好等于唯一一个已加载 `CompactionSummaryNode.summaryEventSeq` 的命令。运行中的命令先渲染为 `compact · Compacting context…`；检查点落地后，同一个 React key 会在检查点的消息流位置渲染一条收起的 `compact` 展开项，并显示条目数量和 token 估算值。输入被拒绝、没有可压缩历史、取消和失败时仍使用通用命令行，并保留处理器撰写的完整文本。自动压缩没有命令引用，继续使用独立的上下文已压缩标记。

显式事件引用之所以重要，是因为手动压缩允许在异步摘要运行期间注入持久上下文：命令行与检查点行不保证相邻。命令生命周期事件增加一个可选字段，但压缩事务、RPC 信封和模型可见 surface 均不变化；不含该字段的预发布持久日志继续采用原先的两行软退让，无须迁移。

## 识别检查点：同一份声明，在编译期钉住

识别需要三个条件同时成立，与终端一致：`event.type === 'user/message'`、压缩缝隙的检查点插件来源，**以及** `isReplacementSurfaceEvent(event)`。一条 append 的插件来源 `user/message` 是注入上下文——跨会话引用卡片——不是压缩。

从 `packages/client/*` 程序无法到达的是 `dsh-compaction` 的**根部**，而不是这个包。根部会到达 `dsh-session` 的根部，后者的 cordis `Context` 合并声明了宿主侧 `sessions: SessionStore`，与客户端的 `sessions: ISessions` 冲突——`TS2717`，即 [development.md](../../../../docs/development.zh.md#typescript-project-layout) 中每侧一个 program 的规则；这一点对仅类型导入同样成立，因为该冲突是编译器事实而非打包器事实。

本仓库对这一情形的既有答案是不含 cordis 的叶子子路径，本次变更就新增了一个：`COMPACT_CHECKPOINT_SOURCE` 与 `isCompactCheckpointSource` 现在住在 `packages/compaction/compaction/src/checkpoint.ts`，它不导入 cordis、也不增强任何模块（即 `dsh-commands/brand` / `dsh-llm/message` 的形状），而包根重新导出两者，因此每个宿主侧消费方——终端的 chat helper、`dsh-session-reference` 的投影——都不需改动。适配器用仅类型导入把它的字面量钉在该声明上：

```ts
import type { CompactionCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
const COMPACT_PLUGIN: CompactionCheckpointSource['plugin'] = 'compact'
```

重命名 Service Definition 的插件 id 现在会在客户端产生编译错误：`TS2322: Type '"compact"' is not assignable to type '"compaction"'`。该导入必须保持**仅类型**——任何既非平台模块又非 inline-safe wire 层的 `@deepseek-ai` 包值导入都会被客户端纯度门禁（`packages/client/tsdown.client.ts`）拒绝，而它自己的报错信息就记录着仅类型导入会被擦除、永不抵达该门禁。仅类型的叶子导入同时需要 `tsconfig.base.json` 的一条 `paths` 条目和 `packages/client/ui-chat/tsconfig.json` `references` 中的 `{"path": "../../compaction/compaction"}`：composite 的 `rootDir` 规则同样适用于被擦除的导入，缺少该引用时的诊断是 `TS6059`/`TS6307`。

`packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` 是行为侧的另一半，用检查点与溯源记录驱动压缩 Definition，并证明后续加载的旧分页可以补齐缺失的摘要数据。Definition 仅类型导入该叶子路径，使客户端继续与 compact 包根及经由它可达的宿主侧 `Context` 合并隔离。

因此与终端的分歧很窄：两个前端都从同一份声明识别检查点——终端在宿主侧值导入 `isCompactCheckpointSource`（那里不适用任何门禁），客户端钉住类型。

## #835 的位置锚点是为什么而存在，以及为什么它是被溶解而非丢失

尚未合并的排队式手动压缩分支用另一种方式修同一个交错缺陷：为每个事件记录一个锚点——追加时的 surface 尾部——并把被遮蔽的锚点重定向到检查点上。该机制的存在是为了让位置锚点在 surface **重排**中存活。人类对话记录永不被重排，因此锚点没有任何东西需要重定向：前提被移除，修复并未被丢弃。该机制在本代码库中并不存在。

## Alternatives considered

**从新叶子值导入该谓词**，并把 `dsh-compaction` 加入客户端 `INLINE_SAFE` 白名单。已拒绝：客户端需要的是插件 id，不是谓词——一个类型就够了，而被擦除的导入根本不会抵达纯度门禁，因此无需向它放行任何东西。白名单只在值导入时才有意义，而在那里它是笔糟糕的交换：`INLINE_SAFE` 按模块说明符*前缀*匹配，因此放行该包会连它那个会导入 cordis 的根部一起放行。

**一条纯形状规则**——任何 replacement `user/message` 都是压缩。已拒绝：它正确只因为压缩是 replacement `user/message` 的唯一生产者，一旦这点改变便无任何机制能捕获。那个 pin 测试只花一个文件，就精确消除了这一风险。

**在宿主侧给检查点打标**，经投影或线协议。已拒绝：这最贴合“经 cordis 服务协作”的规则，但客户端折叠的是原始 `SessionEvent`，因此这意味着一次线协议约定变更——为一个纯谓词付出的代价不成比例。

**把冻结节点的归属移进适配器**（`nodes(extraNodes)`），像那个未合并分支所做的那样。已拒绝：被打断的节点来自 `Session` 已经在窗口上运行的 `turn/end` 清扫，而在按 seq 单调的记录之上，简单形态就是正确的——适配器返回节点，会话按 seq 归并冻结节点。加宽适配器签名什么也换不到，还会把清扫与它的产物拆开。

**把 `foldDegraded` 留作一个防御性标志。** 已拒绝：它描述的是一个已不再运行的 fold 的特定失败。一个消费方无法据以行动、只能通过 `console.error` 到达的标志，是一份虚假约定。

**把最近的 `/compact` 行与下一个检查点配对。** 已拒绝：两者之间可能落入上下文注入，并发或格式异常的生命周期记录也必须降级而不误取其他检查点。命令结果则指明权威摘要事件；引用存在歧义时不配对任何内容。

**解析英文结算文本中的条目数量和 token 数量。** 已拒绝：处理器文案是呈现文本，而非稳定的数据约定。标记读取本已持有这两个值的结构化 `compaction/summary` 载荷。

## Consequences

压缩不再抹掉 Web 历史；一个被压缩多次的会话按日志顺序显示每次落地压缩一个标记，而同一窗口在实时与冷恢复之后渲染完全相同。分页缺口是被构造性闭合而非被防御，`ConversationSnapshot` 少了一个已发布字段，这触及十三个文件。

`ConversationNode` 增加第八个分支，因此每个穷尽消费方都多一个分支：`MessageItem` 通过新的 `CompactionItem` 渲染标记，trajectory 布局加宽它的“无单元格”分支，使标记不贡献单元格但仍推进耗时游标。

性能约定未变，且现在更易表述：一次追加物化一个节点，不改变任何节点的事件保持上一次的数组引用——因此分片风暴零成本、`nodes()` 甚至不会重算——未变化的节点保持其对象标识。窗口仍随会话长度而非随 surface 增长，这正是本修复存在所要做的交换；一次压缩过去恰好为压缩所服务的长会话限制了投影规模。

Web e2e 场景现在围绕它录制的那一轮上的压缩事务播种一次真实的手动命令生命周期，因此 aria 基准经真实宿主与真实浏览器钉住完整行为：录制的提问与完整工具输出仍在屏幕上，其后恰好一条 `compact` 行报告规模，展开后会显示确切摘要。录制本身未被触碰、保持模型真实——回放从录制自身的 surface 派生出手动压缩。

## Deferred

终端的[已归档压缩进度决策](../../archived/feature/2026-07-30-compaction-progress-visibility.md)使用实时独立标记对驱动单格指示器，并不改变此浏览器投影。
