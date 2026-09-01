---
description: "供 Host 和浏览器包使用的环形双端队列，提供摊销常数时间的队列操作、已移除条目的即时释放和有界空闲存储。"
kind: "package-library"
---

# @deepseek-ai/dsh-deque

[English](README.md) | 中文

## 概述

`dsh-deque` 让 Host 和浏览器包可以排空长期存在的进程内队列，而无需在每次移除后移动所有剩余条目。调用方可以追加或前插条目，并以摊销常数时间从前端移除。双端队列负责条目顺序和后备存储释放；唤醒、失败、取消、容量和过载行为仍由各消费方负责。

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

### 何时使用

当条目可能在异步工作期间持续积累，且消费方需要 FIFO 移除、可选前插或显式清空队列时，使用 `Deque<T>`。如果有限本地工作列表的最大规模使头部移除成本无关紧要，它可以继续使用数组。

### 入口

导入双端队列，在尾部追加条目；当条目类型可能包含 `undefined` 时，在移除前检查 `size`：

```ts
import { Deque } from '@deepseek-ai/dsh-deque'

const frames = new Deque<string>()
frames.pushBack('first')
frames.pushFront('before-first')

while (frames.size > 0) {
  console.log(frames.popFront())
}
```

这些方法不施加队列限制，也不转换消费方失败。准确的 TypeScript 约定见 [`src/index.ts`](src/index.ts)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

双端队列把条目存入环形数组。移除条目会立即清空对应槽位；按几何级数扩容并在四分之一满时缩容，使复制工作保持摊销常数时间，并防止头游标保留持续增长的空闲存储。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 环形双端队列操作与后备存储生命周期 |
| — | 不发布运行时不变量伴生入口；这个集合不拥有事件流或共享可变状态，其顺序与存储生命周期由单元测试覆盖。 |
| [`tests/deque.spec.ts`](tests/deque.spec.ts) | FIFO、前插、环绕、扩容、压缩、清空和复用覆盖 |
| [`benchmarks/drain.ts`](benchmarks/drain.ts) | 随队列规模增长的可复现 backlog 排空计时 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包映射](../README.zh.md)——跨包组共享的其他零依赖原语。
- [线性流队列决策](../../../.agents/notes/implemented/bug-fix/2026-08-28-linear-stream-queue-drain.zh.md)——生产流为何使用本双端队列而非数组头部移除。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这个进程内集合不注册任何面向模型的内容。

#### KV 缓存影响

这里的内容不会进入模型请求，因此不影响提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有容量策略**——双端队列不会限制、合并或拒绝条目；每个消费方必须定义适合其流的过载行为。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
