---
description: "让 CLI 应用插件运行保管用户账号的第三方 CLI：按 CLI 的绝对路径执行有上限的命令，用运行时上下文把这个路径告诉模型，并为插件页在 Host 上一次执行一个账号操作。"
kind: "package-library"
---

# @deepseek-ai/dsh-cli-account

[English](README.md) | 中文

## 概述

飞书、企业微信等 CLI 应用插件用这个库运行各自厂商的 CLI，并检查、连接和取消插件页显示的账号。`CliCommandExecutor` 按 CLI 的绝对路径运行一条命令，带截止时间、输出上限和逐行回调；`registerCliPathContext` 在运行时上下文中把同一路径告诉模型。`CliAccountRuntime` 一次执行一个账号操作，只在受信任的主机上提供授权链接，只在插件声明的阶段允许取消，并流式推送账号视图。每个插件保留各自的命令、解析和账号状态。

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

插件在运行时上下文中声明 CLI 路径，继承运行时，通过 control 运行每条命令，并在自己的 Remote 上提供运行时的方法：

```ts
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CliAccountRuntime, CliCommandExecutor, executableFileName, exitFailure, registerCliPathContext, type CliOperationControl } from '@deepseek-ai/dsh-cli-account'
import type {} from '@deepseek-ai/dsh-subprocess'

declare const ctx: Context
const executable = join('/opt/vendor/bin', executableFileName('vendor-cli'))

class Account extends CliAccountRuntime<{ readonly state: 'unchecked' | 'out' | 'in' }, 'check', never> {
  protected async perform(_kind: 'check', control: CliOperationControl<never, 'status'>, signal: AbortSignal): Promise<void> {
    const result = await control.run('status', ['auth', 'status'], signal)
    if (result.exitCode !== 0) throw new Error('vendor-cli: auth status failed')
    this.publish({ state: result.stdout.trim() === 'authorized' ? 'in' : 'out' })
  }
}

registerCliPathContext(ctx, { name: 'vendor:cli', product: 'Vendor', program: 'vendor-cli', executable })
const account = new Account({
  name: 'vendor', logger: ctx.logger, account: { state: 'unchecked' }, check: 'check', cancellable: [],
  authorizationHosts: ['vendor.example'], classify: exitFailure,
  cli: new CliCommandExecutor(ctx.subprocess, { program: 'vendor-cli', executable, commandTimeoutMs: 30_000 }),
})
```

`account.start(kind)` 返回操作 id；已有操作在运行时抛出异常。`account.follow(signal)` 先产出当前的 `CliAccountView`，没有操作在运行时启动一次检查，之后产出每次变化后的视图。`account.cancel(id)` 只在声明为可取消的阶段停止指定操作。`account.dispose()` 取消进行中的操作，等待其进程退出，并释放执行器。以 [`src/runtime.ts`](src/runtime.ts)、[`src/executor.ts`](src/executor.ts) 和 [`src/context.ts`](src/context.ts) 中的契约为准。

### 运行时上下文

`registerCliPathContext(ctx, cli)` 注册一条必需的运行时上下文，让模型按 `cli.executable` 运行 `cli.program`，这正是执行器运行的路径。传入 `scripts` 时，它还让模型只在运行 skill 脚本的命令中把可执行文件所在目录放到 PATH 最前面，并且不要按名称运行 `cli.program`。文本采用内置组合在 Host 平台上提供给模型的 shell 写法。在 Windows 以外的平台上使用 POSIX shell 语法：前缀是 `PATH="<可执行文件所在目录>:$PATH"`，只改变这一条命令的 PATH，文本还要求不要导出 PATH。在 Windows 上模型使用 PowerShell，文本用调用运算符写出可执行文件 `& '<可执行文件>'`，前缀写作 `$env:PATH = '<可执行文件所在目录>;' + $env:PATH`；PowerShell 每次调用都在新进程中运行，所以这个修改只在本次调用内有效。传入 `ready` 时，`ready()` 返回 false 期间这条上下文不贡献任何内容。文本从不做变量插值，插件释放时这条上下文随之移除。`executableFileName(program)` 给出插件要查找的文件名：`program`，在 Windows 上是 `program.exe`。文本见[模型体验](#model-experience)。

### 命令、链接与失败

不等待用户的命令使用插件的 `commandTimeoutMs`，其中包括查找可执行文件的时间；以 `awaitsUser` 运行的命令最多等待 10 分钟。执行器最多保留 1 MiB 的 stdout 和最后 4 KiB 的 stderr，两者都按 UTF-8 字节计算，末尾部分在字符边界处截断，并在进程退出后才结束。管道读到关闭为止，最多读到 subprocess runtime 报告退出后 2 秒，因此结果不会等继承了管道的后代进程关闭它们；后代进程在此之后写出的内容会被丢弃。`onLine` 在命令写出时逐行接收输出：与 Node 的 `readline` 一样，`\n`、`\r\n` 和单独的 `\r` 都会结束一行，因此 CLI 在链接行之后用 `\r` 重绘的进度提示不会拖住该链接。未结束的剩余部分在退出时送达，超过所在流上限的行会被整行跳过，而不是被截断。命令结束后不会再有行送达。查找可执行文件或启动进程失败、超过截止时间、进程被信号终止，或 stdout 超过 1 MiB 时，命令以异常结束而不返回退出码；此时插件的分类函数看到的退出码为 null。

`offer(url)` 只接受 HTTPS、不含用户信息、主机属于插件 `authorizationHosts` 或其子域名的 URL，并返回是否接受了该链接。每个主机都要写成小写 ASCII，国际化域名写成 punycode，因为运行时拿它与 URL 规范化后的主机名比较。

失败的操作只记录并返回插件对其最后一条命令的分类，即 `{ command, exitCode }` 加上白名单字段；异常信息和 CLI 原始输出既不写日志也不返回，因为其中可能含有凭据。

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

运行时负责操作的生命周期，插件负责每条命令的含义。进行中的操作持有自己的中止控制器、阶段和链接；运行时据此生成视图，并在每次变化时通知订阅者，读取较慢的订阅者只会看到最新的视图。执行器通过 subprocess runtime 校验配置的绝对路径，启动时不添加环境变量；运行时上下文给出同一路径，因此插件和模型的 Shell 命令运行同一个可执行文件。

| 文件 | 职责 |
|---|---|
| [`src/executor.ts`](src/executor.ts) | 有上限的命令执行与进程归属 |
| [`src/runtime.ts`](src/runtime.ts) | 一次一个操作、取消、链接过滤、失败分类与订阅流 |
| [`src/context.ts`](src/context.ts) | 给出可执行文件路径的运行时上下文 |
| [`src/types.ts`](src/types.ts) | 泛型 Remote 视图类型 |
| [`src/index.ts`](src/index.ts) | 入口模块与共用配置字段 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Connector 包](../README.zh.md)——这个库和 CLI 应用插件所属的分组。
- [CLI 账号界面](../../client/ui-cli-account/README.zh.md)——镜像这个视图的插件页注册表。
- [System prompt](../../core/system-prompt/README.zh.md)——排序并渲染运行时上下文的注册表。
- [Subprocess](../../subprocess/subprocess/README.zh.md)——查找并启动 CLI 的运行时。

-----

<a id="model-experience"></a>
## 模型体验

### CLI 路径

#### 模型看到什么

每个调用 `registerCliPathContext` 且未传 `ready` 或 `ready` 返回 true 的插件，在上下文顺序 220 处有一条必需的运行时上下文；关闭可选运行时上下文时它仍然保留。第二行只在传入 `scripts` 时出现。占位符取自调用参数。在 Windows 以外的平台上，引号内的值是 JSON 字符串；在 Windows 上是 PowerShell 单引号字符串，其中的单引号写成两个。

##### 运行时上下文条目

```markdown
<Product> CLI: run `<program>` by its absolute path "<executable>"; the bare name may resolve to another installation or to none.
Scripts in the <Product> skill call `<program>` by name; prefix only the commands that run them with PATH="<executable directory>:$PATH", and never export PATH or run `<program>` by name yourself.
```

##### Windows 上的运行时上下文条目

```markdown
<Product> CLI: run `<program>` by its absolute path with the call operator, & '<executable>'; the bare name may resolve to another installation or to none.
Scripts in the <Product> skill call `<program>` by name; start only the commands that run them with $env:PATH = '<executable directory>;' + $env:PATH, and never run `<program>` by name yourself.
```

#### Token 影响

每个注册的插件在每份运行时上下文快照中占一到两行。路径变化，或这条上下文出现、消失时，追加一份快照。

#### KV Cache 影响

路径属于运行时上下文而不是系统提示词，因此缓存的提示词前缀与安装路径无关；变化时在其后追加一份运行时上下文快照。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 等待用户的命令的 10 分钟截止时间和 1 MiB 的 stdout 上限是固定的；登录等待更久的 CLI 会以可重试的结果失败。
- 授权主机同时匹配其子域名；插件无法把链接限制在一个确切的主机上。
- `exitFailure` 只按退出码分类；CLI 会输出结构化错误的插件，要自己编写按白名单取值的分类函数。
- 运行时上下文要求模型按绝对路径运行 CLI，但无法强制；按名称运行 CLI 的命令会运行 PATH 解析到的任意安装，或者失败。
- 文本的 shell 写法按 Host 平台而不是实际挂载的 shell 工具选择：在 Windows 上给模型 POSIX shell，或在其他平台上给模型 PowerShell 的组合，得到的是另一个平台的写法。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
