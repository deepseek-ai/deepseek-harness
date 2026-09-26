---
description: "面向选择、挂载或排查持久 workspace 记录与会话头校验成员资格的宿主的 Workspace 实体注册表（ctx.workspaceRegistry）说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace

[English](README.md) | 中文

## 概述

使用此包可以维护一个有序、持久的项目目录列表，以及在每个目录中运行的会话。宿主可以构建项目侧边栏、在不删除历史的情况下把会话从分组中隐藏，并在不删除文件夹、文件或会话的情况下移除项目。重新添加已移除的目录会创建一个全新项目，而目录无法校验的会话会保持 Ungrouped。需要持久项目分组的 GUI 或宿主工作流适合使用它；它对模型不可见，不增加提示词或请求上下文成本，但需要会话持久化与存储后端。

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

使用此包为产品提供项目列表：用户工作的命名目录、每个目录中运行的会话、稳定顺序，以及在不丢失会话的前提下将其隐藏或重新取回的能力。每项操作背后的 API 约定放在实现章节中。

### 何时使用

当产品展示持久 workspace 界面——侧边栏、会话分组或需要命名并排序目录的自动化——时使用它。它对模型不可见，因此不增加任何 token 或请求成本。没有分组界面时跳过它；harness 中没有其他包需要它。

### 设置

此包需要会话存储、会话持久化后端，以及保存其记录的存储行。最小组合如下：

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- name: '@deepseek-ai/dsh-workspace'
```

挂载这些行之后，创建项目会立即出现在列表中并在重启后保留；首次启动还会按会话运行的目录对既有会话分组。如果缺少某个必需依赖，workspace 功能会一直不可用，直到它被挂载。

### 创建与排序项目

从任何已存在的绝对目录路径创建项目：`C:\` 等文件系统根目录和普通目录都有效。相对路径、`C:work` 等 Windows 盘符相对路径、不存在的路径和文件都会被拒绝，且不会创建项目；为已有项目的目录再次创建会原样返回现有项目。你可以随时重命名项目，并把它移动到列表中的任意位置：

```text
// Host consumer code, after the composition above is loaded:
const project = await ctx.workspaceRegistry.create('/path/to/dir', 'My Project')
await project.setTitle('Renamed')
ctx.workspaceRegistry.list() // shows the project, newest first
```

<a id="first-use-workspace"></a>
### 首次使用工作区

`initializeDefault(resolveDirectory)` 初始化默认 Workspace，不创建 Session。首次创建要求 Workspace 注册表为空，且不存在运行时、持久化或已归档 Session，包括没有工作目录的 Session。注册表直接检查持久化历史；仅凭可见侧边栏为空不足以判断。

目录解析器仅在允许创建时于变更队列内运行。它返回绝对路径；注册表创建缺失的父目录、规范化路径、重新检查 Session 历史，再一起提交 Workspace 和初始化标记，标题取所请求目录（而非规范路径）的最后一段，因此该路径上的符号链接不会让工作区改用链接目标的名称。已存在的目录直接复用；文件冲突或目录操作失败时拒绝初始化。[Host 控制器](../../api/workspace-controller/README.zh.md#first-use-workspace)提供 Documents 路径策略。

首次成功登记会持久保存工作区身份。重复调用直接返回它，不再解析目录；改名保留该身份，删除登记也不会允许再次自动创建。目录或登记失败时，初始化状态保持未设置，可以重试。后续步骤失败前已创建的目录会保留在磁盘上。目录解析成功后，调用方取消操作不会回滚目录创建或登记。[首次使用决策](../../../.agents/notes/implemented/feature/2026-09-20-default-workspace.zh.md)说明这一生命周期。

### 将会话归入项目

会话加入它运行目录所在的项目：在项目目录中创建会话，它就会出现在该项目下，新到旧排列。一个会话只能属于一个项目。目录无法校验的会话——没有记录目录，或目录被移动、删除——无法加入，保持 Ungrouped。

### 隐藏、恢复会话与移除项目

当会话不应再出现在分组中时隐藏它：它会从可见列表中消失，但其会话、历史与在项目中的位置都保持不变。仍有工作在跑的会话——它自己的回合、运行中的子代理、后台任务或活跃提醒——不会被藏在这些工作之下：注册表会拒绝并列出还在跑的内容；调用方若要求先停止这些工作，注册表会按用户自己的停止操作同样的方式停掉它们，然后再隐藏。当被隐藏的会话应重新出现时恢复它：它会回到其项目下记录的位置；不属于任何项目时则回到 Ungrouped，并从一份正常收尾的日志继续对话。项目不再需要时移除它：它离开列表，而其文件夹、文件与会话历史绝不受影响——这些会话变成 Ungrouped。之后再次添加同一目录会从空项目开始，不会带回旧会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释此功能背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **每个规范路径一条记录。** `fs.realpath` 是唯一的一套唯一性规范：路径以规范化形式存储，因此指向已有记录目录的符号链接会与之冲突，唯一性即规范路径的字符串相等。
- **成员资格是所有权加实时 cwd 事实。** 记录的 `sessionIds` 顺序是所有权真源；启动时的头部索引校验它，`sessionIds` 在读取时过滤，下一次变更会持久化剪除无效项。
- **仅读取头部。** 引导与 attach 校验只读取 `SessionHeader` 字段；事件正文绝不加载。
- **两次写入的变更带显式标记。** 创建与删除在记录/顺序对可能分叉之前先持久化 `pendingMutation` 标记，因此启动只补全被中断的操作，未标记的分叉作为损坏明确报错。
- **串行化写入。** 注册表操作跑在同一条操作链上；实体变更通过领域写链上的 `table.update` 执行，写入 `updatedAt`，并在其所在的链位置决定成员资格。

<a id="api-behavior"></a>
### API 行为

该 API 由两个对象负责：`WorkspaceRegistry` 创建、排序与删除项目，管理会话记账，并置顶、取消置顶、归档或恢复会话；`Workspace` 实体暴露显示标题、目录状态与会话投影。置顶要求会话已知且未归档；归档在同一次持久化写入中清除置顶，恢复会话不会恢复置顶。各方法的精确约定见 [src/index.ts](src/index.ts) 与 [src/entity.ts](src/entity.ts)。

归档准入是本包声明并派发的两个宿主事件之上的能力接缝：`workspace/session-activity`（waterfall）向已组合的提供方询问某会话还有什么在跑，`workspace/session-stop`（parallel）请它们停止这些工作。`archiveSession(sessionId)` 只询问一次活动 waterfall，对非空答案以 `WorkspaceActiveSessionError` 拒绝，其 `activity` 按族列出各项——键由各提供方自己合并进本包留空的 `SessionActivityKindMap`；`archiveSession(sessionId, { stopActivity: true })` 跳过活动检查，先写入归档，再派发停止事件，因此持久化的归档集合已经拦住停止所引发的每一次唤醒；提供方抛错只记日志，归档保留。调用在每个提供方的停止请求都已发出后返回，被停止的工作自行收敛。两种询问都在存在性检查之后进行，对已归档 id 从不发生。随附的提供方是 Agent 注册表（运行中的回合）、任务注册表接缝（所属任务）、Subagent runtime（运行中的子孙）与 Schedule 插件（活跃提醒）；没有提供方的组合可自由归档。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`WorkspaceRegistry` 服务、头部索引、引导、操作串行化 |
| [`src/entity.ts`](src/entity.ts) | 包私有 `Workspace` 实现及其唯一的 `mutate` 写入路径 |
| [`src/spec.ts`](src/spec.ts) | 领域声明：记录 schema、注册表状态、`defineDomain` 规范 |
| [`src/types.ts`](src/types.ts) | 公开 `Workspace` 接口与 `WorkspaceId` 品牌 |
| [`src/paths.ts`](src/paths.ts) | `realpath` 唯一性规范 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：实体缓存镜像持久表 |

### 持久形态

注册表打开 `workspace` 领域（版本 2）：一张以 `WorkspaceId` 为键的 `workspaces` 表，加上一个持有 `workspaceIds`（权威显示顺序）、`archivedSessionIds`、`pinnedSessionIds`、可选的首次使用身份 `defaultWorkspaceId` 与可选 `pendingMutation` 标记的全局状态。归档与置顶集合存储会话 id 字符串，默认值为空，不包含逐项对象或时间戳；置顶数组把最近置顶的 id 放在前面。归档在同一次全局状态写入中清除置顶，但不改变 Workspace 成员关系。取消归档不做会话存在性探测，因为从集合中移除 id 不可能引入未知 id，而归档会在加入前校验会话。

### 生命周期

启动时，注册表打开领域、若存在标记则补全被标记的变更、校验已存状态——重复路径、重复会话记账与顺序漂移都会明确报错——并在尚未初始化时先凭持久化头部引导历史、最后写入已初始化标记，因此被中断的引导可以安全恢复。全新空注册表一旦初始化即成为正式状态，绝不会再次引导。

### 失败与恢复

创建或删除的第二次写入失败时，缓存与先前顺序会回滚；当操作与回滚都失败时，持久标记仍指明被中断的操作，下一次启动会补全或回滚它。已提交的删除即使标记清理失败仍报告成功，下一次启动会幂等地清除该标记。

### 不变式

`workspace-invariant` 伴生插件注册归属关系：`workspaces` 表的每个持久 `domain/changed` 都必须指向实体缓存已持有的记录——只有在注册表从缓存移除实体之后删除才有效，因此绕过注册表的写入路径会触发不变式失败。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当本包的视角不够用时阅读以下页面：子系统参考是权威的功能约定，Agent Note 记录了项目为何从会话历史起步、以及移除为何是非破坏性的。

- [Workspace 子系统](../../../docs/subsystems/workspace.zh.md)——项目及其会话的功能约定，以及 workspace 服务的生成 API。
- [Workspace 包映射](../README.zh.md)——本组唯一的包及其仓库位置。
- [领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)——为什么项目记录使用领域数据形式。
- [Workspace UI 产品流 Agent Note](../../../.agents/notes/archived/feature/2026-07-25-workspace-ui-product-flow.md)——首次启动如何从会话历史构建项目，以及 GUI 如何排序。
- [删除 Workspace 注册记录决策](../../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.zh.md)——为什么移除项目绝不会删除其文件夹或会话。

-----

<a id="model-experience"></a>
## 模型体验

### Workspace 记录与会话记账

#### 模型看到什么

没有。`ctx.workspaceRegistry` 只向宿主侧消费方提供 workspace 记录：此包不注册工具、不注入提示词、不写入会话事件，因此没有请求字段会携带此包数据。

#### Token 影响

每个请求的直接 token 为零。

#### KV Cache 影响

与实时请求无关：此包绝不触及请求前缀，因此不会使提供方缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明项目列表何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **移除绝不删除数据**——移除项目会保留其文件夹、文件与会话历史；这些会话变成 Ungrouped，而会话删除与文件夹移除是彼此独立且尚未提供的功能（参见[决策记录](../../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.zh.md)）。
- **只有带记录目录的会话才能加入**——只有记录中带有可解析为项目路径的目录的会话才属于项目；没有目录的会话保持 Ungrouped，来自其他目录的会话无法移入。
- **外部变更延迟可见**——如果另一进程删除或损坏目录，项目只能在下次刷新或重启后反映出来。
- **归档与取消归档执行不同的会话校验**——恢复只是从归档集合中移除 id，因此会话已不存在的条目仍能取消归档，也不会留下未知引用；对未归档 id 执行恢复不写盘即完成，而 `archiveSession` 会拒绝既非实时也未持久化的会话。
- **活动检查与归档写入不是一个原子步骤**——在提供方作答与持久化写入之间开始的回合会在隐藏状态下运行，`agent/pre-step` 先于该写入的每个模型步连同其工具调用照常执行；API Session Controller 的门禁把写入之后提出的第一步以 `blocked` 收口，因此暴露面以该写入的时延为界，实际上是一个模型步。
- **重新添加目录从空开始**——移除后再次添加同一目录会创建空会话列表的新项目；旧会话不会自动回来。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 开放：`create(path, title?)` 的 title 参数

网关的按名称创建分支移除后，`title` 参数已无生产调用方；代码中的 TODO 提议把该参数与其 `@param` 子句一并移除（参见[笔记](../../../.agents/notes/archived/simplification/2026-07-31-one-route-to-add-a-workspace.md)）。

</details>
