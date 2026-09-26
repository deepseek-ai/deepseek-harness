---
description: "完整的 V3 到 V4 Session 转换与原生接纳：工具角色结果、生产者来源、父目录、引用重映射及拒绝规则。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v3-to-v4

[English](README.md) | 中文

## 概述

在不改写已存储代际的前提下，将受支持的已发布 V3 Session 恢复为 V4。本页完整说明迁移边的转换、保留、前置证据与拒绝规则，再单独说明原生 V4 接纳。转换提升工具结果、重命名消息来源、补齐有明确证据的中断回合，并追加缺失的父目录事实。持久化层负责文件读取和后继代际发布；本库负责转换与目标规则。

## 目录

- [使用本包](#use-this-package)
- [V3 到 V4 规范](#v3-to-v4-specification)
  - [Header 与物理分帧](#header-and-framing)
  - [工具结果表示](#tool-results)
  - [扩展数据](#extension-data)
  - [消息来源转换](#message-sources)
  - [父目录前置证据](#parent-catalog)
  - [序号引用与继承](#sequence-references)
  - [Delivery 代际](#delivery-guards)
  - [源审计与拒绝](#source-audit)
- [原生 V4 接纳](#native-v4-admission)
  - [Header、消息与表面元数据](#native-fields)
  - [生命周期与引用关系](#native-relationships)
  - [Developer 变更与延迟 schema](#developer-changes)
  - [Fork 生成的结果](#fork-results)
  - [校验入口与恢复](#native-recovery)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 [catalog](../session-format-catalog/README.zh.md) 完成恢复。直接导入用于 catalog 组装和测试；本库没有 Cordis 挂载配置。[公开导出](src/index.ts)提供相邻迁移、已发布的 V3 源 codec、V4 codec 和目标校验器。源 codec 仍由 [V2 到 V3](../session-format-v2-to-v3/README.zh.md) 所有。

仅 header 迁移会校验并推进元数据，不读取正文或收集子 Session：

```text
const targetHeader = sessionFormatV3ToV4.migrateHeader(sourceHeader)
```

历史正文恢复要求显式的子级证据。没有该绑定时，`sessionFormatV3ToV4.createStage()` 会拒绝；空数组明确声明没有子级。持久化层必须收集完整的可用直属子级集合，而隔离的 transcript 回放可以提供其刻意为空的集合。Catalog 存续期间，证据必须保持不变。

```text
const catalog = createSessionFormatCatalogWithChildren(childFacts)
const restore = catalog.createRestore(physicalHeader, {
  recovery: 'strict', validation: 'current',
})
for (const row of physicalRows) restore.decodeRow(row)
const artifact = restore.finish()
```

每次恢复都创建独立的 Stage 状态。紧凑 run 以迭代器展开，不物化中间事件数组。部分输出不代表成功：后续行或 `finish()` 仍可拒绝整份产物。[格式协议](../session-format/README.zh.md)负责调度和错误处理；[JSONL 持久化](../session-persistence-jsonl/README.zh.md)负责源读取、准备以及经验证的独占后继发布。

-----

<a id="v3-to-v4-specification"></a>
## V3 到 V4 规范

本边只改变下列明确命名的表示，补齐有明确证据的中断回合，并追加证据完整的缺失目录事实。未知可忽略事件的类型获得命名空间；每个获准源事件的 time、消息身份以及这些转换和下述坐标重映射之外的字段均保留。它不创建 system prompt、developer 事件、工具执行或替换消息。更早的 V0–V2 输入先经过各自现有迁移边到达 V3；那些边保留自身的转换与拒绝策略。

<a id="header-and-framing"></a>
### Header 与物理分帧

| 输入 | V4 结果 | 保留或拒绝 |
|---|---|---|
| 逻辑 V3 header | `version: 3` 变为 `4` | 先执行已发布 V3 header 校验；其他逻辑 header 字段均不变。 |
| V3 物理行 | 已发布 V3 源 codec 解码事件与紧凑 run | 源分帧和源事件区间解码仍归前一个包所有。 |
| V4 物理行 | `releasedV4SessionFormatCodec` 复用已发布 V2 分帧并执行原生 V4 接纳 | 不把 V4 事件投影到 V3 语义校验器。编码和解码不运行此入边迁移。 |

本边不重命名 preset id、PTC dispatch 事件标签、文件附件或物理文件名。内嵌流中的内容扩展遵循下列规则，流顺序和索引保持不变。

<a id="tool-results"></a>
### 工具结果表示

[liftToolResult](src/tool-role.ts) 转换 `tool/result` 事件中源表示为 user 角色的消息。它要求非空消息 id、带非空 call id 的 `{ kind: 'tool', callId }` 来源，以及恰好一个引用同一调用的 `tool-result` block。该 block 的 content 必须为数组；可选 `isError` 必须为布尔值。

| V3 字段 | V4 字段或处理 |
|---|---|
| `data.message.role: 'user'` | `role: 'tool'` |
| `data.message.content[0].toolCallId` | `data.message.toolCallId`，等于保留的 `source.callId` |
| `data.message.content[0].content` | 直接作为 `data.message.content`，包括空内容 |
| `data.message.content[0].isError` | 可选的 `data.message.isError` |
| Wrapper 的 `type: 'tool-result'` | 随 wrapper 移除 |
| 消息 `id`、`source` 和事件字段 | 保留；不生成新的消息或调用 id |

只有 wrapper 提供具有解释语义的调用 id、content 和可选错误标志。Wrapper 的其他字段变为 `plugin:result:<原字段名>`；外层消息除 `id`、`role`、`source` 和 `content` 外的字段变为 `plugin:message:<原字段名>`。后缀保留完整原名称，包括已有前缀。不同 owner 与重名字段分别保留值；`__proto__` 和 `constructor` 的自有数据保持完整。不添加 metadata 容器或新的内容类型。

格式错误的 canonical wrapper 引发格式错误。当前转换器不支持嵌套结果，遇到时拒绝且不发布 successor。转换不会修复矛盾的 `data.error`；原生目标校验要求它与 wrapper 的 `isError: true` 同时出现。后续可以扩展转换器支持范围，同时保持既定的原生 V4 表示。

<a id="extension-data"></a>
### 扩展数据

V3 未知内容标签变为 `plugin:<original-type>`，其他字段原样保留且不作解释。流起始块的 `blockType` 使用相同标签，其他字段的原始键和值均保留。内容标签的已有前缀会再次添加，使不同旧名称保持不同。不遍历实参、回放状态和插件内容字段。这些名称不会加载或执行插件。

请求工具定义保留自有字段的原始名称和值，包括普通扩展元数据。若定义拥有顶层 `deferLoading` 字段，则拒绝 V3 迁移：该字段仅在 V4 中定义，因此本迁移边不为它赋予历史含义。嵌套参数数据保持不变。原生 V4 对 `deferLoading: true` 的接纳规则不变。

<a id="message-sources"></a>
### 消息来源转换

[消息遍历器](src/sources.ts) 只访问下列 payload 位置。它转换旧插件包装，并保留直接来源 kind。

| 所属事件 | 消息位置 |
|---|---|
| `user/message` | `data` |
| `system/message`、`assistant/message`、`tool/result` | `data.message` |
| `agent/inbox/spliced` | 每个 `data.inserted[]` 成员 |
| `session/title-llm-request` | 每个 `data.messages[]` 成员 |
| `developer/message` | 仅由原生遍历器处理；未知可忽略 V3 事件被命名空间化，其 payload 不被访问 |

插件来源要求字符串 `plugin`，允许空字符串。转换移除该属性、替换 `kind`，并保留其他所有自有 JSON 属性。直接来源 kind 必须为非空字符串。转换不从消息文本、工具参数、配置或当前文件推断缺失元数据。

| 精确的 V3 `plugin` | V4 `kind` |
|---|---|
| `compact` | `compact-checkpoint` |
| `tools-code-mode`、`tools-ptc` | `ptc-mode` |
| `dsh-compaction-basic` | `compact-basic` |
| system 角色消息中的 `@deepseek-ai/dsh-system-prompt` | `system-prompt` |
| 其他角色中的 `@deepseek-ai/dsh-system-prompt` | `runtime-context` |
| 下文列出的同名第一方生产者 | 精确的 plugin 字符串 |
| 其他任何插件名 | `plugin:` 后接完整的原始名称 |

同名生产者为 `agent-instructions`、`session-reference`、`team-message`、`goal`、`skill-invocation`、`skill-catalog`、`coordinator`、`subagent-report`、`subagent-settled`、`webhook`、`agent-message`、`model-selection`、`plan-mode`、`time-context`、`tmux-context`、`user-approval`、`repeat-tool-reminder`、`tool-cordis`、`cordis-host-runner`、`tool-goal`、`tool-jobs`、`hooks-codex`、`hooks-claude-code`、`schedule` 和 `dsh-session-title-llm`。

完整的插件字符串保留在 `plugin:` 之后：名为 `acme` 的插件变为 `plugin:acme`。直接来源保留原 kind 和每个自有 JSON 字段，包括未知或已有前缀的 kind。

来源查找不递归进行。捕获的请求文本、assistant 回放状态与流、工具参数／内容元数据、Team 载荷以及任意嵌套对象均保留，除非另有明确命名的规则适用。

<a id="parent-catalog"></a>
### 父目录前置证据

`historicalChildCatalogSource()` 收集直属 subagent 子 Session 的 id、创建时间、继承截点之后自身的 `subagent/descriptor` 事件数量，以及首个 descriptor 载荷。子 Session 必须带有 `origin: 'subagent'` 和直接父级。补充事实要求 `childId`、非负安全整数 `childCreatedAt` 与 `descriptorCount`，以及 `descriptor` 属性；缺失的 descriptor 用 null 表示。可选 `sourcePath` 用于诊断。

| 可用证据 | 迁移决定 |
|---|---|
| 一个 version 1 descriptor | 要求字符串 provider 与 label；导出 `mode: 'continuable'`。 |
| 一个 version 2 或 3 descriptor | 要求字符串 provider；按目录规则使用其 mode 和可选 label。 |
| 没有 descriptor，或 descriptor 版本不受支持 | 保留已有父目录项；否则追加模式未知的目录项。 |
| 多个自身 descriptor | 保留已有父目录项，不比较 mode／label；否则追加模式未知的目录项。 |
| 已有自身父目录项 | 保留条目及其扩展；要求子创建时间一致，并在恰好一个受支持的自身 descriptor 可用时比较其 mode／label。 |
| 缺少自身父目录项，且受支持证据完整 | 追加带 child id、创建时间、mode 和可选 label 的 version-0 目录事实。 |
| 缺少自身父目录项，且证据不完整 | 追加 version-1 `subagent/catalog`，记录 header 身份和未知模式，不编造标签。 |

Catalog version 0 和 1 要求字符串 `childId`、非负安全整数 `childCreatedAt`、`continuable` 或 `one-shot` mode（version 1 还接受 `unknown`），以及 continuable mode 下的字符串 label；任何 mode 下存在的 label 都必须是字符串。重复的自身 child id 被拒绝。没有对应保留子日志的已有条目仍保留在父日志中。Descriptor 收集不恢复子级的旧 continuation composition，也不从工具参数恢复已删除子级。未知模式条目保留 header 身份信息，不声明子 descriptor 受支持。

Stage 只把最终继承截点之后的父目录记录作为候选。每个 inherited marker 都会丢弃更早的目录候选，不解释其载荷。缺失项追加在所有源事件之后，按创建时间、child id 排序，并使用连续的新序号。时间取最后一个源事件的 time；空日志则取 header 创建时间。这些记录既不进入模型表面，也不改变继承计数。

存储提供可识别的直属子证据，并在准备、memo 复用与发布时重新检查成员集合和物理修订。JSONL 提供方隔离不可读子 header、子日志解码失败和无效 descriptor 字段，同时保留其他目录项；准备父目录时不会迁移子目录。转换器仍拒绝冲突的已提供事实和发生变化的父历史。[JSONL 持久化](../session-persistence-jsonl/README.zh.md)拥有警告、来源检查与子会话错误隔离。当前 V4 读取不调用本转换器，直接校验原生目录字段、唯一性及投递归属。

<a id="sequence-references"></a>
### 序号引用与继承

当回合仍打开但没有打开的 step，且下一个连续编号的 `turn/start` 紧跟非空的 `next-turn` 类型 `agent/inbox/spliced` 时，Stage 可补齐该回合。它紧挨新 start 之前插入原因是 `interrupted` 的 `turn/end`，时间戳取该 start。开放尾部仍保持开放。其他回合顺序错误、未结算工具和进行中的 compaction 仍被目标校验拒绝。原生 V4 不执行此修复。

插入后，后续信封重新连续编号，并重映射已审计的同日志引用：`sourceEventSeqs`、替换端点 `startSeq/endSeq`、命令完成的 `sourceEventSeq`、标题的 `messageSeqs`、compaction 的 `shadowedRange` 与 `shadowedSeqs`，以及图片 offload 目标的 `seq`。捕获的 Session 引用、带代际的 delivery 坐标、turn／step 编号、stream 与图片索引、id 和任意 JSON 保持原值。未知可忽略事件的载荷和表面元数据保持不透明，只重排其信封序号。没有插入时，源事件坐标不变；追加的目录记录只扩展后缀。

对于 seeded Session，最后一个携带 `inherited: true` 的 `session/end-seed` 确定继承事件数量，且不计该 marker。目标计数包含该 marker 之前插入的事件。传入的源截点必须与 V3 Stage 原始 marker 位置一致，包括先前 V0–V2 迁移已对其重映射的情况；缺少 tagged marker、unseeded Session 含 inherited marker、或截点超出事件范围时拒绝。Unseeded Stage 在 EOF 前公开零；seeded Stage 到 `finish()` 才确定计数。Untagged marker 不定义 fork 继承。

<a id="delivery-guards"></a>
### Delivery 代际

| Delivery 记录 | 接纳与保留 |
|---|---|
| 任何被解释的 `session-log-deepseek/delivery-accepted` | 代际必须为非负安全整数；省略表示 V0。 |
| V3 源 marker 声明 generation 4 | 拒绝：提升 header 不得激活目标代际的 watermark。 |
| generation 3 的 V3 源 marker | 要求非空 Session id 和早于 marker 的非负安全整数 `throughSeq`；只有在继承截点之前且带 `parentSession` 时才允许其他 Session id。 |
| 其他源代际，包括高于 4 的值 | 原样保留事件类型及 payload 坐标；它们在 V4 中仍未激活。 |
| generation 4 的原生 V4 marker | 以 V4 为当前代际，应用同样的较早坐标和 Session 归属检查。 |
| 原生 V4 中的历史 marker，包括 generation 3 | 保留记录的坐标与身份；它不是 V4 接纳 watermark。 |

不改写投递 payload 或事件类型。未来的激活检查归对应的更高版本迁移所有，本边只检查向 V4 的提升。标记的信封序号随插入重映射；源代际归属仍按原 V3 序号和继承截点校验。

<a id="source-audit"></a>
### 源审计与拒绝

Stage 之前先执行 V3 物理解码与 header 校验。Stage 按上述规范检查连续序号、源截点、canonical 工具结果 wrapper、命名的 plugin 来源、delivery 归属及传入的目录证据。它不运行完整的已发布 V3 语义恢复器，也不复制 V2→V3 的事件／内容允许列表。完整恢复还会应用下述 V4 目标规则；物理解析、Stage 转换与目标恢复是不同的检查。

只转换列明的消息及字段。无关事件及任意 JSON 不会因字符串或数字匹配而获得新含义。固定的 `RELEASED_V3_EVENT_TYPES` 集合独立于当前 writer 区分源事件和扩展。Stage 在解释载荷或查询 V4 词汇之前拒绝 V3 未知必需事件，包括 V4 已认识的名称。未知可忽略事件名称变为 `plugin:<original-name>`，载荷不变。不隐含通用源 schema 校验或递归数字字段推断。

只有 canonical V3 `tool/result` wrapper 具有保留信息的转换。其他被解释位置中的已退役 `tool-result` block 由目标接纳拒绝，不作为无效 V4 block 保留。原生 V4 在 recoverable 后缀抑制前应用同样的标签拒绝。检查只覆盖以下位置：

| 所有者 | 检查退役标签的内容 |
|---|---|
| `user/message` | `data.content[]` |
| `system/message`、`developer/message`、`assistant/message`、`tool/result` | `data.message.content[]`；canonical 源 tool/result wrapper 在目标检查前已提升 |
| `agent/inbox/spliced`、`session/title-llm-request` | 分别为 `data.inserted[].content[]` 与 `data.messages[].content[]` |
| `team/message/queued` | `data.message.content[]` |
| `compaction/summary`、`tool/ptc-dispatch` | 分别为 `data.summary[]`、可选 `data.rawOutput[]` 与 `data.content[]` |
| 内嵌 assistant 流 | `assistant/message.data.stream[]` 和 `assistant/attempt.data.stream[]` 中 `type: 'chunk'` 的条目：`block-end` 的 `chunk.block.type`，以及 `block-start` 的 `chunk.blockType` |

[退役语法检查](src/retired-syntax.ts)只检查直接 block 标签，不遍历任意后代。工具参数、回放状态、JSON-schema parameters、嵌套元数据及未知 ignorable 事件载荷保持不透明。未知 ignorable developer 载荷推迟到读取器词汇表识别它时检查；writer 即使给已知 developer 记录标上 ignorable，也会校验它。

直接 Stage 可对格式错误的数据抛出 `SessionFormatError`，或在无法保留信息地转换时抛出 `SessionFormatUnsupportedMigrationError`。Catalog 把 Stage 失败包装为不支持迁移；transformed 目标校验失败也使用该分类。Strict current 校验直接报告目标失败。物理损坏遵循所选 decoder 恢复策略。任何前缀都不构成完成的恢复，拒绝也不授权修改源、发布部分后继或回退代际。

-----

<a id="native-v4-admission"></a>
## 原生 V4 接纳

已经标记为 V4 的输入从不运行 V3→V4。原生校验保留记录的事件并返回同一产物；它不合成目录项、fork 结果、developer 变更或修复后的源字段。以下目录说明当前已接受 V4 规则，与历史转换分开。

<a id="native-fields"></a>
### Header、消息与表面元数据

| 数据 | 原生规则 |
|---|---|
| 逻辑 header | 精确的必需字段 `version`、`id`、`createdAt`、`isSeeded`、`delegationDepth`；可选字段 `cwd`、`parentSession`、`origin`、`agentPreset`；无其他键。Version 为 4，id 为字符串，创建时间／深度为非负安全整数，seeded 为布尔值，存在的 cwd 为绝对路径，可选 id 为字符串，存在的 origin 为 `subagent`。 |
| 事件信封 | 必需字段为 `type`、`seq`、`time` 和 JSON `data`；只允许可选的 `surfaceOp`、`sourceEventSeqs` 与 `ignorable`。序号为连续的非负安全整数，time 为安全整数，存在的 `ignorable` 必须恰好为 true。 |
| 表面消息 | System、user、developer、assistant 和 tool/result 要求 placement，以及身份明确且角色匹配的消息。普通消息信封及角色专用来源接纳由已安装 Session 校验负责。 |
| 替换与引用 | 端点按当前表面顺序选择包含两端的区间；引用指向更早事件并覆盖移除节点。受保护的首个 system head 只能由恰好覆盖该 head 的单个 system 消息替换。 |
| Request header | 拒绝已退役的 `header.system`（包括空值）及格式错误的 header／data 记录；已安装 Session 检查当前 config、reason、adapter-default 标记，并要求省略空 `tools` / `adapterDefaults`。 |
| 工具结果 | 要求 tool 角色、非空消息／调用 id、匹配的 `source.kind: 'tool'` 与 `source.callId`、直接数组 content、不含已退役结果 wrapper，以及存在时为布尔值的 `isError`。`data.error` 要求 `isError: true`。 |
| System 消息 | 要求正 turn／step、非空 id、system 角色、数组 content 和 system-prompt 来源。检查已知 text／reasoning、tool-call 及 image 字段；拒绝已退役 tool-result wrapper。额外 JSON 元数据及可通过合并扩展的 block kind 不会被全局删除。 |
| 生产者归属 | 被解释的消息槽要求对象 source，以及非空且不是 `plugin` 的 kind。未知归属和自有 JSON 元数据保留；这不授予生产者运行时权限。 |

五种表面事件都要求 `surfaceOp`。存在的 `sourceEventSeqs` 必须是非空数组，包含互异、更早、非负的安全整数序号；`assistant/message` 必须省略它。由于替换必须引用全部移除节点，assistant 事件自身不能替换表面区间。已知纯日志事件不能携带任一字段。替换对象只能包含 `op: 'replace'`、`startSeq` 与 `endSeq`；旧端点名、混合写法及额外键均被拒绝。

Request-header config 要求非空 provider／model 字符串；存在的 reasoning effort 为非空字符串。`reason` 为 `initial`、`resume`、`change` 或 `series`，存在的 `startsSeries` 为 true。Adapter-default 标记只能使用 `reasoningEffort` 与 `maxTokens`，值均为 true，且对应 config 值必须存在。这些检查不执行任意工具 JSON schema。

System image 接纳要求非空 attachment id、PNG／JPEG／WebP／GIF MIME 类型之一、非负 bytes、正 width／height、可选字符串 name，以及存在时为正的原始尺寸。原生存储接纳与具体模型提供方能否表示该内容是不同的问题。

当前通用接纳不会按完整的生成 schema 校验每个 user／tool／developer content block。它检查消息身份、角色、来源与数组容器；代际专用校验器只增加此处列出的检查。因此，未知 block kind 和未检查的字段可能通过存储接纳，但仍被提供方拒绝。

<a id="native-relationships"></a>
### 生命周期与引用关系

| 所有者 | 必需关系 |
|---|---|
| `turn/start`、`turn/end`、`step/start`、`step/end` | Turn／step 编号有序，开放所有者匹配，turn／step 不重叠，结束边界不遗留已声明或已开始但未解决的工具调用。未完成尾部保持开放。 |
| `assistant/message`、`tool/call`、追加的 `tool/result` | 匹配开放 step；声明的调用 id 唯一，开始保留 name／arguments，结果结算一个已声明调用。开始之前的结果必须是精确获准的 `TOOL_NOT_STARTED` 修复。工具结果的表面替换要求开放 turn，不重放原始调用生命周期。 |
| `system/message`、`developer/message`、`assistant/attempt` | 匹配开放 turn 与 step。Request header 和 context 要求开放 turn。 |
| `tool/ptc-dispatch-start`、`tool/ptc-dispatch` | 要求开放 turn、唯一 sub-call 开始与结算、稳定的 root／parent／name／arguments，以及属于同一 root 的嵌套 parent。 |
| `llm/retry`、`llm/retry-started` | 匹配当前请求 provider 和 turn／step，每条策略链的尝试连续、retry 身份稳定，每次 start 匹配一个先前已调度的尝试。 |
| `session/title`、`session/title-llm-request` | 引用互异且更早的真人 `user/message` 事件。用户指定标题没有引用；其他标题具有引用。LLM 标题请求带非空引用和一个来源为 `dsh-session-title-llm` 的 user 角色文本消息。 |
| `command/run`、`command/done` | Run id 唯一；完成记录对应先前 run。存在的完成 `sourceEventSeq` 引用更早的非 command 事件，并伴随 success。 |
| `compaction/start`、`compaction/summary`、`compaction/end` | 匹配 compaction id、源 command 和活动 turn 上下文。Summary 区间引用精确的当前表面节点且排除 protected head；成功完成需要一个 summary。继承的未完成 compaction 在 end-seed marker 处过期。 |
| `compaction/prune` | 其区间引用精确的当前表面节点且排除 protected head；它不要求存在 compaction 事务或其所有者字段。 |
| Compact checkpoint 替换 | 其 `compact-checkpoint` 来源标识活动 compaction。 |
| 原生 `subagent/catalog` | 检查继承截点之后的自身 version-0/version-1 载荷字段与 child id 唯一性。原生读取既不收集子日志，也不比较其物理事实；继承项不建立自身成员关系。 |
| 继承截点与 delivery | 应用上文的 marker、坐标及代际归属规则。 |

这些检查由 [relationships.ts](src/relationships.ts) 按代际拥有。完整的通用消息／信封接纳与插件拥有的消息投影还使用已安装 Session；单独的导出 V4 恢复器不能替代完整 catalog 恢复。

<a id="developer-changes"></a>
### Developer 变更与延迟 schema

本边不创建 developer 历史。原生 `developer/message` 要求正 turn／step 坐标、developer 角色、非空消息 id、数组 content，以及生产者拥有的来源元数据。每个 `tool-addition` 或 `tool-removal` block 都要求非空 `toolName`。添加块拒绝任何自有内嵌 `tool` 字段，包括其他情况下可作为可选 JSON 元数据的值。

含有添加块的事件必须带 `headerSeq`，为该事件内全部添加选择一个更早且已知的 `request/header`。每个名称必须在那里恰好匹配一个带字符串 `description` 和对象 `parameters` 的定义。缺失、前向、错误类型、未知、歧义或不完整的绑定均被拒绝。没有添加块的事件必须省略 `headerSeq`；`sourceEventSeqs` 仍是独立的派生／替换元数据。替换、fork、重启和 compaction 保留记录的绑定，不查询当前 registry 或最新 header。

普通消息、inbox／title 输入、compaction summary／raw output 以及内嵌 assistant block-start／block-end 记录中的工具变更块均被拒绝。存在的 `request/header.header.tools[].deferLoading` 必须恰好为 true；它与是否存在 developer 添加事件无关。空 developer 节点保留表面位置，不产生模型消息，也不能替换 protected system head。未知 ignorable developer 载荷推迟到读取器知道该事件类型时校验。

原生格式支持校验并保留 developer 历史。[LLM 运行时](../../llm/llm/README.zh.md) 按路由投影工具更新，并在不支持的路由上省略 developer 消息；Chat 和 Trajectory 渲染工具变更通知。这些消费者使用已接受的表示，不新增格式。

<a id="fork-results"></a>
### Fork 生成的结果

Fork 种子构造归核心 Session 所有，不属于此迁移。原生 V4 接纳它生成的 `TOOL_NOT_STARTED` 合成错误结果，其 id 为 `forked-tool-result-<callId>-<seq>`，角色为 tool，source／call id 匹配，带 `isError: true`、`ToolNotStartedError` 和一个 text block。追加结果携带自身序号且没有源引用；后续替换保留更早的后缀，并精确引用那个原始结果。分支专用文本保留，不归一化为崩溃恢复措辞。

已经开始的 fork 调用使用 `TOOL_OUTCOME_UNKNOWN` 错误结果，并保留记录的开始引用。它们遵循普通已开始调用的校验；上文专用于 not-started 的身份规则不适用于它们。Fork 构造通过 `turn/end.reason.kind: 'forked'` 关闭开放尾部，保留先前已结束的 step 和 turn。

普通 interrupted not-started 修复保留 canonical 历史整数后缀和精确的崩溃恢复文本。两种形式都必须按生命周期规则结算一个已声明调用。Stage 保留已有 fork／call／message id；它不从字符串前缀推断祖先关系，也不执行工具。

<a id="native-recovery"></a>
### 校验入口与恢复

| 入口 | 检查与限制 |
|---|---|
| V4 codec 解码 | 已发布物理分帧加 V4 行接纳。Required 前代 PTC 标签、已退役 system header 和自身负责的错误原生字段，在 recoverable 后缀抑制前被拒绝。 |
| V4 codec 编码 | 同样的原生行检查；writer 仍校验 ignorable developer 载荷。 |
| 原生 catalog，`validation: 'transformed'` | 只有 codec 检查；因为没有执行迁移，跳过产物恢复。这不是完整原生校验。 |
| 历史 catalog，`validation: 'transformed'` | 转换后执行代际自有的 V4 恢复；跳过已安装 Session 的通用校验。 |
| Catalog，`validation: 'current'` | 代际自有 V4 检查加已安装当前 Session 的 header、信封、消息、表面与投影校验。Fixture 与发布验证使用 strict recovery。 |
| 原生 JSONL scanner | 在恢复前把已安装词汇表传给行接纳，并在暴露已接纳前缀前执行必需的 V4 关系检查。 |

支持词汇表的恢复器拒绝未知 required 事件。未知 ignorable 载荷不被解释；required `tool/code-dispatch-start` / `tool/code-dispatch` 作为退役语法被拒绝，而 ignorable 前代事件保持不透明。没有词汇表时，物理解码器推迟解释 ignorable developer 载荷；知道 developer 事件的原生读取器必须在接纳 recoverable 后缀前校验它们。只有被接纳的 inherited marker 才能确定截点。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

迁移声明创建相互独立的流式 Stage。紧凑事件段通过迭代器展开，不生成中间事件数组。V3 到 V4 Stage 在发出 V4 事件时重写历史消息来源、提升历史工具结果包装，并插入有明确证据的中断回合结束事件。它为每个源事件保留一个源到目标的序号映射项，用于本地引用重映射。V4 编解码器只为物理头部和源范围分帧使用已发布 V2 编解码器，并直接校验原生工具角色行；它不会调用已发布 V3 校验器或源转换视图。JSONL 扫描器在抑制可恢复行之前调用 `assertV4RowAdmission`，并在返回完整逻辑前缀之前调用共用的强制关系校验器。

目标恢复器校验原生字段和强制跨事件关系，然后返回原始产物。未知的可忽略事件保持不透明，未完成的继承压缩事务在 end-seed 标记处结束。本包不发布运行时不变量伴随插件，因为这个纯函数库不拥有独立维护的运行时观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [格式版本与发布状态](../../../docs/session-format-status.zh.md) — 当前检出写入版本与已发布格式的权威记录。
- [添加 Session 格式版本](../../../docs/cookbook/adding-a-session-format-version.zh.md) — 相邻迁移边的集成与校验。
- [JSONL 持久化](../session-persistence-jsonl/README.zh.md) — 不可变代际选择与发布。

-----

<a id="model-experience"></a>
## 模型体验

### 历史恢复

#### 模型看到什么

历史请求保留记录的消息与模型配置。[迁移 Stage](src/migration.ts)将 `tool/result` 载荷表示为工具角色消息，不添加模型可见内容；目录记录不会直接进入模型消息，后续子代理列举可以发现历史子 Session。

#### Token 影响

转换不改变请求文本或承载 token 的数据。

#### KV Cache 影响

该迁移边保留记录的请求前缀。提供方缓存的可用性和淘汰策略不属于本库职责。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **历史转换器覆盖范围** — 未支持的源表示可能拒绝迁移，不发布后继文件，也不修改源文件。一方录制不等于第三方扩展全集。V4 发布后，只要输出仍兼容 V4，后续转换器修复就可以增加支持。解释流起始块的额外字段或处理未来投递代际，应以具体格式变更为依据。
- **已接受 V4 转换**——[检查点](../../../docs/session-format-status.zh.md#finalization-record)保护已接受历史。向后兼容的新增可以通过新的确认记录保留 V4；破坏性变更要求后继版本。已写入的 V4 文件不会重跑此入边，历史输入保持不变。
- **V5 前置读取器**——V4 子日志证据目前经过已安装目录。后续写入器在改变该目录前，须绑定固定代际的 V4 前置读取。导出的 V4 恢复器提供代际自有检查；完整的通用消息接纳还使用已安装的 Session 校验。
- **历史嵌套工具结果**——当前迁移拒绝包含另一个 tool-result wrapper 的结果。原始代际保持完整，且不发布 V4 successor。后续转换器可以支持有证据的源数据场景，而不改变既定 V4 格式；[迁移 cookbook](../../../docs/cookbook/adding-a-session-format-version.zh.md#stages-and-validation) 定义了这一区别。
- **历史扩展消费者**——带前缀的消息与结果字段保留 JSON 数据，不激活核心字段。消费者必须明确理解这些字段后才能解释它们。
- **依赖保留的子日志**——仅凭父日志无法恢复未记录的子 id、创建时间或 descriptor。删除的子 Session 无法从工具参数恢复；已存在的父目录记录仍保留。
- **历史模式未知**——没有恰好一个受支持的自身 descriptor 时，缺失的父目录项记录未知模式。当前读取不重写该项；打开子会话时解析可用的 descriptor 信息，或报告该子会话的错误。
- **存储范围**——事实只覆盖同一持久化根目录内可识别的子 Session。跨根目录导入和损坏日志修复不属于此迁移。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
