---
description: "让 CLI 应用插件运行保管用户账号的第三方 CLI：在私有 Shell PATH 上执行有上限的命令，并为插件页在 Host 上一次执行一个账号操作。"
kind: "package-library"
---

# @deepseek-ai/dsh-cli-account

[English](README.md) | 中文

## 概述

飞书、企业微信等 CLI 应用插件用这个库运行各自厂商的 CLI，并检查、连接和取消插件页显示的账号。`CliCommandExecutor` 在私有 Shell PATH 上运行一条命令，带截止时间、输出上限和逐行回调。`CliAccountRuntime` 一次执行一个账号操作，只在受信任的主机上提供授权链接，只在插件声明的阶段允许取消，并流式推送账号视图。每个插件保留各自的命令、解析和账号状态。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 何时使用

在厂商 CLI 负责让用户登录并保管凭据的插件的 Host 行中使用它，DSH 只负责启动命令、展示结果和持有进程。插件的插件页用 [`@deepseek-ai/dsh-client-ui-cli-account`](../../client/ui-cli-account/README.zh.md) 镜像这个视图。通过 MCP 接入托管服务的插件改用 MCP 管理器，由它自己负责 OAuth。

### 入口

插件继承运行时，通过 control 运行每条命令，并在自己的 Remote 上提供运行时的方法：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { CliAccountRuntime, CliCommandExecutor, exitFailure, type CliOperationControl } from '@deepseek-ai/dsh-cli-account'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-subprocess'

declare const ctx: Context

class Account extends CliAccountRuntime<{ readonly state: 'unchecked' | 'out' | 'in' }, 'check', never> {
  protected async perform(_kind: 'check', control: CliOperationControl<never, 'status'>, signal: AbortSignal): Promise<void> {
    const result = await control.run('status', ['auth', 'status'], signal)
    if (result.exitCode !== 0) throw new Error('vendor-cli: auth status failed')
    this.publish({ state: result.stdout.trim() === 'authorized' ? 'in' : 'out' })
  }
}

const account = new Account({
  name: 'vendor', logger: ctx.logger, account: { state: 'unchecked' }, check: 'check', cancellable: [],
  authorizationHosts: ['vendor.example'], classify: exitFailure,
  cli: new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: 'vendor-cli', commandTimeoutMs: 30_000 }),
})
```

`account.start(kind)` 返回操作 id；已有操作在运行时抛出异常。`account.follow(signal)` 先产出当前的 `CliAccountView`，没有操作在运行时启动一次检查，之后产出每次变化后的视图。`account.cancel(id)` 只在声明为可取消的阶段停止指定操作。`account.dispose()` 取消进行中的操作，等待其进程退出，并释放执行器。以 [`src/runtime.ts`](src/runtime.ts) 和 [`src/executor.ts`](src/executor.ts) 中的契约为准。

### 命令、链接与失败

不等待用户的命令使用插件的 `commandTimeoutMs`，其中包括查找可执行文件的时间；以 `awaitsUser` 运行的命令最多等待 10 分钟。执行器最多保留 1 MiB 的 stdout 和最后 4 KiB 的 stderr，并在进程退出后才结束。`offer(url)` 只接受 HTTPS、不含用户信息、主机属于插件 `authorizationHosts` 或其子域名的 URL，并返回是否接受了该链接。失败的操作只记录并返回插件对其最后一条命令的分类，即 `{ command, exitCode }` 加上白名单字段；异常信息和 CLI 原始输出既不写日志也不返回，因为其中可能含有凭据。

### 共用配置

没有其他字段的插件直接用 `CliAccountConfig` 作为 `Config`：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | 由插件决定 | 存放 CLI 可执行文件的绝对目录 |
| `commandTimeoutMs` | `30000` | 不等待用户的命令的截止时间，包括查找可执行文件 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

运行时负责操作的生命周期，插件负责每条命令的含义。进行中的操作持有自己的中止控制器、阶段和链接；运行时据此生成视图，并在每次变化时通知订阅者，读取较慢的订阅者只会看到最新的视图。执行器为 subprocess runtime 准备带私有 PATH 的环境，在其中查找程序，并用同一环境启动它，因此后端和 Shell 使用同一个可执行文件。

| 文件 | 职责 |
|---|---|
| [`src/executor.ts`](src/executor.ts) | 有上限的命令执行与进程归属 |
| [`src/runtime.ts`](src/runtime.ts) | 一次一个操作、取消、链接过滤、失败分类与订阅流 |
| [`src/types.ts`](src/types.ts) | 泛型 Remote 视图类型 |
| [`src/index.ts`](src/index.ts) | 入口模块与共用配置字段 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Connector 包](../README.zh.md)——这个库和 CLI 应用插件所属的分组。
- [CLI 插件页组件](../../client/ui-cli-account/README.zh.md)——镜像视图的浏览器一半。
- [Shell 环境](../../shell/shell-env/README.zh.md)——后端 subprocess 与 Shell 工具共用的私有 PATH 贡献。
- [Subprocess](../../subprocess/subprocess/README.zh.md)——查找并启动 CLI 的运行时。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这个库不注册任何面向模型的内容；CLI 需要的 skill 由各插件自己负责。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 等待用户的命令的 10 分钟截止时间和 1 MiB 的 stdout 上限是固定的；登录等待更久的 CLI 会以可重试的结果失败。
- 授权主机同时匹配其子域名；插件无法把链接限制在一个确切的主机上。
- `exitFailure` 只按退出码分类；CLI 会输出结构化错误的插件，要自己编写按白名单取值的分类函数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
