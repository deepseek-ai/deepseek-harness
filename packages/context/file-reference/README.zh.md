---
description: "面向宿主驱动 UI 的文件引用发现与 @file mention 语法，供选择该 seam 或为其搭配提供方的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-file-reference

[English](README.md) | 中文

## 概述

宿主驱动 UI 使用 `dsh-file-reference` 提供 `@file` 补全：UI 为指定 agent 请求路径候选，模型输入 `@path` 或 `@"path with spaces"`，选中候选后，匹配的 mention 作为普通提示词文本插入。seam 本身不拥有文件系统访问——具体提供方（如 `@deepseek-ai/dsh-file-reference-local`）负责提供候选、排序、缓存与失效。选中候选绝不读取或附带文件内容；模型必须调用文件系统工具才能查看文件。Session Controller 通过 `fileReferences/list` Remote 向浏览器消费方暴露同一发现能力。

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

当宿主驱动 UI（Web 或终端）需要提供 `@file` 补全时选择本包，并搭配一个命名空间与 agent 实际生效的 `read` 工具一致的提供方。单独挂载该 seam 而没有提供方时，UI 只能得到空的补全列表。

### mention 语法

输入开头或空白后的 `@path` token 会触发补全；其他 token 内部的 `@`（如电子邮件地址）不会。`@"path with spaces"` 打开带引号的 mention，目录候选在其尾斜杠后保持引号打开，使补全可以继续深入下一层。格式化器会拒绝语法无法安全表示的控制字符或内嵌引号路径。

### 获取候选

`ctx.fileReferences.list(agent, query, signal)` 返回指定 agent 工作目录中仅含路径的文件与目录候选，由提供方确定性地排序。目录 mention 呈现时带尾随 `/`，使补全可以继续深入下一层。浏览器消费方通过 Session Controller adapter 的 `ctx.remote.fileReferences.list` 调用同一发现能力；末位 signal 参数可取消慢速自动补全。

### 搭配提供方

本地文件系统请挂载 `@deepseek-ai/dsh-file-reference-local`；其他命名空间（远程或虚拟文件系统）需要发现能力与生效工具一致的提供方。当指定 agent 可以调用 `read` 时，提供方可以安装稳定的 `FILE_REFERENCE_PROMPT` 指引，告诉模型先读取被引用文件、再声称检查过它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该 seam 的设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

本包把抽象发现服务与共享、浏览器安全的 mention 语法分开，由提供方负责命名空间访问、排序、缓存与失效。该服务保持 wire 中立；`dsh-api-session-controller` 持有 `fileReferences/list` Remote adapter，并在解析 Agent 后委派给当前 provider。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 抽象 `FileReferenceService` 与 `FILE_REFERENCE_PROMPT` |
| [`src/grammar.ts`](src/grammar.ts) | `activeAtToken` 识别与 `formatFileMention` 渲染 |
| [`src/types.ts`](src/types.ts) | 仅含路径的结果类型 `FileReferenceCandidate` |
| — | 不发布运行时不变式伴生入口；接口不保留 candidate 或 lifecycle 状态；具体 provider 负责自己的 cache 与 invalidation 关系。 |

### 主要流程

UI 通过 `activeAtToken` 识别活动 `@` token，用查询文本调用 `list`，再渲染排序后的候选。选中后，`formatFileMention` 发出匹配的提示词写法（`@path`、`@"path with spaces"`，或带引号目录的开放形式 `@"dir/`）。任何环节都不读取文件内容；当指定 agent 拥有 `read` 工具时，提供方还可以安装稳定的 `FILE_REFERENCE_PROMPT` 提示词段。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读以下页面。它们从随附提供方进入共享引用表面，以及候选所指向的工具。

- [本地文件引用提供方](../file-reference-local/README.zh.md)——本 seam 的随附本地工作区实现。
- [会话引用子系统](../../../docs/subsystems/session-reference.zh.md)——宿主 UI 背后的共享文件引用与会话引用约定。
- [context 组地图](../README.zh.md)——相邻的请求上下文包。
- [文件系统工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-fs)——被引用路径所对应的 `read` 工具。

-----

<a id="model-experience"></a>
## 模型体验

间接影响模型体验：本包的发现 seam 与语法把文件引用指引委托给组合的提供方，由它负责呈现。

#### KV Cache 影响

接口与语法本身不增加请求 token；提供方拥有的提示词段决定可复用前缀是否改变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该 seam 何时不合适。它们是当前包约束。

- **路径候选仅供参考**：该 seam 不保证后续面向模型的文件系统工具能够访问同一命名空间；部署时必须让提供方与实际生效的 `read` 实现对齐。
- **没有文件内容引用对象**：所选文件仍是普通提示词文本，其内容必须经过模型显式调用工具后才对模型可见。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
