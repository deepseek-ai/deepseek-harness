---
description: "本地文件系统 spill 后端：spill 文本如何保存到私有会话级文件，并用 read 或 grep 取回。"
kind: "package-reference"
---

# @deepseek-ai/dsh-spill-local

[English](README.md) | 中文

## 概述

`dsh-spill-local` 把调用方的超大文本保存到宿主文件系统中私有的会话级文件，并以该文件路径作为定位信息返回，同时给出告诉模型读取或搜索它的取回指引。只要组合需要在与 agent 相同的机器上进行 spill 存储，就挂载它。文件对当前用户私有、名称不可预测，且每个会话的文件归入稳定的目录，因此共享根目录既不会泄露输出，也不会被预置的符号链接重定向。配置选择根目录与启动清理保留期；预览与 spill 决策由其他包负责。

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

在需要把文本 spill 到本地文件系统的组合中挂载此后端。它注册为 `dsh-spill-policy` 插件与其他调用方使用的 `ctx.spillStore` 服务。

### 最小配置

不带配置加载插件是安全的：文件会落在操作系统临时目录下延迟创建的私有（0700）每进程目录中。当文件必须位于已知位置时，设置 `root`。

```yaml
- name: '@deepseek-ai/dsh-spill-local'
  config:
    root: /absolute/path/to/spill
    cleanupPeriodDays: 30
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 私有 0700 临时目录 | spill 文件的根目录；设置后可将文件保存在已知位置 |
| `cleanupPeriodDays` | `30` | 文件在一次性启动清理中可被删除前需经过的天数；`0` 禁用清理 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-spill-local)是每个受支持字段的穷尽式真源。

### 你会得到什么

每次 `saveText` 调用都会把完整文本写入一个新文件，并返回三个字段：`locator`（文件路径）、`bytes`（精确的 UTF-8 字节数）与 `retrievalHint`——"Use read with offset/limit, or grep this path to search within it."。消费方把该提示展示给模型，模型随后可以用其常规文件工具读取或搜索该文件。

### 文件存放位置

文件存放在 `<root>/session-<hash>/<random>-<safeName>`：`session-<hash>` 是所属会话 id 的短哈希（让同一会话的文件归在一起），`<random>-<safeName>` 把不可预测的十六进制前缀与清理为单个安全路径段的调用方建议名配对。相对 `root` 从进程工作目录解析。

<a id="startup-cleanup"></a>
### 启动清理

一次尽力而为的扫描会在激活后启动，不延迟服务可用性。它扫描配置的根目录和操作系统临时目录下先前的默认 `dsh-spill-*` 根目录，删除修改时间严格早于配置截止时间的常规文件，修剪空会话目录，并只删除已经变空的先前默认根目录。长期运行的进程要到重启时才会再次扫描。dispose 会等待扫描结束；如果清理移除了会话目录，并发写入会重新创建它。

扫描会解析文件系统身份，绝不跟随或删除符号链接，并跳过无关条目。在 POSIX 上，它只接受当前用户拥有、组用户和其他用户不可写、且祖先路径能防止替换的根目录与会话目录；`/tmp` 等带 sticky 位的可写临时目录仍然允许使用。不安全路径会产生警告并保持不变。文件系统和警告接收方故障都会被兜底，因此清理无法使激活或并发 spill 写入失败。

### 故障与恢复

真实存储故障——权限不足、磁盘已满、根目录不可写——会让 `saveText` 调用以拒绝结束；由调用方决定如何降级。随附策略把拒绝当作尽力而为处理并保留原始内联结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释此后端背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

后端只负责存储细节，建立在一个原则之上：**spill 产物必须私有且不可重定向**。根目录私有（0700）、会话目录是稳定哈希、文件名不可预测、写入采用排他且仅所有者模式。存储机制放在与 Cordis 无关的模块中，以便无需上下文即可单元测试。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、`LocalSpillStore` 服务、清理生命周期、定位信息与取回提示的组装 |
| [`src/cleanup.ts`](src/cleanup.ts) | 一次性按年龄扫描、文件系统身份检查、符号链接和所有权保护 |
| [`src/store.ts`](src/store.ts) | 与 Cordis 无关的存储机制：私有根目录、会话目录、安全名称编码、排他写入 |
| — | 不发布运行时不变式伴生入口；约定在 seam 处强制执行。 |

### 文件命名与写入

`suggestedName` 是不可信输入，因此 `encodeSegment` 会把 `[A-Za-z0-9._-]`（以及 `~` 本身）之外的每个字符转义成 `~XXXX` 形式，使映射对所有 JS 字符串都是单射：分隔符、`../`、NUL 与绝对路径永远无法逃出单个路径段，整段 token `.`/`..` 也会被转义。写入采用 `open(path, 'wx', 0o600)`——任何已存在路径（无论是否符号链接）都会失败，因此预置目标无法重定向写入。对同一建议名的两次保存会得到不同的随机前缀。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。

- [spill 存储服务](../spill/README.zh.md)——此后端实现的 `saveText` 约定与词汇。
- [spill 包映射](../README.zh.md)——三包家族与各自职责。
- [dsh-spill-policy](../spill-policy/README.zh.md)——结果过大时调用此后端的策略。
- [spill 子系统](../../../docs/subsystems/spill.zh.md)——穷尽式词汇与归属。
- [工具输出 spill 决策](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)——能力边界与设计依据。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过把已保存文件路径与 read/grep 取回指引渲染给模型的 spill 消费方。

#### KV Cache 影响

无直接失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本地后端何时不合适或需要特别的运维注意。它们是当前的包约束。

- **长期运行的部署要等到重启才会被扫描**——一次性扫描只在激活后运行，因此运行期间超过年龄截止值的文件会在下次启动时回收。
- **定位信息需要与其位于同一文件系统的消费方**——远程或虚拟部署需要另一个 `SpillStore` 后端，其定位信息与取回提示在该环境中有明确含义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放方向。它明确不具权威性。

#### 未来：工作区隔离的交互

取回模型假定模型的 `read`/`grep` 工具可以检查返回的路径，即使 spill 目录在会话工作目录之外。未来的工作区隔离策略必须显式允许本地 spill 路径，或者改用非文件 spill 后端。

</details>
