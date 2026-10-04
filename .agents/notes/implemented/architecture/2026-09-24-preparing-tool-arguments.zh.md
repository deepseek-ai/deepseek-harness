# Agent Note: 准备阶段的工具参数增量扫描与参数顺序

Status: implemented

[English](2026-09-24-preparing-tool-arguments.md) | 中文

## 问题

[三阶段工具调用](2026-09-22-tool-call-three-phases.zh.md)让工具身份在 `tool/call` 之前就可见。只有原始参数前缀不足以按字段展示：write/edit 需要完整路径和解码后的内容长度，bash/run_code 需要在命令或程序流入结束前显示描述。

模型生成参数的顺序也决定了什么能先显示。2026-09-24 用真实 DeepSeek V4 API 对 bash/run_code/write/edit 做了 310 次受控请求：

| 变体 | 改了什么 | bash 首键为 description | run_code 首键为 description |
|---|---|---|---|
| 现状 | — | 0/20 | 1/20 |
| 只调 `properties` 顺序 | description 提前 | 0/20 | 0/20 |
| `properties` + `required` 同调 | 同上并调 `required` | 强制 tool_choice 10/10；自由调用 pro 7/10、flash 0/10 | 强制 10/10；自由 20/20 |
| 同调 + 描述文本加一句顺序指令 | 追加「Provide `description` before `command` in the arguments.」 | 自由调用 flash 19/20、pro 20/20 | 20/20 |

在这些样本中，单调 `properties` 无效时，调整 `required` 能改变参数顺序；V4 Flash 自由调用 bash 还需要显式指令。`dsh-tools` 的 schema DSL 按属性声明顺序生成 `required`，所以改源码声明顺序会同时调整两者。探针使用极简系统提示词，不是完整 Harness 提示词。

## 决策

### 懒计算的参数视图住在 `dsh-util-values`

`PartialArguments` 是一个与工具无关的懒读器。它分别保留参数分片和顶层键值范围索引，或借用已解析的 PTC 参数。读取只索引新收到的边界；未请求的值不解码、不计数、不解析。请求字段时仅从该字段范围生成值，不需要每工具字段规格或注册表。

边界扫描器跨分片跟踪引号、反斜杠奇偶和嵌套括号配对。键名为查找而解码，值内容延后处理。`complete()` 表示结束分隔符已到达，不代表内容已校验；`invalid` 报告索引或内容读取已经发现的错误。内容错误不阻止后续字段建立索引。正式工具入参校验仍位于此展示读器之外。

被请求的无转义字符串长度直接由偏移量计算。转义字符串仅为已请求的长度、文本或有界前缀维护内容游标；上限查询在答案确定后停止。完整字符串首次被请求全文时使用原生解码。支持任意晚到的读取，需要保留原分片，直到权威完整文本替换它们。

变化由视图自己判定：`append(delta)` 只保留分片，`refresh()` 在发布时比较已观察的答案。没人读过时，不扫描也不报告变化。只有 refresh 推进已有答案的比较基线；中途读取不能吞掉其他消费方的更新。业务在读的时候说明粒度——`stringLength('content', { step: 1024 })` 让跨 KB 才算变化，`text('description')` 让每个字符都算变化，`textPrefix()` 将解码文本限制在请求的 UTF-16 前缀内。edit 进度合计新旧文本时，`offset` 计入已完成的字符串。

### 解析在 Tool Definition 层，不在 React

[Tool Definition](../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts) 把每个带 id 的 `tool-call-delta` 都匹配为 start 候选：最早的一个打开 Context（无论是否带名），后续折叠为 update。带名 delta 创建 preparing 根并挂上一个新的流式视图；每个 delta 只做 `args.append(delta)`。在 `animation-frame` 发布点，`buildViewNode()` 刷新已观察答案，仅在变化时替换根块，否则复用当前已发布根块。Context 和已发布 Node 持有这些身份，不另建准备阶段缓存。参数在名字之前到达的流不扫描：迟开的视图看到非对象前缀即 invalid、零字段。

三个阶段的块都提供 `name` 和 `args`，原有 `argsRaw` 和 result 的 `call: { name, argsRaw } | null` 仍可使用。`block-end` 和 `tool/call` 通过长度及逐分片精确比较，将流式参数与权威全文核对。文本一致时封存原读器并保留字段索引，分片缺失或冲突时创建新的 `fromText()` 视图。不需要累加字符串或概率性 hash。PTC 读器使用 `fromObject(payload)`，结果复用已派发读器，未配对结果使用共享空视图。卡片模型继续读取最终 `argsRaw`。

Assistant 块保留工具身份和首 token 时间，不保留参数 delta。完整参数文本来自 `block-end` 或持久消息。纯参数 delta 保持 Assistant State 不变，preparing 读取与通知由 Tool Definition 负责。

Assembler 为同一输入和生命周期角色共享一个不可变 Match 及其 Location，各 Definition 仍保留独立 State。空依赖集合无需执行回放。

工具行在各阶段使用相同读器：read/write/edit 在 `file_path` 闭合后显示可打开的路径；write/edit 在内容流入时按 1024 字符单位显示解码后长度；bash/pwsh/run_code 显示描述前缀。Chat 分组详情按既有字段优先级读取同一视图。没有可用详情时，只要字段还可能到达就留空；`closed()` 为真后才回退工具名，所有类别一致。

分组详情先规范化 512 单元的解码前缀，仅当空白或多单元字素簇使其无法判定 160 字素簇的结果时才扩大前缀。前缀填满后，字段继续增长不会改变它，但稍后出现的更高优先级字段仍会发布新详情。字符串长度检查不会物化全文。详情不超过 160 个 UTF-16 单元时，无需遍历字素。

三方工具无需注册或独立订阅就能取得同一视图。write/edit 和 Bash 在各阶段共用组件。可变参数读器是 owner 数据要求 JSON 兼容的一项限定例外：已读取答案变化时，所属 Definition 发布新的块引用。扫描缓存使用私有字段，同源视图的结构比较不受读取历史影响。

### 参数声明顺序

`tool-bash`、`tool-pwsh` 在 `command` 前声明 `description`，并包含顺序指令。`run_code` 两处 `parameters` 将 `description` 放在 `code` 前，共用的参数描述要求 TypeScript 和 Python 都按此顺序生成。write/edit 首先声明 `file_path`，并在路径参数描述中要求先生成它，再生成 `content` 或 `old_string`/`new_string`。read 保留首位的 `file_path`；其他工具保留原有参数顺序。

## 考虑过的替代方案

**在 hook 闭包里解析（选择器订阅 Step source）。** 只有订阅行能看到解析结果，分组标题需要另一份订阅，每行还要负责解析器生命周期。Definition 持有的视图让消费方共享已解析字段。

**在 Definition 里维护每工具字段规格（内建表 + 运行时注册表）。** Definition 是纯函数、拿不到 ctx，运行时注册表只能经工厂闭包注入，三方工具要在坑位与注册表两处登记；而规格表本质只是"哪些字段保留文本"，懒计算按需从原始文本切出原文后这条信息不再需要。

**第三方 `partial-json`。** 每帧重解析累计输入，且不独立于解码值暴露字符串完成状态。

**提前解析所有字段。** `content` 等大字段通常只需要长度；在消费方请求前构造全文，会增加解码和内存成本。观察整个键列表还会在无关参数出现时重新发布块，因此详情保持逐字段观察。

**从规范化字段切出截断详情。** V8 的子字符串可能保留整个字段。拼接有界数量的字素簇，使展示前缀不再依赖该原文。

**只调 `properties` 顺序。** 实测 0/40 生效；模型跟随 `required` 顺序。

## 验证

- 解析器测试覆盖懒扫描、已读取答案变化、空键与重复键、跨片转义、非字符串值、非法输入、封存视图，以及不受读取历史影响的结构相等。
- 工具行和分组测试覆盖流式路径与描述、内容长度、共用行身份、参数不再增长后才回退工具名，以及不改变空白或 Unicode 处理语义的每次截断遍历最多 161 个字素簇。
- 负控恢复读取时确认变化、重复分配 Match 和短文本字素遍历；四项聚焦测试在对应断言失败，恢复后通过。各 Definition 保留独立 State，Turn 与 Step 记录仍归各 Session 所有。
- 另有负控提前解析未读容器、接受同长度的冲突文本，或为纯参数 delta 重建 Assistant State。每项都在所属断言失败，恢复边界索引实现后通过。

必跑的 [conversation-fold benchmark](../../../../benchmarks/conversation-fold/conversation-fold.bench.client.ts) 使用真实 Tool Definition、Assembler、Chat 分组及发布后的 write 行读取，以 16 字符分片输入，每 64 片 flush。三个独立的已编译 Node worker 报告全部样本及中位数；准备工作和显式 GC 不计时，保留 Assembler 与参数视图后测量驻留堆。行读取校验解码进度与文件路径；worker 还报告进程峰值 RSS。

2026-09-29 的本地 Chat 专项测量，以 512 KiB write 内容和 32,769 个正文 delta 对比功能改造前基线与优化实现。在 Linux x64、AMD EPYC 7763、Node 24.18.0 上，无探针处理耗时中位数为 212.16 → 176.12 ms，包含已回收对象的累计分配为 132.06 → 76.65 MiB，驻留堆为 24.89 → 21.84 MiB。测量不含模型、网络、浏览器渲染和非 Chat 目标，不代表整页或 CI runner 延迟。

Match 调用保持 393,228 次；update 从 98,307 增至 131,076 次，因为 Tool Definition 消费每个参数 delta。基线按原文长度显示 write 进度，不读取解码后的参数。

CI 预算保持 750/375 ms 和 37.5/10 MiB：300/150 ms 参考预期使用共享的 2× 时间倍率和 1.25× 余量，30/8 MiB 堆预期只使用余量。历史累计索引／全文分段负控中，write 耗时为 3984.9–4035.5 ms，bash 为 1471.2–1494.9 ms，均超过未调整的预算。

## 影响

- 已读取参数变化时替换准备态块，无人读取的调用保留块引用。视图保留源文本，分组标题可以独立于工具行请求字段。已派发和已结算视图在首次读取时扫描，不发布更新。
- schema 顺序和描述指令引导模型先生成展示标签，但不保证生成顺序。工具行在字段可用时显示它；路径晚到会推迟路径及其后的内容进度展示。
- 展示仍由 Client 派生；参数扫描不新增 Session 事件或持久化格式。
- 名字晚于参数到达的流放弃扫描，该调用的准备行退回只显示标题。
