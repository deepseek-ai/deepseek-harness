---
description: "面向用户与维护者的日志支持型会话标题说明，用于选择标题来源、配置服务或排查标题状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title

[English](README.md) | 中文

## 概述

使用 `dsh-session-title` 为每个会话提供客户端可见标题，标题可以来自第一条符合条件的用户消息、可选异步生成器或显式用户重命名。已接受的标题在回放、恢复与分页后仍然存在，但绝不会进入模型输入。自动生成绝不会延迟主 agent（智能体）响应，较新的标题请求会取代旧工作。当客户端需要带可配置长度上限的持久标题，以及通过 `refresh()` 主动重新生成标题的路径时，请选择本包。

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

挂载服务，让会话获得客户端可以显示、且绝不触及模型的标题。常用路径是显式的：加载会话存储、以必填上限挂载服务，并可选挂载一个提供方插件。

### 选择标题来源

标题来自三个来源，最新者胜出。内置回退在配置上限内从第一条符合条件用户消息的开头若干词派生；已注册提供方对符合条件的消息生成标题；显式 `rename()` 接受用户提供的标题。只有人类 `user/message` 事件中的文本块符合条件，空提示词或非文本提示词会等待后续符合条件的输入。用户来源的最新标题会钉住会话——后续用户消息不再安排自动修订，显式 `refresh()` 仍是有意的解钉手段。

### 最小配置

所有上限都是必填项；该库不提供默认值。以三个上限挂载服务：

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-title'
  config:
    fallbackMaxWords: 8
    fallbackMaxBytes: 96
    maxTitleBytes: 120
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `fallbackMaxWords` | 必填 | 确定性回退中以空白分隔的最大词数 |
| `fallbackMaxBytes` | 必填 | 回退允许的最大 UTF-8 字节数；不得超过 `maxTitleBytes` |
| `maxTitleBytes` | 必填 | 接受任何来源标题的最大 UTF-8 字节数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-title)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 添加提供方

可选异步提供方可通过 `ctx.sessionTitle.register(provider)` 注册一个；第二次注册会立即抛出。随附的模型支持提供方是[首消息](../session-title-first-prompt-llm/README.zh.md)与[全消息](../session-title-all-prompts-llm/README.zh.md)，两者都使用共享的 [LLM（大语言模型）生成策略](../session-title-llm/README.zh.md)。提供方只有在带标记、由循环构建的请求的确切路由与已记录 `request/header` 匹配时才启动，较新的修订会取代并中止旧工作。

### 读取标题

`get(session)` 从活跃或回放会话读取折叠出的最新标题，`foldSessionTitle(events)` 是对日志的纯折叠。服务要求 `ctx.sessionProjections` 并注册两个单元：客户端可见的 `title` 单元（供客户端列表行使用的已接受标题字符串）和仅供 host 使用的 `titleInput` 单元——后者折叠第一条与最新一条合格消息及其计数，使调度与回退读取通过 `stateOf()` 达到 O(1)；某次提供方生成所需的完整合格前缀，则会在执行时从会话日志中扫描取得。显式 `refresh(session)` 在需要时物化回退，然后对当前符合条件的消息显式运行已注册提供方。

### 失败与恢复

自动失败会发出警告并保留最新标题；显式 `refresh()` 在提供方错误或调用方取消时拒绝，取消不会回滚已接受的回退事件。自动工作绝不会延迟主 agent 响应，其延迟完成会追加一个独立纯日志事件而不打开轮次，陈旧的完成结果无法追加。fork 出的会话会原样继承种子中的标题事件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释标题设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

标题是持久的、仅写入日志的状态：每个已接受的修订都是 `session/title` 事件，`foldSessionTitle()` 选择最新事件，因此标题像任何其他会话事件一样在回放、恢复与分页中存活。服务拥有调度、取代与接受；提供方负责生成。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务：配置、折叠、回退调度、提供方注册表、并发、`title` 投影单元 |
| [`src/normalize.ts`](src/normalize.ts) | 标题文本清洗、UTF-8 安全截断与确定性回退 |
| [`src/types.ts`](src/types.ts) | `title` 投影键声明的归属位置 |

### 生命周期与并发

每个会话的工作状态维护一个修订计数器、一个进行中的回退，以及待处理与活跃的提供方工作。较新的用户消息、提供方 dispose（资源释放）、会话 dispose 或显式刷新都会通过 `AbortController` 中止旧工作；提供方、修订、会话或信号已陈旧的完成结果无法追加。显式刷新会在提供方工作之前预留修订号；重叠的自动／显式回退请求共享一个会话本地正在进行的追加操作。服务拆卸会取消排队工作，并在卸载完成前等待不响应取消的调用结算。

### 规范化

已接受标题会清除终端控制序列、方向性与不可见控制符以及非空白的 C0/C1 控制符；空白被规范化，按字节上限截断时绝不切断 Unicode 码点。确定性回退在 `fallbackMaxWords` 与 `fallbackMaxBytes` 内取第一条符合条件消息的开头若干词。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当服务约定不够用时阅读以下页面。它们从子系统参考逐步进入在此插拔的模型支持提供方。

- [会话标题子系统](../../../docs/subsystems/session-title.zh.md)——持久标题状态与提供方词汇类型。
- [共享 LLM 标题策略](../session-title-llm/README.zh.md)——两个随附提供方共用的模型生成辅助模块。
- [首消息标题提供方](../session-title-first-prompt-llm/README.zh.md)——根据第一条符合条件的用户消息生成标题。
- [全消息标题提供方](../session-title-all-prompts-llm/README.zh.md)——根据所有符合条件的用户消息生成标题。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

### 会话标题状态

#### 模型看到什么

无。`session/title` 只写入日志，绝不会进入会话接口、`deriveMessages()`、系统提示词、工具 schema 或请求前缀。

#### Token 影响

回退与已接受的提供方修订不会向主 agent 请求增加 token。可选提供方的独立辅助请求由对应提供方包的文档说明。

#### KV Cache 影响

不影响主请求；标题事件不会改变其重建内容或缓存键。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明标题服务不提供什么。它们是当前包约束。

- **没有标题删除、搜索或列表索引**——不经显式 `refresh` 就解钉回自动标题、搜索与列表索引不属于此服务。
- **至多一个提供方**——注册表有意只接受一个实现，因此部署若要组合相互竞争的标题策略，必须编写一个自行负责优先级的提供方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
