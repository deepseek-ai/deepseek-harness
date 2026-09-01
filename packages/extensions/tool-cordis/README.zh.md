---
description: "面向 agent 与维护者的 Cordis 运行时工具说明，用于选择、组合或排查动态包工作流。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-cordis

[English](README.md) | 中文

## 概述

`dsh-tool-cordis` 给模型提供七个作用于当前 DSH 进程实时 Cordis 运行时的工具：检查已加载的内容与动态包可用之物，定义包含 host 半、浏览器半或两者的包，运行它、停止它并移除它。包带版本——插件持有若干不可变的包版本，模型在失败后可以追加修正版并更新过去。定义只存在于进程内存中，DSH 重启即消失；本包不写仓库文件、不安装任何包、不改 `cordis.yml`。它还增加一个教这套工作流的系统提示词章节；把它与 `@deepseek-ai/dsh-cordis-host-runner` 一同组合，后者负责沙箱与运行往返。

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

当某个会话应当能临时扩展它自己的运行时——例如一个对当前工作有用、但不应成为仓库插件的模型编写的工具、服务或浏览器 UI——挂载本插件。请与 host runner 一同组合；没有 runner，这些工具永远不会激活，而且任何已发布的 bundle 都不会挂载这套工具集（web profile 已挂载 host runner 与浏览器侧组件），所以要显式地添加工具行。

### 最小组合

```yaml
- name: '@deepseek-ai/dsh-cordis-host-runner'
  config:
    vmTimeoutMs: 5000
- name: '@deepseek-ai/dsh-tool-cordis'
```

CLI 示例 [`apps/cli/config/examples/cordis/cordis.yml`](../../../apps/cli/config/examples/cordis/cordis.yml) 同时组合了这两者。带浏览器半的包还额外需要客户端组合里的浏览器 runner 与 UI 包；纯 host 包则两者都不需要。

### 工具能做什么

三个检查工具只读；四个生命周期工具定义并管理包。所有结果都是渲染成文本的 JSON。

- `cordis_inspect_list`——列出 Inspect Provider（host 与 client）及其查询方法。
- `cordis_inspect_query`——执行一次 provider 查询：精确的服务方法、事件分发模式、builtin 签名、工具 schema、主题 token 或实时 slot 树。
- `cordis_inspect_self`——本会话的动态插件：版本指针、最近一次运行，以及（对某个精确包而言）源码与运行时诊断。
- `cordis_define`——登记一个包：新插件（`plugin.kind: "new"`，配 3–6 个字母的 `idPrefix`），或既有插件的新版本（`plugin.kind: "existing"`，配其 `pluginId`）。它只校验参数与语法；不运行任何东西，也不请求审批。
- `cordis_run`——激活一个包（首次激活或重启用 `mode: "run"`，切换版本用 `mode: "update"`）。带浏览器半的包可能先返回 `awaiting-approval`，直到有人允许；工具从不等待最终结果。
- `cordis_stop`——停止当前运行并取消任何待审批请求，保留插件与全部包版本。
- `cordis_undefine`——停止并彻底移除一个插件及其全部包。

### 典型工作流

先检查、再定义、后运行：`cordis_inspect_query` 读取包要用的服务或 slot 的精确约定，`cordis_define` 记录源码（会话里会出现一张 define 卡片，指向存放运行控件的面板），`cordis_run` 激活它。当用户输入 `@pluginId` 时，本包注入一条上下文消息，钉住所引用的插件、其基准包与更新路径。技术性失败之后，用 `cordis_inspect_self` 读取诊断，向同一插件追加修正版，再更新过去。

### 需要规划的边界

定义以会话为界、以进程为本：包只在定义它的会话里可见可控，可跨后续轮次保持活跃，运行时也可能影响同一进程中的其他会话。停止、移除、卸载工具集或重启 DSH 都会清除它。沙箱隔离全局变量，但不是安全边界——对待动态包要像对待 bash 访问一样，加载本插件时也要像授予 bash 工具那样慎重。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

工具集建立在一个分离之上：工具是 runner 服务之上薄薄的一层模型面向层。检查数据来自生成的目录与实时服务存储的交集；定义与生命周期动词委托给 `ctx.dynamicCordisRunner`，它拥有注册表、vm 沙箱与浏览器往返。工具负责模型面向的判断：只展示可调用的方法、只点名 host 半够得到的键，并且每次拒绝都是模型可以直接行动的教学错误。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具注册、系统提示词章节、`@pluginId` 上下文注入 |
| [`src/inspect.ts`](src/inspect.ts) | 报告渲染：把生成的 API 目录与实时服务存储相交 |
| [`src/api-catalog.ts`](src/api-catalog.ts) | 工作区 Cordis 声明的生成投影（由 `pnpm run gen-cordis-api` 重新生成，`verify-cordis-api` 守其新鲜度） |
| [`src/prompt.ts`](src/prompt.ts) | `tool:cordis` 系统提示词章节 |
| [`src/providers.ts`](src/providers.ts) | 第一方 host Inspect Provider：Service、Event、Builtin、Tool |
| [`src/present.ts`](src/present.ts) | 可回放的通用卡片渲染意图 |

### 一次调用的流程

检查调用查询 `ctx.cordisInspect`：host provider 本地执行，client provider 等待第一个有效的页面应答。define 用与沙箱相同的包装器编译每一半来做语法预检，因此无法解析的代码在拿到 id 之前就被拒绝。run 委托给 runner：纯 host 包在进程内激活，带浏览器半的包挂起在 `cordis/request-run` 往返上；工具返回 runner 的回执（`awaiting-approval`、`starting` 或 `running`）。当用户写下 `@pluginId` 时，一个 `agent/pre-step` 处理器读取引用，并注入一条 user 角色的上下文消息，点明基准包与必须的后续步骤。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享工具集逐步进入 runner 内部、生成 schema 与子系统表面。

- [Host runner](../cordis-host-runner/README.zh.md)——这些工具委托的注册表、沙箱与运行往返。
- [Client runner](../cordis-client-runner/README.zh.md)——应答运行请求并装载浏览器半代码的浏览器半。
- [UI 包](../ui-cordis/README.zh.md)——用户操作定义所用的面板与工具卡片。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-cordis)——模型收到的确切 schema。
- [extensions 子系统](../../../docs/subsystems/extensions.zh.md)——生成的 `ctx.cordisInspect` 与 `ctx.dynamicCordisRunner` API。
- [自引用 Cordis 工具集 Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.zh.md)——设计居所：沙箱语义、动态包生命周期与组合。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

该插件可见时，会话模型会看到生成的 [`cordis_inspect_list`、`cordis_inspect_query`、`cordis_inspect_self`、`cordis_define`、`cordis_run`、`cordis_stop` 和 `cordis_undefine` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-cordis)。

#### Token 影响

该工具视图中的每次请求承担固定 schema 成本。

#### KV Cache 影响

只要该工具视图不变，前缀就保持稳定。隐藏这些定义的 scope 或插件生命周期变更，可能使从第一个变化的 schema token 起的复用失效。

### 系统提示词章节

#### 模型看到的内容

本包注册一个系统提示词章节（`tool:cordis`，order 115），教模型何时以及如何使用动态包工作流、推荐的工具顺序与必须避免的高频错误；完整文本在 [`src/prompt.ts`](src/prompt.ts) 中。章节开头如下：

##### 章节开头

```markdown
# Dynamic Cordis Plugins

Dynamic Cordis plugins temporarily extend the current DSH process. A Plugin uses apply(ctx) to consume Services, listen to Events, provide Services, register model Tools, or register browser UI in Slots.
```

#### Token 影响

该插件可见时，章节渲染出的文本会在每次请求中重复。

#### KV Cache 影响

只要章节文本与顺序不变，前缀就保持稳定；编辑提示词或改变其顺序可能使从第一个变化 token 起的复用失效。

### 工具调用历史与结果

#### 模型看到的内容

检查输出是渲染成文本的 JSON：`cordis_inspect_list` 返回 provider 目录，`cordis_inspect_query` 返回查询数据，`cordis_inspect_self` 返回插件、版本与包摘要，并在指定精确包时给出源码与诊断。define 回答该包已定义、尚未运行，并给出用于运行的 id。run 报告 `awaiting-approval`、`starting` 或 `running`，附运行 id 与版本指针。stop 与 undefine 各以一行确认。每一次拒绝都是携带 runner 教学文本的工具错误，提交的程序保留在 assistant 工具调用历史中。

#### Token 影响

检查输出与提交的包代码取决于数据，并在压缩（compaction）前重复发送；生命周期确认文本很短。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### cordis_run 之后的后续请求

#### 模型看到的内容

运行中的包可能注册工具、提示词贡献或监听器，改变其目标 scope 的后续请求；`cordis_stop` 与 `cordis_undefine` 会在完全停稳后移除这些贡献。当用户输入 `@pluginId` 时，注入的引用上下文还会增加一条 user 角色的消息，点明基准包与后续步骤。

#### Token 影响

间接 token 影响等于运行中包的贡献，且只在其进程内生命周期内持续。

#### KV Cache 影响

运行或停止提示词／工具贡献会改变后续请求前缀，并可能使从第一个变化的贡献起的复用失效；运行集合不变时，前缀保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明工具集何时不合适或需要特别小心。它们是当前包约束，不是任务积压。

- **沙箱只用于约束诚实代码，并非安全边界**——可以触及沙箱全局变量上的 host realm helper，因此包代码可以触达 Node；加载本插件时，应当像授予 bash 工具一样慎重。
- **只支持纯 JavaScript**——动态包代码不做任何转换：没有 TypeScript、JSX 或 import，沙箱还扣下 `require`、`setTimeout`、`fetch` 等 Node 全局，把文件、网络与进程工作重定向到 Cordis 服务。
- **vm 与审批边界属于 runner**——见它的[已知限制](../cordis-host-runner/README.zh.md#known-limitations-and-deferred-work)；async 的 host 半主体可逃出 `vmTimeoutMs`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这个模型侧 adapter 没有独立 lifecycle stream；执行关系由它调用的 capability seam 负责。
