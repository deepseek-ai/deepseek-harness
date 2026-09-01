---
description: "面向快照测试的无密钥 LLM 回放插件，供测试作者针对已记录模型 transcript 启动真实 agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-replay

[English](README.md) | 中文

## 概述

`dsh-llm-replay` 让快照测试无需 API 密钥即可运行：它安装一个回放 LLM（大语言模型）适配器，从已记录的会话 JSONL fixture（测试前置数据）重建模型流，使测试针对固定 transcript（文本记录）启动真实 agent（智能体）。fixture 是持久化会话日志的投影——`assistant/chunk` 事件按调用分组为分片序列，显式标记的本地压缩（compaction）调用回放为一条规范流。`replay.override.json` 伴随文件覆盖日志无法重建的情况：任何分片之前就抛出、取消/挂起，或注入重试。实时会话按首次调用顺序绑定到已记录脚本，因此父会话与 subagent 场景各自获得自己的脚本。它是 ACP 与 headless 快照套件以及 Web 浏览器 e2e 流水线的模型来源。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包让无密钥测试拥有带固定模型 transcript 的真实 agent：把它挂载到真实 LLM 适配器的位置，指向已记录的 fixture，然后就像模型真的产生了已记录输出那样运行场景。

### 挂载它

配置 `providers` 后，插件会注册仅用于回放的适配器，其模型目录可供测试模型发现功能的场景使用；未配置 `providers` 时，它安装无需模型发现功能的测试所用的 catch-all `llm/stream` waterfall（瀑布式事件）：

```yaml
- id: llm-replay
  name: '@deepseek-ai/dsh-llm-replay'
  config:
    providers:
      - id: deepseek-official
        name: DeepSeek
        retryPolicy:
          mode: normal
          backoff:
            initialDelayMs: 1
            maxDelayMs: 1
            jitterRatio: 0
        models:
          - id: deepseek-v4-flash
            contextWindow: 128000
          - id: deepseek-v4-pro
  # file/overrideFile/childFiles default to $DSH_SNAPSHOT_FILE /
  # $DSH_SNAPSHOT_OVERRIDE / $DSH_SNAPSHOT_CHILD_FILES, set by the snapshot
  # harness per scenario.
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `file` | `$DSH_SNAPSHOT_FILE` | 主（父）`session.jsonl` fixture 的路径；必需（配置或 env） |
| `overrideFile` | `$DSH_SNAPSHOT_OVERRIDE` | 主会话的可选 `ReplayOverrideDoc` 伴随文件 |
| `childFiles` | `$DSH_SNAPSHOT_CHILD_FILES` | 嵌套场景中已记录的 subagent 子会话日志 |
| `providers` | 无 | 可选的仅回放提供方与模型目录；模型可声明 `contextWindow`、文本／图片模态，以及图片模型使用的正整数 `imageRequestTokens`；非法值会在加载时失败，路由绝不执行提供方 I/O |
| `paceMs` | 无（突发） | 可选的每分片延迟（毫秒），用于真正的增量投递 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-replay)是每个受支持字段及其 JSDoc 的穷尽式真源。

### fixture 的工作方式

fixture 是运行一次真实 agent 所产生的持久化会话日志（`<scenario>/session.jsonl`）的投影——本插件不录制。它保留 header 与每个事件 payload，但省略正文的 `seq`/`time` envelope（打包行使用 `seq0`/`time0`）；回放在解析时恢复连续的 synthetic envelope，且同一文件不能混用投影正文行与完整正文行。运行时持久化仍写入完整日志。回放从 `assistant/chunk` 事件派生每次模型调用的分片序列，因此已记录 fixture 会回放与在线模型产生的相同逻辑流。fixture 的 `request/header` 内容可能被标记化为 `{{system}}`/`{{tools}}`；回放不受影响，因为派生只读取分片与摘要事件以及第 0 行的会话 header。

### 嵌套 agent

父 agent 委托给进程内 subagent 的场景会按会话记录日志：父会话使用 `session.jsonl`，每个子会话各使用一个（`session.1.jsonl` 等）。实时会话 id 每次运行都会重新随机生成，因此回放按首次调用顺序把每个实时会话绑定到已记录脚本：第一个发起模型调用的实时会话取得第一个脚本，下一个新会话取得下一个，依此类推，每个会话分别推进自己的游标。不同实时会话数量超过已记录脚本数时会明确报错。

### 失败模式与覆盖

当回放在带有 `ctx.deepseekLlmApiExtensions` 的组合中服务 `deepseek-official` 时，它会在选择有效脚本条目后、产生首个分片前准备并接受这些字段。这与实时适配器的 2xx 后提交点一致，因此持久接受水位与 SDK 事件通知在录制和回放中行为相同。回放提供合成 `{ messages: [] }` 基础 body：它证明接受副作用，而非准备后的字段字节。

有两种失败模式无法仅根据 `assistant/chunk` 重建：在产生任何分片前直接抛出（例如 HTTP 401，此时日志只有 `turn/end {error}`），以及取消或挂起。需要这些行为的场景可提供可选伴随文件（`<scenario>/replay.override.json`）：它用裸 `ReplayEntry[]` 替换派生脚本，或用 `{ patches: [{ at, entry }] }` 增补——保留所有派生调用，只替换指定的从 0 开始计数的调用索引；当 `at` 等于派生长度时，则在注入瞬态异常后的重试位置追加。有前缀分片的 `throw` 条目会接受 DeepSeek 请求扩展；零分片 throw 默认表示 2xx 前未接受，也可设 `accepted: true` 表示 2xx 后无分片失败。`hang` 条目可以指定 `readyFile`，回放在等待取消前写入它，使外部 driver 可以确定性取消。

### 可能出什么问题

- **fixture 未被完全消费**——在测试中直接安装回放时调用 `assertConsumed()`，它会把场景静默驱动的模型调用少于记录数转换为明确诊断。
- **未记录的会话发起调用**——回放会明确报错，并提示你重新录制场景。
- **脚本占位符匹配不到内容**——`{{fromRequest:<regex>}}` 解析会校验模式与请求语料，匹配不到、模式非法或占位符未闭合都会明确报错。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释回放插件的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计

回放建立在一个想法之上：投影后的会话日志就是 fixture。`deriveReplayScript` 解析 JSONL header（用于 `id`/`createdAt` 排序事实），并按 `(turn, step)` 键在每次 `finish` 分片处切分 `assistant/chunk` 事件，使每次已记录的 `stream()` 调用成为一条 `chunks` 条目；没有 `finish` 分片的 assistant 分组是 `stream()` 抛出异常的指纹，必须通过 override 伴随文件表达。携带 `llmStreamCall: true` 与完整 `rawOutput` 的 `compaction/summary` 会在该事件位置回放为一条规范成功流。脚本字符串可以内嵌 `{{fromRequest:<regex>}}`；流式输出时每个占位符针对实时请求的字符串叶子解析，取该模式的最后一次匹配，用其第一个捕获组（无捕获组时用整个匹配）原位替换。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 类型、fixture 派生、override 校验、占位符解析、会话绑定、`installLlmReplay` 与插件导出 |
| — | 不发布运行时不变式伴生入口；流语法由 LLM 伴生插件与派生测试检验。 |

### 绑定与流式流程

`installLlmReplay` 加载有序脚本，然后安装路由回放适配器（`providers` 非空时）或 catch-all `llm/stream` waterfall 监听器。每次实时 `stream()` 调用以其调用会话 id 为键：新会话认领下一个未认领脚本（父会话在前，因为它必须先开始流式输出才能委托），没有 `sessionId` 的调用共享一个绑定主脚本的匿名会话。返回的 `ReplayHandle` 携带用于 HMR（热模块替换）安全的 disposer，以及 `assertConsumed()`——除非每个已记录脚本都绑定到实时会话且每个已绑定游标都已耗尽，否则它会抛出异常。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从回放适配器逐步进入录制 fixture 的 harness 与消费流的 loop。

- [session-snapshot](../session-snapshot/README.zh.md)——录制 fixture 并驱动回放、录制与刷新模式的快照支持。
- [LLM 包](../../llm/llm/README.zh.md)——回放实现的提供方流约定与适配器注册表。
- [测试策略](../../../docs/testing.zh.md)——无密钥快照层及其适用时机。
- [test-support 组地图](../README.zh.md)——兄弟 harness 与支持包。

-----

<a id="model-experience"></a>
## 模型体验

无。该无密钥测试适配器不向提供方模型发送请求，只将已记录 assistant 分片回放到测试 loop 中。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明何时回放无法代替在线模型。它们是当前包约束，不是任务积压。

- **首次调用顺序脚本绑定假设串行委托**——并发运行同级 subagent 的实现会非确定性地将实时会话绑定到已记录脚本；在这种场景出现前暂不实现更强的键控。
- **只有普通 loop 分片与带标记的本地压缩输出才能派生**——在产生分片前直接抛出、取消/挂起，或未标记的外部摘要器调用场景需要 `replay.override.json` 伴随文件；替换与补丁两种形式都只影响主会话，子会话脚本仍从各自日志派生。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
