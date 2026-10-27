---
description: "通过一个提供方无关的服务注册代码托管提供方并轮询变更请求状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge

[English](README.md) | 中文

## 概述

读取并操作 pull request 与 merge request，而不把消费方绑定到某一个代码托管平台。提供方把远端 URL 和变更请求（change request，即 pull request 或 merge request）URL 映射为提供方无关的引用，按 head 分支查找变更请求，批量读取其状态，读取其 diff 与文件，并按请求把草稿标记为可评审或合并变更请求。同一变更请求的所有监听方共享一个轮询循环，轮询节奏随检查、可合并性与生命周期状态变化。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将注册表与至少一个提供方包一起挂载，例如 GitHub 提供方。

```yaml
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-experimental-forge-github'
```

`ctx.forge.register(provider)` 是调用方 fiber 上的 effect，返回异步 disposer，取消并等待该次注册的调用结束。取消后到达的结果会被丢弃。一个提供方服务一个 forge 家族；为同一家族注册第二个提供方会抛错。注册变化会发出 `forge/providers-changed`；注册提供方会立即轮询其已有监听。`repositoryFromRemote(url)` 与 `changeRequestFromUrl(url)` 按注册顺序询问提供方并返回第一个匹配结果。`changeRequestUrl(ref)`、`findByHead(repository, branch, signal)` 与 `readiness(repository, signal)` 委托给引用所属 forge 的提供方，没有注册提供方时抛错；`readiness` 报告提供方能否用当前凭据访问该主机。

`markReady(ref, signal)` 把草稿标记为可评审；`merge(ref, { method, headSha }, signal)` 只在 head 仍是 `headSha` 时合并变更请求。两者都委托给引用所属 forge 的提供方，没有注册提供方时抛错；主机接受时 resolve 为 undefined，否则为 `ForgeActionFailure`：`unauthenticated`、head 已越过 `headSha` 时的 `stale`，或带主机原因的 `failed`。两者结束后，被监听的变更请求会立即重新轮询。快照带有 `mergeReady`（主机现在是否会为已登录用户合并该变更请求）与 `mergeMethods`（仓库接受的合并方式，该用户常用的方式排在最前）。

`diff(ref, signal)` 读取托管平台计算出的变更请求统一补丁，路径带 `a/` 与 `b/` 前缀；`fileText(ref, commit, path, signal)` 读取其仓库中某个提交下的一个文件。两者都委托给引用所属 forge 的提供方，没有注册提供方时抛错，resolve 为文本或 `ForgeFailure`；托管平台或提供方因结果超过其大小上限而拒绝时，失败为 `too-large`。`fileUrl(ref, commit, path)` 返回该文件在该提交下的网页地址。

`ctx.forge.watch(ref, listener)` 同样是 effect。变更请求的第一个监听方会立即触发轮询；`latest(ref)` 返回最近一次结果。每个 forge 同时最多只有一次读取在进行，这次读取包含该 forge 所有到期的变更请求。打开状态的变更请求在检查未完成或可合并性未知时每 `activeIntervalMs` 轮询一次，否则每 `idleIntervalMs` 轮询一次。已关闭的变更请求按 `idleIntervalMs` 轮询以检测重新打开；已合并的停止自动轮询。`refresh(ref)` 立即轮询一个被监听的变更请求，已结束的也包括在内；该 forge 已有读取在进行时，等待其结束后立即再读一次。读取失败后，重试间隔为 `activeIntervalMs` 按连续失败次数翻倍，最长 `maxBackoffMs`；该值必须大于或等于 `activeIntervalMs`。注销提供方会让其被监听的变更请求以 `unavailable` 结束。最后一个监听方离开后轮询停止。默认值见[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-forge)。

达到 `fetchTimeoutMs` 时，读取信号会以 `FORGE_FETCH_TIMEOUT` 中止。提供方必须在信号中止时停止工作并结束请求；被拒绝的读取会转为 `unavailable` 失败。忽略取消的提供方可能阻塞轮询和服务销毁。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

一个定时器覆盖所有被监听的变更请求。定时器触发时，服务按 forge 对到期的变更请求分组，并为每个空闲的 forge 发起一次批量读取。抛错的监听方会被记录日志并跳过。销毁服务会中止进行中的读取，并等待它们结束。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 提供方注册、URL 映射、监听生命周期与批量轮询 |
| [`src/schedule.ts`](src/schedule.ts) | 计算单个变更请求距下次轮询的延迟 |
| [`src/keys.ts`](src/keys.ts) | 变更请求不区分大小写的规范标识 |
| [`src/types.ts`](src/types.ts) | 仓库、变更请求、状态与提供方类型 |

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Forge 子系统](../../../docs/subsystems/forge.zh.md)——提供方契约、变更请求类型与服务参考。
- [GitHub 提供方](../forge-github/README.zh.md)——服务 GitHub 主机的提供方。
- [Session 绑定](../forge-session/README.zh.md)——把变更请求绑定到 Session 的消费方。
- [绑定决策](../../../.agents/notes/implemented/feature/2026-10-09-session-change-request-bindings.zh.md)——为何绑定从 shell 结果派生、状态只留在宿主侧。

-----

<a id="model-experience"></a>
## 模型体验

无：提供方与监听方只交换代码托管平台的状态，不贡献模型上下文。

#### KV Cache 影响

无。任何模型请求都不包含本包的数据。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **仅轮询**——状态在下一次计划轮询或 `refresh` 时才送达监听方；没有 webhook 接入。
- **结果只在进程内**——最近结果保存在内存中，重启后丢失；下一个监听方会重新轮询。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
