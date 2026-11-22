---
description: "把 CLI 应用插件的厂商 CLI 和账号注册到 Host Service `ctx.cliAccounts`：模型在运行时上下文中得到 CLI 的绝对路径，账号操作一次执行一个并通过有上限的命令完成，账号显示在插件页上。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cli-account

[English](README.md) | 中文

## 概述

飞书、企业微信等 CLI 应用插件通过 `ctx.cliAccounts` 一次注册各自的厂商 CLI 及其账号。此后模型在运行时上下文中读到 CLI 的绝对路径，插件页用插件自己的文案显示账号。Service 让每个插件的账号操作一次只执行一个，给每条命令设置截止时间和输出上限，并且只把插件信任的主机上的授权链接交给插件页。每个插件保留各自的命令、解析和账号状态。Service 由基础组合包加载，在有插件注册之前不做任何事。

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

CLI 应用插件的 Host 行注入 `cliAccounts` 并调用一次 `register`；注册持续到插件卸载，或插件释放返回的句柄。

### 何时选用

在厂商 CLI 负责让用户登录并保管凭据的插件的 Host 行中注册，DSH 只负责启动命令、展示结果和持有进程。通过 MCP 接入托管服务的插件改用 MCP 管理器，由它自己负责 OAuth。Service 通过 [`@deepseek-ai/dsh-client-ui-connector-account`](../../client/ui-connector-account/README.zh.md) 的 `ctx.connectorAccounts` 显示每个账号，没有厂商 CLI 的插件直接向它注册。

### 最小配置

[基础组合包（base bundle）](../../bundle/base/cordis.patch.yml)在基于它的每个 profile 中加载这个 Service，与它注入的 `subprocess` 和 `systemPrompt` 服务在一起：

```yaml
- id: cli-account
  name: '@deepseek-ai/dsh-cli-account'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `commandTimeoutMs` | `30000` | 不等待用户的命令的截止时间（毫秒），包括查找可执行文件；对每个已注册的 CLI 生效 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-cli-account)是每个可接受字段的完整来源。小于 1 或大于 2147483647 的值在加载时失败。

### 注册 CLI 及其账号

插件的 Host 行在 `inject` 中列出 `cliAccounts`，并在 `apply` 中注册：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { CliAccountRegistration } from '@deepseek-ai/dsh-cli-account'

interface Account { readonly state: 'unchecked' | 'out' | 'in' }

const dictionaries = {
  en: { title: 'Vendor account', hint: 'The account vendor-cli keeps.', connect: 'Connect', in: 'Connected', out: 'Not connected' },
  zh: { title: 'Vendor 账号', hint: 'vendor-cli 保管的账号。', connect: '连接', in: '已连接', out: '未连接' },
}

const registration: CliAccountRegistration<Account, 'check', never, 'status', keyof typeof dictionaries.en> = {
  name: 'vendor',
  packageName: '@acme/dsh-vendor',
  cli: { product: 'Vendor', program: 'vendor-cli', executable: '/opt/vendor/bin/vendor-cli' },
  account: { state: 'unchecked' },
  check: 'check',
  cancellable: [],
  authorizationHosts: ['vendor.example'],
  async perform(_kind, control, signal) {
    const result = await control.run('status', ['auth', 'status'], signal)
    if (result.exitCode !== 0) throw new Error('vendor-cli: auth status failed')
    control.publish({ state: result.stdout.trim() === 'authorized' ? 'in' : 'out' })
  },
  dictionaries,
  operations: () => [{ kind: 'check' }],
  copy: text => ({ title: text('title'), hint: text('hint'), activation: { title: text('title'), body: text('hint'), connect: text('connect') } }),
  present: (view, text) => view.account.state === 'in'
    ? { phase: 'connected', status: text('in'), buttons: [], notes: [] }
    : { phase: 'disconnected', status: text('out'), buttons: [], notes: [] },
}

export const inject = ['cliAccounts']

export function apply(ctx: Context): void {
  ctx.cliAccounts.register(registration)
}
```

`register` 把 CLI 的路径加入运行时上下文，让 `perform` 一次执行一个操作，并在加载了 `connectorAccounts` 时把账号显示在插件页上；没有这个注册表的组合（如 headless profile）只得到前两项。注册属于用其 `ctx` 发起调用的插件。该插件卸载时，账号从插件页移除，进行中的操作被取消，Service 等待它和它启动的 CLI 进程结束，然后移除运行时上下文条目。以同一个 `name` 再次注册会抛出异常，第一次注册保持不变。

- `name` 是插件的短名称：它的错误和日志记录的前缀，也是运行时上下文名称 `<name>:cli` 的词干。
- `packageName` 是 npm 包名，账号显示在这个包的插件页上。
- `cli` 给出产品名、程序名，以及模型和账号操作共同运行的可执行文件的绝对路径。
- `account` 是首次检查之前的账号，`check` 是没有操作运行时插件页为每个新订阅者启动的操作。
- `prepare` 可选：插件在账号可以检查之前要准备好的内容，例如下载 CLI 或它的 skills，见[检查之前的准备](#prepare-before-a-check)。
- `perform(kind, control, signal)` 执行一个操作：`control.run` 运行 CLI 的一条命令，`control.stage` 进入插件的一个阶段，`control.offer` 向插件页提供授权链接，`control.publish` 替换账号。
- `operations(text)` 列出插件页按钮可以启动的操作，`copy(text)` 写出账号区域的固定文案，`present(view, text)` 把当前视图映射为该区域显示的内容。`text(key, params)` 用 `dictionaries` 中的每种语言写出一个键，并用 `params` 填充每个 `{name}` 占位符；浏览器按其当前语言解析结果。

返回的句柄供插件在操作之外使用：`snapshot()` 返回当前的 `CliAccountView`，`publish(account)` 替换账号，`refresh()` 在没有操作运行时启动一次检查，`dispose()` 在插件卸载之前撤回注册。每个成员的确切行为见 [`src/types.ts`](src/types.ts) 中的 JSDoc。

<a id="prepare-before-a-check"></a>
### 检查之前的准备

CLI 或 skills 在加载之后才下载的插件注册 `prepare: { phase, unprepared, ready, run }`。`ready()` 返回 false 期间，每次 `check` 操作先进入 `phase`，等待 `run(signal)`，再进入 Service 的 `checking` 阶段，然后才调用 `perform`；其他操作直接调用 `perform`。`run` 抛出异常时，账号变为 `unprepared`，`perform` 不被调用，操作失败，结果中没有命令。`phase` 列在 `cancellable` 中时，插件页可以取消 `run`：signal 中止，账号变为 `unprepared`，操作以取消结束。`ready()` 返回 true 时不调用 `run`；失败之后的下一次检查会再次调用它，所以插件页的重试按钮就是重新下载的方式。账号仍是 `unprepared` 这个对象时，调用 `perform` 的检查会先把它换成注册的 `account`：什么都不缺之后，`perform` 没有发布就失败时，留下的是最初的账号，而不是 `unprepared`。

### 运行时上下文

`register` 添加一条必需的运行时上下文条目，名为 `<name>:cli`，让模型按 `cli.executable` 运行 `cli.program`，这正是账号操作的命令运行的路径。设置 `cli.scripts` 时，它还让模型只在运行 skill 脚本的命令中把可执行文件所在目录放到 PATH 最前面，并且不要按名称运行 `cli.program`。文本采用内置组合在 Host 平台上提供给模型的 shell 写法。在 Windows 以外的平台上使用 POSIX shell 语法：前缀是 `PATH="<可执行文件所在目录>:$PATH"`，只改变这一条命令的 PATH，文本还要求不要导出 PATH。在 Windows 上模型使用 PowerShell，文本用调用运算符写出可执行文件 `& '<可执行文件>'`，前缀写作 `$env:PATH = '<可执行文件所在目录>;' + $env:PATH`；PowerShell 每次调用都在新进程中运行，所以这个修改只在本次调用内有效。设置 `prepare` 时，`prepare.ready()` 返回 false 期间这条上下文不贡献任何内容。文本从不做变量插值。文本见[模型体验](#model-experience)。

### 命令、链接与失败

不等待用户的命令使用 Service 的 `commandTimeoutMs`，其中包括查找可执行文件的时间；以 `awaitsUser` 运行的命令最多等待 10 分钟。`control.run` 最多返回 1 MiB 的 stdout 和最后 4 KiB 的 stderr，两者都按 UTF-8 字节计算，末尾部分在字符边界处截断，并在进程退出后才结束。它把管道读到关闭为止，最多读到 subprocess runtime 报告退出后 2 秒，因此结果不会等继承了管道的后代进程关闭它们；后代进程在此之后写出的内容会被丢弃。`onLine` 在命令写出时逐行接收输出：与 Node 的 `readline` 一样，`\n`、`\r\n` 和单独的 `\r` 都会结束一行，因此 CLI 在链接行之后用 `\r` 重绘的进度提示不会拖住该链接。未结束的剩余部分在退出时送达，超过所在流上限的行会被整行跳过，而不是被截断。命令结束后不会再有行送达。查找可执行文件或启动进程失败、超过截止时间、进程被信号终止、stdout 超过 1 MiB，或 `onLine` 抛出异常时，命令以异常结束而不返回退出码；操作随后失败时，报告的退出码为 null。

`control.offer(url)` 只接受 HTTPS、不含用户信息、主机属于插件 `authorizationHosts` 或其子域名的 URL，并返回是否接受了该链接。每个主机都要写成小写 ASCII，国际化域名写成 punycode，因为 Service 拿它与 URL 规范化后的主机名比较。`control.stage(phase)` 撤回当前链接，插件页只能在 `cancellable` 列出的阶段取消操作。

失败的操作只返回其最后一条命令和该命令的退出码，即 `{ command, exitCode }`，其日志记录只另外加上操作的 id、种类和阶段；异常信息和 CLI 原始输出既不写日志也不返回，因为其中可能含有凭据。在插件页上，`present` 写出失败的文案，Service 把命令和退出码（如 `login` 和 `exit 3`）加为插件页在这段文案之后显示的诊断项，不翻译。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

Service 负责每个注册的生命周期，插件负责每条命令的含义。`register` 在调用方插件的 context 中运行，因此运行时上下文条目、账号运行时和插件页注册都是该插件的 effect，随它按相反的顺序释放。每个注册有一个运行时，其进行中的操作持有自己的中止控制器、阶段和链接；运行时据此生成视图，并在每次变化后调用每个观察者。每个注册还有一个执行器，它通过 subprocess runtime 校验绝对路径，启动时不添加环境变量；运行时上下文给出同一路径，因此插件的操作和模型的 Shell 命令运行同一个可执行文件。

| 文件 | 职责 |
|---|---|
| [`src/executor.ts`](src/executor.ts) | 有上限的命令执行与进程归属 |
| [`src/runtime.ts`](src/runtime.ts) | 一次一个操作、取消、链接过滤、失败报告与观察者 |
| [`src/context.ts`](src/context.ts) | 给出可执行文件路径的运行时上下文条目 |
| [`src/text.ts`](src/text.ts) | 插件展示函数根据字典生成的 `LocalizedText` |
| [`src/types.ts`](src/types.ts) | 注册、操作 control、句柄、账号视图、命令失败和字典类型 |
| [`src/index.ts`](src/index.ts) | `ctx.cliAccounts` Service、其配置和 `register` |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Connector 包](../README.zh.md)——这个包和 CLI 应用插件所属的分组。
- [连接器账号界面](../../client/ui-connector-account/README.zh.md)——Service 为每个账号注册的插件页注册表。
- [System prompt](../../core/system-prompt/README.zh.md)——排序并渲染运行时上下文的注册表。
- [Subprocess](../../subprocess/subprocess/README.zh.md)——查找并启动 CLI 的运行时。
- [Base bundle](../../bundle/base/README.zh.md)——加载这个 Service 的组合包，以及 profile 如何覆盖它的某一行。

-----

<a id="model-experience"></a>
## 模型体验

### CLI 路径

#### 模型看到什么

每个通过 `ctx.cliAccounts` 注册、且 `prepare` 未设置或 `prepare.ready()` 返回 true 的插件，在上下文顺序 220 处有一条必需的运行时上下文条目；关闭可选运行时上下文时它仍然保留。第二行只在设置 `cli.scripts` 时出现。占位符取自注册的 `cli`。在 Windows 以外的平台上，引号内的值是 JSON 字符串；在 Windows 上是 PowerShell 单引号字符串，其中的单引号写成两个。没有插件注册时，Service 不向模型请求添加任何内容。

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
- `commandTimeoutMs` 对每个已注册的 CLI 是同一个值；插件无法设置自己的截止时间。
- 授权主机同时匹配其子域名；插件无法把链接限制在一个确切的主机上。
- 失败的操作只报告其最后一条命令和该命令的退出码；插件无法把 CLI 输出的错误码加入失败信息。
- 无论是否安装了 CLI 应用插件，基础组合包都会加载这个 Service。
- 运行时上下文要求模型按绝对路径运行 CLI，但无法强制；按名称运行 CLI 的命令会运行 PATH 解析到的任意安装，或者失败。
- 文本的 shell 写法按 Host 平台而不是实际挂载的 shell 工具选择：在 Windows 上给模型 POSIX shell，或在其他平台上给模型 PowerShell 的组合，得到的是另一个平台的写法。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
