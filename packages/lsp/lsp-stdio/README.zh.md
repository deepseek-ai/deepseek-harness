---
description: "ctx.lsp 的 stdio 语言服务器提供方：配置好的服务器命令、扩展名映射与有边界的临时打开查询，供组合本地代码导航的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp-stdio

[English](README.md) | 中文

## 概述

`dsh-lsp-stdio` 把配置好的本地语言服务器命令变成 `ctx.lsp` 上的提供方：给它一张服务器命令与扩展名到语言的映射表，agent 就能针对这些语言的文件获得由真实语言服务器服务的语义代码导航——定义、引用、实现与悬停。一个插件实例针对每个配置的服务器注册一个隔离的提供方；每个提供方按工作区惰性启动一个服务器进程，并在查询时临时打开文档，因此查询之间不会累积任何文档状态。服务器与源文件始终位于已挂载的文件系统与子进程执行世界中。它是通用主机，而不是语言服务器目录或安装器——部署需要显式配置命令。本包信任所配置的服务器，自身不提供任何沙箱。

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

当部署拥有本地语言服务器——例如 `typescript-language-server`——并希望 harness 通过它们导航代码时，挂载此提供方。它需要描述同一执行世界的文件系统与子进程提供方，以及 `dsh-lsp` seam；若要向模型开放，还需要 `dsh-tool-lsp`。

### 最小配置

`servers` 记录把每个稳定的提供方 id 映射到一条服务器命令。提供方会在清理 credential 后于加载时解析每个可执行文件，因此一个坏配置项会阻止所有提供方注册；进程在第一次匹配查询时惰性启动。

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-lsp'
- name: '@deepseek-ai/dsh-lsp-stdio'
  config:
    servers:
      typescript:
        command: typescript-language-server
        args: ['--stdio']
        extensionToLanguage:
          '.ts': typescript
- name: '@deepseek-ai/dsh-tool-lsp'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | 必填 | 要 spawn 的可执行文件——绝对路径，或在加载时从子进程 PATH 解析；不使用 shell 启动 |
| `extensionToLanguage` | 必填 | 小写、以点开头的扩展名 → LSP language id（例如 `{ '.ts': 'typescript' }`） |
| `args` | `[]` | 传给可执行文件的参数 |
| `env` | `{}` | 合并到已清理 credential 的环境之上的额外 env；匹配 `KEY`／`PASSWORD`／`SECRET`／`TOKEN` 的变量以及所有 `DSH_*` 名称不会被转发 |
| `initializationOptions` | `null` | 转发给服务器的静态 `initialize` 选项 |
| `configuration` | `null` | 每个 `workspace/configuration` 配置项的静态答案 |
| `maxMessageBytes` | `16000000` | 从服务器接受的单条 framed 消息最大大小 |
| `maxStderrBytes` | `1000000` | 为诊断保留的 stderr 尾部最大大小 |
| `maxDocumentBytes` | `4000000` | 该主机可打开的源文件大小上限 |
| `shutdownTimeoutMs` | `5000` | 升级前用于优雅 `shutdown`／`exit` 的预算 |
| `killGraceMs` | `2000` | 请求取消及 SIGTERM→SIGKILL 升级的宽限期 |

`servers` 必须至少包含一个配置项，每个 id 都必须非空；定时器预算必须是 Node 定时器范围内的正整数，字节上限必须为正。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsp-stdio)是每个受支持字段的穷尽式真源。

### 查询做什么

首次查询某个工作区时，提供方会为该工作区启动一个服务器进程并放入池中。每次查询通过 `ctx.fs` 读取当前源文件，在服务器中打开它（`textDocument/didOpen`），执行所请求的操作，然后关闭——因此服务器始终看到当前文本，调用之间不会残留任何文档状态。同一服务器与工作区的查询一次只执行一个；不同工作区并行运行。如果池化进程在只读查询之前或期间发生故障，提供方会在新进程上重试该查询一次。

### 可观察的成功与失败

成功的导航返回规范化位置，悬停返回规范化文本或无可悬停提示；空结果是成功的无结果响应。当服务器不支持该操作或临时打开／关闭同步（`LSP_UNSUPPORTED_OPERATION`）、源文件缺失、非普通文件、非 UTF-8、过大或位于规范工作区之外（在服务器启动前被拒绝），或服务器返回格式错误的载荷（`LSP_MALFORMED_RESPONSE`）时，查询会失败。被强制杀死的 harness 会让服务器继续运行直到自行退出——优雅关闭只发生在服务释放时。

### 安全边界

本提供方信任所配置的服务器，不提供任何沙箱隔离；服务器获得的是已挂载执行世界的文件系统与进程权限。它会在服务器启动前拒绝缺失、非普通文件、非 UTF-8、过大或规范化后位于工作区之外的查询源。结果位置可以指向工作区外部，但外部路径永远不能成为查询源。为同一执行世界挂载文件系统与子进程提供方——分裂世界组合无效。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **通用主机，不是目录。** 部署显式配置命令与映射；预设应放在 `cordis.yml` overlay 中，而不是本包内。
- **兼容性优先的临时打开。** 每次查询都执行 `didOpen`（版本 1、完整文本）→ 请求 → `didClose`，因此服务器始终看到当前字节，第一版不需要 `didChange`、内容 cache 或文档 LRU。
- **先读后启动。** 源文件在工作区队列内先完成解析、包含关系检查与字节限制，然后才创建任何进程，因此排队查询只会在轮到自身时读取当前字节，无效源文件也不会留下空闲的池化进程。
- **每个规范工作区一个池化进程。** 实例按 `(server id, canonical workspace target)` 进行 single-flight；传输故障会在等待释放完成后于新进程上重试一次该只读查询。
- **逐工作区串行化。** 每个工作区一条可中止队列，串行执行源读取／打开／查询／关闭生命周期；不同工作区并行运行，无法停止服务器的取消只会终止该实例。
- **有边界的释放。** 优雅 `shutdown`／`exit` 会升级到 subprocess 提供方的 managed-range 终止流程；是否完全停稳由等待整个 range 确认，而非由终止请求自身的结果确认。
- **执行世界配对。** 服务器通过 `ctx.subprocess` 启动，`processId: null`（另一台机器或 PID namespace 不得监视 harness）；源文件通过 `ctx.fs` 读取；不发出 `fs/observed` 事件——只有 LSP 结果对模型可见。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：config schema、可执行文件解析、提供方注册、进程池 |
| [`src/host.ts`](src/host.ts) | 通过 `ctx.fs` 完成工作区规范化与有边界的源读取 |
| [`src/instance.ts`](src/instance.ts) | 单个服务器进程：initialize 握手、串行化临时打开查询、有边界的释放 |
| [`src/connection.ts`](src/connection.ts) | JSON-RPC 端点：id 关联、出站请求、入站服务器请求、stderr 上限 |
| [`src/framing.ts`](src/framing.ts) | `Content-Length` 分帧与有边界的解码器 |
| [`src/protocol.ts`](src/protocol.ts) | 协议类型子集：能力、位置、悬停、文本文档同步 |
| [`src/translate.ts`](src/translate.ts) | 能力检查、UTF-16 协商、`Location`／`LocationLink`／hover 规范化 |
| [`src/abort.ts`](src/abort.ts) | 融合调用方与释放信号的取消辅助 |
| — | 不发布运行时不变式伴生入口；进程池与队列是私有状态。 |

### 协议行为

初始化会声明 UTF-16 位置、工作区文件夹与配置、markdown／plaintext hover，以及定义与实现使用的 link 支持，且不进行动态注册；服务器返回的能力具有最终决定权。服务器省略 `positionEncoding` 时默认为 `utf-16`；其他任何值都会使查询失败。客户端通过静态配置回答 `workspace/configuration`，接受生命周期记账请求，并拒绝 `workspace/applyEdit`——它绝不应用编辑或运行命令。导航直接映射 `Location`，并从 `LocationLink` 的 `targetUri` + `targetSelectionRange` 映射；hover 规范化接受 `MarkupContent` 与 `MarkedString` 形状，保留字符串值，把带 language tag 的值渲染为围栏代码，并用一个空行连接数组。缺失结果、格式错误的范围或位置，以及格式错误的 hover 编码，都会以结构化 `LSP_MALFORMED_RESPONSE` 错误失败。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享的导航模型逐步进入 seam 与工具。

- [LSP 导航子系统](../../../docs/subsystems/lsp.zh.md)——操作、坐标、请求与结果，以及 `LspError` code。
- [dsh-lsp](../lsp/README.zh.md)——本提供方注册到的 seam。
- [dsh-tool-lsp](../tool-lsp/README.zh.md)——基于该 seam 的面向模型工具。
- [lsp 组地图](../README.zh.md)——三个包的家族及其相关文档。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-lsp` 间接影响；该工具呈现此提供方的规范化结果，本主机自身不贡献提示词或 schema。

#### KV Cache 影响

不会直接失效；请求前缀变更由 `dsh-tool-lsp` 负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **不提供隔离策略**——本包信任所配置的服务器，不对其进程实施沙箱；受限部署必须提供适当的进程与文件系统提供方，或使用同一执行世界的沙箱包装层。
- **临时打开兼容性下限**——同步能力省略打开／关闭（或声明 `None`）的服务器不受支持，即使关闭文档查询能够工作；固定的 TypeScript e2e 只建立一项兼容性下限，不代表跨语言承诺。
- **逐服务器与逐工作区串行化延迟**——共享同一个服务器与工作区的并行 agent 会在一个进程后排队；长生命周期工作区进程会占用内存直到释放。
- **被强制杀死的 harness 会遗留语言服务器**——`initialize.processId: null` 取消了服务器侧的客户端 PID 监视，因此服务器只能由服务的优雅释放清理；被 SIGKILL 的 harness 会让它们继续运行，直到自行退出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
