---
description: "面向组合或调试 turnOutline 投影单元的客户端与维护者的全量轮次大纲说明，支撑整会话轮次导航。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-turn-outline

[English](README.md) | 中文

## 概述

`dsh-session-turn-outline` 以 `turnOutline` 投影单元提供全日志的轮次大纲——每个已开始的轮次连同其 `turn/start` seq 以及有界的提示词与最终回复预览。按窗口分页历史的客户端读取大纲即可提供会话的每一轮（无论是否已加载），并把向后分页精确定位到能载入某轮事件的 seq。在已挂载投影注册表的组合中选择它，例如以聊天轮次导航栏为参考消费者的 Web 应用包；没有注册表的装配不受影响，其消费者回退到仅按已加载窗口导航。用法与条目语义在前；折叠内部细节放在下方可折叠的开发者章节中。

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

当客户端需要在不持有完整事件日志的情况下导航会话的每一轮时，在会话存储与投影注册表旁挂载此插件。只有存在注册表时单元才会注册。

### 组合

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-session-turn-outline'
```

### 各字段含义

| 字段 | 含义 |
|---|---|
| `turn` | `turn/start` 载荷里的宿主分配轮次号 |
| `seq` | 该轮 `turn/start` 事件的 seq——窗口向后分页越过此 seq 即载入整轮 |
| `prompt` | 该轮首条人类提示词的预览（文本块以空格连接、空白折叠、50 字符封顶且截断时补省略号——即导航卡片一行）；合格提示词落日志前为 `''` |
| `response` | 该轮最后一条带文本的助手消息的预览（同样的归一化、120 字符封顶——即卡片至多三行）；轮次带着助手文本结束前为 `''` |

wire 值是按 `turn` 严格递增的完整条目数组（整值规则）：消费者整体替换，从不合并。提示词只从带人类 `user` 来源的 `user/message` 事件填充，注入的上下文与工具结果绝不进入导航；纯图片提示词的轮次保持 `''`，消费者按轮次号标注。回复在轮次流式期间缓冲为草稿、在 `turn/end` 落定；变更流的原始视图身份门让纯草稿变化保持安静，因此大纲每轮至多推送三次——开轮、提示词、落定回复。预览预算与聊天导航栏已加载轮次的预览一致，同一轮在事件载入前后显示相同的文字。

### 失败与恢复

没有投影注册表时单元是惰性的：`inject` 使 fiber 保持挂起，不注册任何内容，因此其他装配缺少 `turnOutline` 键。卸载插件会移除该键，因为注册是挂载 fiber 上的 effect。持久缓存行在恢复时经受 schema 校验——包括轮次严格递增的顺序——损坏的行被丢弃而不会喂坏折叠。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释大纲背后的折叠；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该单元是对已提交会话事件的纯折叠。锚定每个条目的是 `turn/start` 而非提示词 `user/message`，因为它的 seq 就是跳转的载入目标：agent loop 先记 `turn/start` 再记该轮的提示词与步骤，窗口向后分页越过该 seq 即包含整轮。提示词由首条人类 `user/message` 填充，且仅当最新条目仍为空时——同一轮内后续的人类消息（steering）保留首个预览。回复无法同样填充（`turn/end` 不带文本），所以每条带文本的 `assistant/message` 覆写状态里的草稿，`turn/end` 提交幸存者——最新的文本，与已加载导航栏 `findLast` 的语义一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`inject`、在挂载 fiber 上注册单元 |
| [`src/projection.ts`](src/projection.ts) | 折叠：条目追加、预览填充、wire 视图 |
| [`src/types.ts`](src/types.ts) | `turnOutline` 投影键声明与条目类型的唯一归属 |
| — | 不发布运行时不变式伴生入口：本包仅拥有一个纯投影折叠，`session-projection` 会对其对外值执行 schema 校验；用同一实现重新折叠同一日志只会复制实现，无法比较独立维护的观测，而轮次边界顺序由 session 与 agent-loop 负责。 |

### 折叠规则

- 不相关事件返回同一状态引用，纯草稿变化保持 `turns` 数组身份不变；注册表的两道 `Object.is` 门由此把变更流压到每轮至多三次推送。
- 未推进轮次号的 `turn/start` 被跳过，保持大纲有序；重试边界的预览随后落在既有条目上。
- wire 视图投影 `state.turns`；持久缓存的状态 schema 在 wire schema 外再包一个草稿字段。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当单元约定不够用时阅读以下页面。它们从驱动单元的注册表逐步进入相邻的会话包。

- [会话投影子系统](../../../docs/subsystems/session-projection.zh.md)——驱动单元并提供快照与变更流值的注册表。
- [会话投影注册表包](../session-projection/README.zh.md)——单元注册所依据的注册表约定。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 turnOutline 单元把已写入日志的轮次边界折叠成面向客户端的读模型，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明大纲描述什么、单元何时缺失。它们是当前包约束。

- **wire 值随会话增长**——每次推送携带完整大纲（整值规则），全中文预算下每轮上限约 600 字节、通常远小于此；把预览拆成按需读取推迟到数千轮量级的会话真正需要时。
- **回复只预览已落定的轮次**——它在 `turn/end` 提交，进行中的轮次（或从未记下结束边界的轮次）在边界落地前只有提示词预览。
- **没有合格文本的轮次保持 `''`**——纯图片、纯命令的轮次可导航但按轮次号标注，步骤全程不产文本的轮次没有回复预览。
- **仅在组合了投影注册表时挂载**——其他装配不提供 `turnOutline` 键，其消费者回退到仅按已加载窗口导航。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
