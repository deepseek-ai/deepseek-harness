---
description: "完整的 V2 到 V3 会话转换：系统头节点、经过审计的引用、PTC 与预设名称、规范信封、保留与拒绝规则。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v2-to-v3

[English](README.md) | 中文

## 概述

将受支持的已发布 V2 会话恢复为 V3，同时保留历史请求含义。本页是这条相邻迁移边的单一规范真源：先说明转换、保留与拒绝的内容，再单独说明原生 V3 准入。本库将系统提示词提升为消息，重映射本地事件引用，转换 PTC 与预设名称，并规范化信封。持久化通过静态目录使用本库；本库不读取或发布文件。

## 目录

- [使用本包](#use-this-package)
- [V2 到 V3 规范](#v2-to-v3-specification)
  - [头部与预设引用](#header-and-presets)
  - [系统头节点与消息身份](#system-head)
  - [序列引用与继承](#sequence-references)
  - [PTC 词汇](#ptc-vocabulary)
  - [规范信封与工具错误](#canonical-envelopes)
  - [投递保护](#delivery-guards)
  - [源审计与拒绝](#source-audit)
- [原生 V3 准入](#native-v3-admission)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 使用场景

使用[目录](../session-format-catalog/README.zh.md)恢复会话。直接导入用于目录组装和测试；本库没有 Cordis 挂载配置。[公共导出](src/index.ts)提供迁移声明、已发布 V2 源编解码器、V3 目标编解码器、目标头校验器和目标恢复器。

### 入口

仅头部操作不会转换或校验事件正文：

```text
const targetHeader = sessionFormatV2ToV3.migrateHeader(sourceHeader)
```

完整恢复将解码后的事件送入新的阶段，并校验目标产物。调用方不得将阶段的部分输出视为成功恢复：错误可能出现在后续事件或 `finish()`。[格式协议](../session-format/README.zh.md)负责阶段调度与目录错误处理；[JSONL 持久化](../session-persistence-jsonl/README.zh.md)负责读取准备和不可变后继代的发布。

-----

<a id="v2-to-v3-specification"></a>
## V2 到 V3 规范

整条迁移边不是恒等转换。它保留源事件的相对顺序、时间戳和每个历史请求的含义，但插入的系统事件会改变事件数、稠密序列位置、本地引用和继承切点。PTC/预设转换及最终信封规范化不添加事件。只有下文列出的字段发生变化；保留承诺适用于已接纳的输入，而非任意未经审计的扩展。

<a id="header-and-presets"></a>
### 头部与预设引用

逻辑头部将 `version: 2` 改为 `version: 3`。它保留 `id`、`createdAt`、`isSeeded`、`delegationDepth`，以及已接纳的可选字段 `cwd`、`parentSession` 和 `origin`。在 `header.agentPreset` 和每条 `agent-preset/selected.data.agentPreset` 中，精确匹配的预设标识 `code` 变为 `ptc`，包括继承与本地选择。其他字符串和缺失的头部预设保持不变。选择载荷要求字符串预设标识，并拒绝未经审计的成员。

此转换不检查已安装预设，也不改写其他位置的 `code`。已发布 V0/V1 数据仅在经过冻结的前代迁移边到达 V2 后接受此转换。原生 V3 自定义预设标识不被重命名，`settings.yaml` 不属于本包范围。

<a id="system-head"></a>
### 系统头节点与消息身份

首个 `step/start` 后立即追加空 `system/message`，即使该步骤在发出请求前中止。后续步骤不再创建头节点。没有步骤也没有 surface 的日志不会获得头节点或虚构请求。

在每条 `request/header` 处，缺失的 `data.header.system` 表示空提示词；否则，其字符串与当前提示词进行精确比较。发生变化时，在该请求头之前立即插入系统消息，恰好替换当前受保护的头节点，并在 `sourceEventSeqs` 中引用它。提示词不变时不插入消息。空字符串和缺失字段会清空先前的提示词；仅含空白的字符串仍为非空文本。每个请求头都会移除 `data.header.system`，无论是否需要替换。

合成消息携带开放步骤的 `turn` 和 `step`、锚点事件的 `time`、角色 `system`，以及来源 `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }`。空提示词使用 `content: []`；其他提示词使用包含精确字符串的单个文本块。首次追加没有源事件引用；每次替换的两个端点及唯一源引用都使用前一头节点的目标序号。空头节点保持受保护，但不产生模型消息。

每个合成标识由 `v2-to-v3-system-` 加上 `JSON.stringify(['session-format-v2-to-v3', sourceHeader.id, anchor.seq, anchor.type])` 的十六进制 SHA-256 构成。首次创建的锚点是源 `step/start`，替换的锚点是提示词变化的 `request/header`。与已生成或源消息标识的冲突均被拒绝，不受遇到顺序影响；检查范围包括收件箱插入消息与标题请求消息中的标识。现有消息标识绝不改变。特别是，`TOOL_NOT_STARTED` 修复标识保留规范的历史 `interrupted-tool-result-<callId>-<integer>` 后缀；该后缀不是目标序列坐标。

<a id="sequence-references"></a>
### 序列引用与继承

源事件必须从零开始稠密排列。每个原始事件在其前面的插入完成后获得目标位置。[引用映射器](src/references.ts)仅修改以下同产物引用；每个被引用的源位置必须指向已建立映射的更早事件：

| 所有者 | 重映射字段 |
|---|---|
| Surface 信封 | `sourceEventSeqs[]`；规范重命名前的 `surfaceOp.start/end` |
| `command/done.data` | 存在时的 `sourceEventSeq` |
| `compaction/summary.data` 和 `compaction/prune.data` | `shadowedRange.start/end` 和 `shadowedSeqs[]` |
| `session/title.data` 和 `session/title-llm-request.data` | `messageSeqs[]` |

不存在递归数值字段改写。投递的 `throughSeq` 和 `sessionFormatVersion`、会话引用的 `capturedThroughSeq` 和 `capturedFormatVersion`、工作流本地 `seq`、流块索引、轮次/步骤编号、收件箱索引、token/字节计数以及所有标识都保留源值。内嵌 assistant 流、模型回放状态、工具参数/结果、标题请求输入文本及 `data.system` 保留已记录的含义。压缩（compaction）载荷端点保持 `start/end` 名称；仅信封替换端点被重命名。

对于有种子的会话，最后一条带有 `data.inherited: true` 的 `session/end-seed` 标识源切点。其源序号等于继承事件数，不含该标记；其映射后的目标序号即目标切点。此前的合成事件属于继承部分，此后的属于本地部分。未标记继承的结束标记不建立切点。若提供 `sourceInheritedEventCount`，则必须一致；有种子但没有标记的日志，以及无种子却有继承标记的日志都会被拒绝。无种子阶段公开 `headerInheritedEventCount: 0`；有种子阶段保持未知，直到 `finish()` 推导精确切点。这也支持前一阶段改变事件数、无法在 EOF 前提供切点的 V0/V1 迁移链。

<a id="ptc-vocabulary"></a>
### PTC 词汇

精确的事件标签 `tool/code-dispatch-start` 和 `tool/code-dispatch` 变为 `tool/ptc-dispatch-start` 和 `tool/ptc-dispatch`。其载荷值保持不变。仅在以下三个位置的 `source.kind === 'plugin'` 时，精确匹配的插件归属 `tools-code-mode` 才变为 `tools-ptc`：

- `user/message.data.source.plugin`
- `agent/inbox/spliced.data.inserted[].source.plugin`
- `session/title-llm-request.data.messages[].source.plugin`

相似插件名、其他来源种类、任意文本、嵌套 JSON 及包含 `:code:` 的历史标识保持不变。此转换不重命名 `run_code` 或其 `code` 参数。已使用任一 V3 保留 PTC 标签的 V2 源事件即使可忽略也会被拒绝；不透明源扩展不得通过迁移获得当前生命周期含义。

<a id="canonical-envelopes"></a>
### 规范信封与工具错误

结构插入和引用重映射完成后，规范化将原始与合成事件上的精确信封替换对象 `{ op: 'replace', start, end }` 转为 `{ op: 'replace', startSeq, endSeq }`。它仅从 `request/header.data.header` 中省略精确的 `tools: []` 和 `adapterDefaults: {}`。这个最终操作保留其输入事件数、坐标、时间戳、顺序与继承切点；既不重复映射，也不规范化 `config.stop: []` 等无关空值。

四种 V3 surface 类型（`system/message`、`user/message`、`assistant/message`、`tool/result`）都要求 `surfaceOp`。仅 assistant 消息禁止 `sourceEventSeqs`；其他类型提供的列表必须非空、唯一，且仅引用更早的事件。已知仅日志事件对这两个 surface 元数据字段均不允许。替换不允许别名或额外键。端点按当前 surface 顺序而非数值序号顺序标识闭区间；恢复会检查存活成员、端点顺序与完整源事件覆盖。

源 surface 事件本就要求位置标记；迁移不虚构缺失的追加标记。带有 `data.error` 的 `tool/result` 要求其唯一工具结果块携带 `isError: true`。失败结果可以省略结构化错误身份。矛盾结果会被拒绝，绝不通过添加 `isError` 或删除诊断来修复。普通工具与 PTC 生命周期关系仍须在这些事件本地检查后验证。

<a id="delivery-guards"></a>
### 投递保护

V2 `session-log-deepseek/delivery-accepted` 若携带 `data.sessionFormatVersion === 3`，就会被拒绝，而非提升为 V3 上传水位。其他代的标记保留其载荷，包括缺失代次和非目标的未来代次。V2 代标记必须具有有效且更早的 `throughSeq`；若它指向另一个会话，则仅允许出现在具有 `parentSession` 的会话的继承前缀中。本地的外部会话标记或没有父会话元数据的外部会话标记会被拒绝。标记的信封序号正常变化；其捕获的接收坐标不变。

<a id="source-audit"></a>
### 源审计与拒绝

迁移分类[已发布 V2 事件清单](../session-format-v1-to-v2/src/dispositions.ts)，包括仅日志的 `assistant/attempt`，以及 `feedback/message-put` 和 `feedback/message-delete`。[载荷校验器](src/payload.ts)应用精确的已接纳信封和载荷成员，以及已发布嵌套校验。未知事件（即使可忽略）以及被检查记录中未经审计的成员均被拒绝。消息来源分类覆盖下表的五个消息位置：未知来源种类会被拒绝，agent（智能体）中继归属则被接纳，但标识不会被解释为会话引用。

内容审计仅接纳 `text`、`reasoning`、`image`、`file`、`tool-call` 和 `tool-result`。它校验归本格式所有的块字段，并在以下有限位置递归审计每层嵌套的 `tool-result.content`：

| 所有者 | 审计内容 |
|---|---|
| 五个 Message 位置 | `user/message.data.content`；`assistant/message.data.message.content`；`tool/result.data.message.content`；`agent/inbox/spliced.data.inserted[].content`；`session/title-llm-request.data.messages[].content` |
| 排队的团队消息 | `team/message/queued.data.message.content`；历史 Team 载荷保持 `version: 1` 并带有 `message.delivery` |
| 压缩输出 | `compaction/summary.data.summary` 和可选的 `compaction/summary.data.rawOutput` |
| PTC 前代输出 | `tool/code-dispatch.data.content` |
| 内嵌 assistant 流 | `assistant/message.data.stream[]` 和 `assistant/attempt.data.stream[]` 中的原始 `type: 'chunk'` 记录：`block-end` 的 `chunk.block` 和 `block-start` 的 `chunk.blockType`，包括尚无完整块的起始记录 |

所有位置共用同一历史种类集合；未完成的起始记录不能引入未知种类。未知种类和归本格式所有的畸形块都会拒绝整次迁移；目录恢复报告 `SessionFormatUnsupportedMigrationError`。诊断标明源事件类型、源序号、包含索引的完整载荷路径和违反的规则。未知种类错误标明违规种类；已知块的畸形错误标明种类和字段错误。畸形内容容器或缺失块报告其位置，而不虚构种类。拒绝时，持久化保留源字节且不发布后继代。

准入不改写内容。特别是，内嵌流虽然接受归本格式所有的块字段检查，其字节仍保持不变。工具参数、`replayState.response` 和 `replayState.blocks` 保持不透明；任意 JSON 内的同名字段不会触发此审计。文件附件元数据接受校验，但标识或字节计数不会被解释为 Session 引用。这不是通用 schema 审计或递归坐标推断，原生 V3 扩展准入与此分开。

首个步骤前的 surface 事件、开放步骤外的提示词变化或生成标识冲突，会抛出 `SessionFormatUnsupportedMigrationError`，而非移动事件或虚构归属。源字段格式错误、缺失位置、无效引用、不一致切点、投递违规与矛盾工具结果，会在直接阶段或目标校验器中抛出格式错误。目录将迁移阶段和转换后目标校验失败报告为类型化的不支持迁移；物理解码失败仍按所选恢复策略归类为损坏。本迁移边不修复源或目标，不回退代次，也不改写文件。

-----

<a id="native-v3-admission"></a>
## 原生 V3 准入

已标记为 V3 的输入不运行 V2 到 V3 迁移。使用 `validation: 'transformed'` 的原生目录读取仅执行编解码器检查，跳过产物恢复；完整关系、开放步骤归属、受保护头节点操作与词汇检查需要 `restoreReleasedV3Artifact` 或目录的 `validation: 'current'`。以下规则区分这些恢复检查与编解码器准入；它们不是额外的历史转换：

- 原生 V3 接纳历史内系统消息追加、非头系统节点替换和非头系统节点压缩。系统消息要求有效载荷及匹配的开放步骤归属。首个 surface 系统头节点只能被恰好覆盖该头节点的系统消息替换；普通替换和压缩不能消耗它。迁移本身只产生初始头节点与头节点替换，不产生依赖路由的历史内更新。
- 原生 V3 拒绝任何 `request/header.data.header.system`，包括空值或格式错误值，并拒绝非规范替换拼写及两个空请求头可选字段。它保留空白内容、空停止列表和已接纳的嵌套 header/source/data 扩展。此扩展准入不会扩大 V2 源审计或精确的逻辑会话头字段范围。
- 必需的前代 PTC 标签即使已安装也会被拒绝。已退役或未知的可忽略事件（包括其逻辑元数据）保持不透明，且不能满足当前 PTC 关系。已安装的普通事件新增项作为仅日志信封接纳；未知必需类型由识别词汇的恢复阶段拒绝。物理编解码器仍执行已发布的分帧与源事件区间编码规则。
- V3 事件本地检查在编码前及解码后执行。原始行的已退役系统头字段、畸形系统载荷和必需前代 PTC 的拒绝先于可恢复抑制执行，包括损坏行之后。严格读取立即拒绝规范错误。可恢复的规范解码不产出首个无效事件及其后缀；后续 `turn/end` 建立提交事实并拒绝该后缀。只有已接纳的继承标记计数；有种子的已接纳前缀若没有标记则被拒绝。未分类事件元数据会延迟到识别词汇的恢复阶段，而不是作为规范损坏丢弃，因此不能隐藏未知必需类型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[阶段](src/migration.ts)拥有每份产物独立的同步序列映射、消息身份集合和提示词/生命周期状态。紧凑事件段增量展开。[编解码器](src/codec.ts)复用冻结的 V2 分帧；[恢复器](src/validation.ts)先校验 V3 结构，再向冻结的普通关系校验提供私有 system/PTC/修复标识与端点视图。该视图为投递检查保留实际目标代次，且绝不对外返回：恢复返回原始 V3 产物与身份。冻结的 V0 到 V1 和 V1 到 V2 语义保持不变。本库不拥有可独立观察的注册或状态副本，因此不发布运行时不变量伴随入口。

[组合目录测试](tests/combined-migration.spec.ts)验证转换组合与原生重新打开；[迁移测试](tests/migration.spec.ts)和[规范测试](tests/canonical-envelopes.spec.ts)固定保留与拒绝规则。[持久化集成](../session-persistence-jsonl/tests/v2-ptc-migration.spec.ts)负责发布证据。[已发布格式决策](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)负责将相邻组合测试与原生准入测试分开的依据。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [已发布 V1 到 V2](../session-format-v1-to-v2/README.zh.md) — 冻结的前代转换与源编解码器。
- [系统提示词 surface 决策](../../../.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.zh.md) — 提示词归属与头节点保护依据。
- [规范 V3 信封决策](../../../.agents/notes/implemented/architecture/2026-09-06-v3-canonical-session-envelopes.zh.md) — 严格准入与校验归属。

-----

<a id="model-experience"></a>
## 模型体验

### 历史日志恢复

#### 模型看到什么

每个历史请求保留其提示词文本与普通消息内容。空系统头节点不产生模型消息。PTC 归属使用 `tools-ptc`；分发事件仍仅写日志。

#### Token 影响

迁移边不添加模型可见文本；它将已记录的提示词从请求头移入消息历史。

#### KV Cache 影响

迁移边保留历史请求含义与模型配置；它不保证提供方缓存命中，也不保证与原生 V3 录制字节相同。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **历史预设歧义** — 已发布 `code` 引用无法区分与旧内置标识同名的自定义预设；[精确重命名](#header-and-presets)不依赖宿主。
- **不迁移文件或设置** — 本包绝不修改已提交代或 `settings.yaml`。持久化负责发布最终后继代；已有 V3 代不重新运行其入边。格式发布状态见[状态记录](../../../docs/session-format-status.zh.md)，兼容性义务见[已发布格式策略](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
