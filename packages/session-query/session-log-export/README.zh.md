---
description: "Web 会话日志 ZIP 导出：Host 流式传输、认证下载路由、Session Header 操作与 /export 命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-export

[English](README.md) | 中文

## 概述

`dsh-session-log-export` 让 Web 界面可以下载会话的完整历史：Session Header 中的 `Session log` 按钮与 `/export` 斜杠命令都会把会话树——会话本身、其子会话与附件——作为 ZIP 交给浏览器下载。本包拥有 Host 归档流、经过认证的 Fetch 路由以及浏览器控制和反馈。下载目标位置由浏览器选择。设置与用法在前，随后说明实现细节。

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

当 Web bundle 需要让用户导出会话日志时使用本包。它需要 Connection、命令注册表、Session 查询与持久化以及附件服务。挂载插件，然后点击 Session Header 中的 `Session log` 或输入 `/export`；浏览器会下载 `dsh-session-<id>.zip`。

### 何时选择

为需要带可见下载弹窗的用户级会话导出的 Web 部署选择它。需要程序化或 Host 侧导出时避免使用：本包产生的是浏览器下载，而非 Host 路径写入，并且它要求随产品交付的 JSONL provider 提供逐 Session 的明文或 zstd 原始产物。

### 组合

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

Web bundle 将本包与 Connection、`dsh-commands`、`dsh-client-ui-commands` 和 `dsh-client-ui-conversation` 一起挂载。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `compressionLevel` | `6` | 每个 ZIP 条目的 DEFLATE 级别，范围为 0 到 9。 |

### 命令约定

| 输入 | 结果 |
|---|---|
| `/export` | 记录一组用户命令生命周期；提交命令的浏览器下载 `GET /api/session.export?sessionId=<id>&includeDescendants=true` |
| `/export <path>` | 错误；浏览器下载通过浏览器的普通下载行为选择目标位置 |

### 预期行为

弹窗报告三个阶段：准备中、开始下载或失败。关闭弹窗不会取消正在进行的下载，该操作随后完成时弹窗也不会重新打开。每个会话同时只允许一项下载，重复操作共用该任务。导出包含实时会话的最新事件：Host 端点在读取前会 flush 活动的根会话，因此斜杠命令触发的 ZIP 会包含启动下载的 `command/run` 与 `command/done` 事件对；冷持久化会话不需要 flush。

### 失败

当 ZIP 流式传输开始前的预检失败时——例如 Host 端点不可达或配置错误——弹窗显示准备阶段错误。浏览器接受 GET 后发生的子会话或附件读取失败由浏览器下载管理器报告，不通过弹窗报告。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本包如何接线导出控制，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计拆分

本包有两个半包。Host 半包（[`src/index.ts`](src/index.ts)）注册 `/export` 命令，并向 Connection 贡献精确的 `GET`/`HEAD /api/session.export` Fetch 路由；[`src/archive.ts`](src/archive.ts) 构建有界 ZIP 流。浏览器半包（[`src/client/index.ts`](src/client/index.ts)）提供共享下载控制器和 UI，并观察 `command/executed`，因此只有提交命令的浏览器会启动下载。

### 下载流程

两条入口都会对 `GET /api/session.export?...` 发出 `HEAD` 预检，然后把 GET URL 交给浏览器下载管理器，JavaScript 不缓冲 ZIP。一个控制器按会话持有一项进行中的下载，把并发操作折叠进该任务，并在插件释放时取消预检。弹窗状态存放在按会话键控的快照存储中，因此按钮与命令按会话共享一个弹窗。

Host 路由是业务拥有的精确 Fetch contribution。Connection 应用 Host/Origin 与浏览器会话检查并桥接流式 `Response`；本包拥有查询校验、活动会话 flush、原始产物与附件读取、ZIP 生成和 HTTP 状态语义。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 Web 控制逐步进入 Host 端点与周围的命令和会话表面。

- [dsh-client-connection](../../client/connection/README.zh.md)——Host 端点使用的认证 Fetch 路由载体。
- [命令子系统参考](../../../docs/subsystems/commands.zh.md)——`/export` 命令注册的用户命令注册表。
- [dsh-client-ui-commands](../../client/ui-commands/README.zh.md)——渲染并确认 `/export` 的浏览器命令表面。
- [会话查询包映射](../README.zh.md)——本包所属的检索能力家族。

-----

<a id="model-experience"></a>
## 模型体验

### 用户 `/export` 控制

#### 模型看到什么

无。`/export` 留在用户命令平面，ZIP 下载不会进入模型历史。

#### Token 影响

为零。该命令不创建模型轮次。

#### KV Cache 影响

无。仅日志命令生命周期与浏览器下载不会改变派生请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **要求逐 Session 原始产物**——下载端点读取随产品交付的 JSONL provider 所提供的明文或 zstd 产物；没有原始产物的仓库外 provider 无法服务该 route。
- **浏览器下载，而非 Host 路径写入**——目标位置由浏览器选择；不会返回 Host 路径或原生文件夹操作。
- **预检只报告流式传输前的失败**——浏览器接受 GET 后发生的子会话或附件读取失败由浏览器下载管理器报告，不通过弹窗报告。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关页面为准。

#### 未来：浏览器之外的导出目标

下载刻意限定在浏览器范围；Host 路径或原生文件夹导出需要新的端点约定，并决定 ZIP 的落盘位置。

</details>

**运行时不变式：** 不发布伴生入口。Connection 与 command registry 持有两个注册，每次 export 直接读取权威 Session service。
