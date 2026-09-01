---
description: "本次运行环境的不可变快照，记住每个值来自哪一层；供必须以不信任压平 process.env 的方式解析面向用户值的包使用。"
kind: "package-library"
---

# @deepseek-ai/dsh-launch-environment

[English](README.md) | 中文

## 概述

`dsh-launch-environment` 在启动时把本次运行的环境冻结为一份不可变快照，并记录每个值来自哪一层。解析一个名字会按可信度从高到低搜索各层——继承的进程环境、调用目录的 `.env`、然后是 Harness 主目录的 `.env`——因此胜出的值总是携带其来源。调用方也可以只从命名的层子集中解析，这是拒绝而非降级：无论之后信任顺序如何变化，被省略的层都不可达。这些值仍会进入 `process.env` 供配置表达式与第三方库使用，但 harness 解析任何内容都不把那份压平视图当作依据。它是一个零依赖库，由产品包直接导入；`cordis.yml` 无法加载它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当各层并非同等可信时，通过快照而非 `process.env` 解析面向用户的值——例如调用方绝不能从项目目录取得的凭据覆盖值。

### 解析一个值

```ts
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

declare const ctx: import('@deepseek-ai/cordis').Context
const endpoint = launchEnvironmentOf(ctx).get('DEEPSEEK_BASE_URL')?.value
```

`get(name)` 按可信度从高到低搜索所有层。`getFrom(name, sources)` 只搜索指定的层，不改变这一可信顺序——绝不能接受某一层的调用方不把它列进去，因此后续任何重新排序都无法让它回来。

### 各层的优先级

| 层 | 它是什么 |
|---|---|
| 继承的进程环境 | 启动 shell、CI 任务或容器传入的内容——本次运行的明确意图 |
| `<invocation cwd>/.env` | harness 被启动于其中的项目；产品信任它配置自己的 agent（智能体） |
| `$DSH_HOME/.env` | 用户自己的机器级默认值 |

变量名按平台自身的规则匹配：POSIX 上精确匹配，Windows 上不区分大小写。在 Windows 上做大小写敏感的查找会选错层——shell 里的 `deepseek_api_key` 与项目 `.env` 里的 `DEEPSEEK_API_KEY` 对操作系统而言是同一个变量。

### 没有启动器引导这棵树时

当产品 CLI 引导了这棵树时，`launchEnvironmentOf(ctx)` 返回启动器的快照；否则返回只含继承环境的那一层。该回退并不削弱规则：SDK 宿主或裸 `cordis.yml` 从未发现过任何文件，因此它拥有的一切就是它被启动时的环境。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

快照建立在一个分离之上：启动器决定存在哪些文件，快照决定值如何排序。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `createLaunchEnvironmentSnapshot`、`launchEnvironmentOf` 与 `ctx.launchEnvironment` 槽位 |
| — | 不发布运行时不变式伴生入口；快照在任何 fiber 启动前即已冻结。 |

### 快照如何保持冻结

`createLaunchEnvironmentSnapshot` 在构造时复制每一层的值，因此之后对源对象的修改无法改变快照。无论构造顺序如何，查找都按规范信任顺序进行；在 Windows 上，名字在存储前折叠为大写，因此大小写变体无法拆分优先级。

### 省略意味着什么

`getFrom` 按规范顺序过滤，绝不按调用方列表的顺序。省略一层就是拒绝：该值在该调用中不可达，这正是调用方在某个决策绝不能被某层影响时使用的机制。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要构建快照的启动器或通过快照解析的消费方时，阅读以下页面。

- [boot 包](../../boot/app-boot/README.zh.md)——在任何配置项挂载之前填充 `ctx.launchEnvironment` 的启动器。
- [凭据存储](../../credentials/credentials-local/README.zh.md)——针对快照各层解析已存储的凭据。
- [DeepSeek 提供方](../../llm/llm-deepseek/README.zh.md)——通过启动环境读取提供方配置。

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明快照何时不是安全边界。它们是当前包约束，不是任务积压。

- **快照不是子进程边界**——每一层同样会被物化进 `process.env`，因此项目里的普通变量会按 [`dsh-subprocess`](../../subprocess/subprocess/README.zh.md) 的清洗规则抵达子进程；产品启动器的 [`.env` 约定](../../boot/app-boot/README.zh.md) 会在物化之前拒绝 bootstrap 变量。
- **没有按工作区划分的层**——项目层是调用目录，在启动时固定；之后在 Web UI 中选择的工作区不贡献任何内容，这是刻意的，因为跟随它等于让模型自己的工作区在会话中途改变 harness 环境。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
