# Agent Note: 以表层替换实现持久的图片 offload

Status: implemented
Archived: 2026-09-10

[English](2026-09-02-durable-image-offload.md) | 中文

## 问题

请求级图片 offload 过去在每次请求时都从头重算。每条路由按最老优先的顺序收集派生表层上的全部图片出现位置，累计字节一旦超过预算，就把超出部分向上取整到整个删除量子，把这么多最老的出现位置替换为占位文本，见[统一图片请求管线](../feature/2026-08-20-unified-image-request-pipeline.zh.md)。没有任何东西记住上一次请求停在哪里，前缀稳定只是因为对 append-only 历史做同样的算术会得到同样的结果。

算术的输入一动，这种稳定就失效。[Files 内联回退](../../archived/bug-fix/2026-08-21-deepseek-files-inline-fallback.md)会用 20 MiB 内联预算和 10 MiB 量子重建请求，那一次省略多得多的图片，下一次 file 模式的请求又把它们带回来。pi-ai 路由的量子是一个字节，前缀几乎每次请求都会移动。compaction 降低总量，让先前省略的图片回归。切换路由会移动每个台阶边界。每一次移动都改变模型可见前缀，并让 provider 的缓存前缀失效。

同样的重算也破坏了仓库不变量：模型可见输入必须能从 session log 重建。实际发出的表示方式、派生请求版本的精确字节长度、路由预算和量子都是运行时或配置事实，从不进入日志，`request/header` 只记录调用配置、系统提示词和工具。provider usage 只锚定 token 总量，恢复不了图片集合，[按路由定价的估计](../../archived/feature/2026-08-24-route-priced-image-request-pressure.md)也写明它不复现回退预算。没有任何消费方能把一条已记录的助手响应和它的请求携带的图片集合配对。

## 决定

一个图片出现位置的省略是一条持久的表层事实，记录方式和 compaction 记录它的缩减一样：一个 `surfaceOp: replace` 节点。

**表层上带标记的副本。** `ImageBlock` 新增 `offloaded?: true`。被省略的出现位置存在于一条与原承载节点同类型的替换事件里（`user/message` 或 `tool/result`），内容是原消息的副本，只把那些块打上标记；`sourceEventSeqs` 指向被替换的节点。session 核心、它的事件表、派生和校验都不变。`deriveMessages()` 原样发送带标记的块；序列化把每个带标记的块渲染为带当前已解析访问路径的 `offloadedImageText`，只准备保留的出现位置。

**只前进。** 替换永不回退。预算变大、路由切换或 compaction 降低总量时，带标记的副本留在原地，所以模型可见前缀和 provider 缓存前缀只向前移动。

**adapter 只投影，不决定。** 支持图片的路由按保留的出现位置的精确请求版本字节执行一个 `LlmImageRequestBudget`（`representation`、`maxBytes`、`maxImages` 与两个量子）。当它们仍超过预算，无论是 file 模式、内联回退更紧的预算还是 pi-ai 上限，adapter 都以 `IMAGE_OFFLOAD_REQUIRED` 让本次尝试失败，并在 `LlmFailure.offloadImages` 中用共享的 `requiredImageOffload()` 算出还需省略多少最老的出现位置。发送前没有任何规划。

**恢复归 `dsh-compaction-image-offload`。** 图片省略是 compaction 在另一个容量维度上的实例：provider 拒绝请求，持久历史被缩减，step 重试。执行器是 compaction 组里 `compaction-tool-result-pruner` 的兄弟包，监听 `agent/request-error` waterfall。收到 `IMAGE_OFFLOAD_REQUIRED` 时，它按模型请求顺序遍历表层，给前 `offloadImages` 个保留的出现位置打标记，为每个承载了其中任一位置的节点先追加 seam 的 `compaction/prune` 影子价格，再追加带标记的副本，然后返回 `retry` 动作，不占提供方重试预算，也不记录 `llm/retry`。assistant 节点承载的是模型输出而不是输入图片，直接跳过。没有可省略的出现位置时向下游委托，失败进入普通恢复路径。循环在替换后的表层上重跑该 step，并像每次表层替换后一样记录新的 `request/header`；agent loop 不变。

**token 记账。** `priceImages` 接收表层的 `ImageBlock`，把带标记的按占位文本定价；DeepSeek 和 replay 的定价不再复现任何 offload 算术。meter 不需要新状态：`compaction/prune` 事件加替换节点，和工具结果剪枝一样重新为该节点定价。

**其他消费方。** compaction 通过 `deriveEventMessage()` 重建每个选中事件，看得到标记。resume、fork 和重放从日志复现表层。纯文本路由保留各自的全历史替换。

## 考虑过的替代方案

**继续每次请求重算 offload 位置。** 只在算术输入不动时稳定，内联回退、pi-ai 量子、compaction 和路由切换都会移动前缀，且没有消费方能重建历史请求的图片集合。

**用 log-only 事件记录每次请求的投影结果。** 恢复了可重建性但没有稳定性：记录的结果不是决策输入，每一种抖动照旧发生，日志只是把它记下来，且省略集合有两个可能不一致的事实来源。

**记录完整的投影后请求体。** 除 offload 决定外一切都已可派生，为记录一个位置而每次请求重复整段历史会让日志平方级增长。

**由 session 派生应用的 log-only `image/offload` 水位事件。** 更早的一版把 offload 点记成一个位置（事件序号加块路径），由 `Session.deriveMessages()` 给位于它及之前的每个出现位置打标记。这让 session 在 `surfaceOp: replace` 之外多出第二种改变模型可见历史的机制，带着自己的校验、折叠、缓存失效和读取时必须识别的事件，并且把逻辑放进了核心而不是做决定的插件。issue #3041 要求永久淘汰使用改变表层的事件而不是请求投影事件；省略永不回退，它就是永久淘汰。

**让各个 adapter 自己追加替换。** adapter 拥有预算，但不拥有会话表层；在循环之下追加表层变更会让两个 adapter 对表层做出不同定义。adapter 改为上报它需要的数量。

**在发送前规划省略，无论放在循环里还是插件里。** 循环在派生每个请求之前就知道精确的已准备路由，在那里规划永远不会多花一次失败的尝试；但这会把一条路由专属的策略放进所有 profile 共用的那个组件，改变已记录的 step 顺序，还绕过了上下文溢出 compaction 和重试已经在用的同一套 `agent/request-error` waterfall。pre-step 插件不改循环，但看不到 step 自己的消息和第一个请求的路由，失败路径仍然必需，而且规划要求每条路由在模型信息上声明预算。只处理失败的代价是每越过一个量子多一次尝试（DeepSeek file 模式 64 MiB，pi-ai 20 MiB），并且和既定方向一致：路由将不再本地检查大小，全部发送，由 provider 报告无法缓存的部分，那正是一个指明省略点的失败。

**为内联回退和精确字节溢出保留临时的额外省略。** 恰好会在不变量所针对的场景发送未记录的投影；失败再推进的路径只多花一次序列化尝试，且让每个已发出请求都可由日志派生。

## 后果

预算变大、选中更大的路由或 compaction 降低总量时，被省略的图片不会自动回归；恢复手段是占位文本中的只读路径，模型需要时主动使用。一次 Files 故障或临时切到小预算路由会永久省略，两者出于同一理由被接受。每次省略会把承载节点的消息复制一份进日志；图片只是引用，复制的是该节点的文本和块元数据。

每个已发出请求的图片集合都仅由日志决定，覆盖 file 模式、内联回退、resume、fork、重试和 compaction，provider 缓存前缀不再来回变化。占位文本和句柄文本里嵌入的执行世界访问路径仍在序列化时解析；这个缺口对保留的图片同样存在，属于另一个关于记录执行世界映射的决定。路由本地的字节检查是过渡实现：provider 自己报告无法缓存的图片之后，`requiredImageOffload()` 和路由预算会被删掉，带标记的副本和恢复分支保持不变。

## 测试

`packages/llm/llm/tests/content.spec.ts` 钉住任意深度的图片遍历、包括 129 到 64 MiB 量子示例在内的省略计数，以及占位投影。`packages/compaction/compaction-image-offload/tests/image-offload.spec.ts` 钉住 `IMAGE_OFFLOAD_REQUIRED` 替换并重试、带 `compaction/prune` 影子价格且不追加重试事件的路径、原节点保持不变、更早一次表层替换之后的请求顺序计数，以及向下游委托的耗尽情况。adapter 测试钉住占位投影、只读取保留图片以及带数量的精确字节失败；`route-pricing.spec.ts` 钉住带标记替换的占位定价。`inline-image-prompt` TypeScript SDK 快照通过发布的 profile 重放一次手工编写的 `IMAGE_OFFLOAD_REQUIRED` 尝试，钉住替换和重试后的请求。
