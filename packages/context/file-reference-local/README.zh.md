---
description: "面向用户与维护者的本地工作区 @file 补全提供方，用于启用、设置大小或排查 ctx.fileReferences 的发现能力。"
kind: "package-reference"
---

# @deepseek-ai/dsh-file-reference-local

[English](README.md) | 中文

## 概述

agent（智能体）及其宿主 UI 获得 `@file` mention 的排序路径候选，范围限定在各自 agent 的工作区，并有界以保证大型仓库依然响应迅速。`dsh-file-reference-local` 在本地文件系统上实现 `ctx.fileReferences`：它为每个 agent 维护一个可复用的搜索索引，在工具结果后于后台重建索引，让补全反映工作区变化而不发生停顿，且从不跟随目录符号链接。当指定 agent 可以调用 `read` 时，它还会向系统提示词安装一句稳定指引。当 agent 的 `read` 工具作用于 Harness 宿主文件系统时选择它；远程或虚拟命名空间需要发现能力与工具一致的提供方。

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

当 `@file` 补全应发现 Harness 宿主自身的文件系统——即随附 `read` 工具所操作的命名空间——时，挂载此提供方。每个 agent 的工作区从该会话的工作目录开始建立索引；会话没有工作目录时回退到宿主进程目录。

### 启用提供方

默认设置适合典型工作区，因此最小挂载无需任何配置：

```yaml
- name: '@deepseek-ai/dsh-file-reference-local'
  config:
    maxResults: 20
```

### 你能得到什么

在宿主 UI 中输入 `@` 会为指定 agent 返回至多 `maxResults` 个排序路径候选。包含 `/` 的查询直接列出匹配目录的条目；裸查询对有界递归索引做模糊排序。目录候选以尾斜杠保持 mention 开放。任何工具结果之后，该 agent 的索引会被标记为陈旧：下一次查询仍由它作答，其替代品在后台构建，因此重建不会挡在光标前面。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxResults` | `20` | 单次查询返回的排序候选最大数量 |
| `maxEntries` | `50000` | 每个 agent 工作区建立索引的文件与目录最大数量 |
| `excludedDirectories` | `['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target', '.next', '.nuxt', '.turbo', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle']` | 遍历与候选中排除的目录基名 |

所有数值都必须是正的安全整数，所有排除名都必须是不含 `/` 或 `\` 的非空基名。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方的设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

提供方为每个 agent 维护一个可复用的 `WorkspaceFileSearch`，以该会话的 `cwd` 为根。目录范围查询（`a/b/...`）列出实时目录状态，裸模糊查询共享一次有界递归遍历。只有一个工作区的首次裸查询会等待该遍历；`tool/result` 事件把已完成的条目标记为陈旧，下一次裸查询在替代品构建期间继续由它作答。模型指引是按 agent 的提示词段，仅在指定 agent 拥有 `read` 工具时贡献；agent 释放时会同时释放索引与提示词 fiber。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `LocalFileReferenceService`：配置校验、按 agent 搜索、提示词安装 |
| [`src/search.ts`](src/search.ts) | `WorkspaceFileSearch`：遍历、排序、排除、陈旧标记与后台重建 |
| — | 不发布运行时不变式伴生入口；按 Agent 的 index 是私有 advisory cache，其失效与释放通过 service 测试直接观察。 |

### 主要流程

`list(agent, query, signal)` 要么列出某个目录的条目，要么读取共享的有界索引，对候选排序（精确、前缀、子串，再到子序列得分，目录有加成），并按确定性顺序返回至多 `maxResults` 个。`tool/result` 事件把指定 agent 的索引标记为陈旧，之后的裸查询因此观察到全新目录树。不可读或已排除的子目录不贡献候选，而不可读的根目录则让该次遍历失败：一次瞬时故障不得用空索引覆盖仍然有效的条目。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读以下页面。它们从本提供方所实现的 seam 进入其候选所指向的工具。

- [文件引用 seam](../file-reference/README.zh.md)——本提供方所实现的服务约定与 `@file` 语法。
- [会话引用子系统](../../../docs/subsystems/session-reference.zh.md)——宿主 UI 背后的共享文件引用约定。
- [文件系统工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-fs)——发现能力必须匹配其命名空间的 `read` 工具。
- [context 组地图](../README.zh.md)——相邻的请求上下文包。

-----

<a id="model-experience"></a>
## 模型体验

### `read` 可用时的文件引用指引

#### 模型看到的内容

当指定 agent 有实际生效的 `read` 工具时，提供方会贡献以下稳定的系统提示词段：

##### 文件引用指令

```markdown
Tokens prefixed with @ are workspace paths the user explicitly referenced, relative to the workspace root. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.
```

#### Token 影响

该影响有条件且固定：只要 `read` 对指定 agent 可见，这一句就会存在；候选查询本身不增加 token，所选路径只会贡献普通用户消息中的对应字符。

#### KV Cache 影响

该稳定句子会加入系统提示词前缀。挂载或移除此提供方，或者改变 `read` 是否可见，都会改变该前缀；查询、候选项和索引陈旧标记不会改变前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该提供方何时不合适。它们是当前包约束。

- **宿主本地命名空间**：提供方扫描 Harness 宿主的文件系统，因此远程或虚拟 `read` 实现需要使用命名空间与该工具一致的提供方。
- **有界的提示性索引**：超大型工作区可能省略 `maxEntries` 之后的路径；被排除或无法读取的目录不会出现。默认排除项只列没有任何生态用作源码目录的构建产物；`lib` 被刻意排除在外，因此构建进 `lib` 的工作区需通过 `excludedDirectories` 自行加上。
- **一次失效的陈旧窗口**：紧接工具结果之后的模糊查询反映的是上一次遍历时的目录树；下一次查询才看到重建结果。
- **没有忽略文件语义**：`.gitignore` 和其他项目忽略文件不会影响发现；系统只排除已配置的目录基名。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
