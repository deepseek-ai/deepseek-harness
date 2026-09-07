---
description: "dsh app bin 的应用自有命令行：应用从启动器剩余参数中解析自己的 flag、--help 与退出行为。"
kind: "package-library"
---

# @deepseek-ai/dsh-cmdline

[English](README.md) | 中文

## 概述

`dsh-cmdline` 让你的应用持有自己的命令行：启动器只保留属于自己的 flag（`--profile`、`--patch`、配置 dump），并把**其后的一切**原样交给你的应用，因此 flag、`--help` 文本与解析错误都由你的应用决定。你从这些参数解析出的值会胜过配置中写下的任何默认值，且无需写回任何内容。你的应用还获得一个有边界的进程退出请求，接到启动器的关停上。当你编写接受自有 flag 的应用 bin 时使用它；它本身不增加任何提示词、schema 或面向模型的表面。

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

你的应用在启动时读取本次调用的内层参数，任意数量的插件都可以使用它们。常用路径是：启动插件读取参数、解析它们，再发布解析后的值；其他行由这些值配置自身。

### 启动器提供的值

启动器向你的应用提供三样东西：

- `ctx.cmdlineArgs`——本次调用的内层参数。读取它返回一份不可变快照，且绝不会消费或修改它们：`dsh --profile tui --resume abc` 给你的应用 `['--resume', 'abc']`。
- `ctx.appExit`——在整棵树关闭后请求进程退出的方式，接到启动器的关停控制器上。
- `ctx.appReady`——成功启动信号，只在 Loader 树与 launcher 自有设置成功后提交。

没有参数的启动会看到空列表——这是诚实的答案，而不是缺失的值。

`exitOnStdinEnd(ctx, label)` 把已成功启动的 stdio 应用 EOF 绑定到 `ctx.appExit(0)`。它绝不读取或恢复 stdin，因此协议传输会收到挂载前已缓冲的字节；启动拒绝优先于竞态 EOF，拥有它的 fiber 会移除两项待处理监听。

### 解析你的 flag

你自带自己的 commander program：声明你的 flag 与 action，本包会针对内层参数运行它。校验只发生在你的 action 中，并由它发布你的行所需的任何值。插件的 Loader 行不携带特殊标记：

```yaml
- id: web-startup
  name: '@deepseek-ai/dsh-web-app/startup'
```

由解析值配置的行注入发布的服务，并在其配置中直接读取它：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

结果：即使配置写的是 3080，`dsh --profile web --port 8080` 也会让服务器监听 8080 端口，因为 flag 优先。`--help` 打印你的应用帮助并以 0 退出、不启动任何内容；被拒绝的值（例如非数字端口）打印你的错误并以非零码退出，任何依赖解析值的行都不会启动。

### flag 如何胜过配置值

写在 `!!js` 表达式旁的值是后备：flag 存在时 flag 优先，否则使用写下的值。解析在启动时、你的解析器运行之后发生一次，因此 flag 绝不会被之后的配置重载悄悄重置。

### 多个插件读取同一份参数

任意数量的插件都可以读取同一份参数——读取绝不会消费它们——每个插件都能解析自己需要的部分并发布各自的值。启动器不会决定谁是命令行的所有者：没有读取方的应用会忽略自己的参数。

本仓库之外构建的应用行为一致：即使它们自带 commander 副本，其 `--help` 也会打印并退出，而不是崩溃。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释上述结果如何实现，并指出实现它们的代码位置；这里的内容面向开发者，使用本包并不需要。

### 设计说明

- **启动器事实，而非配置。** `cmdlineArgs` 与 `appExit` 在树挂载前提供到宿主上下文上；它们不是 Loader 行，因此没有任何组合持有或覆盖它们。
- **按位置切分。** 启动器不认识任何应用行：自身 flag 之后的第一个 token 就是应用参数的起点，因此 flag 家族、`--help` 文本与解析错误都由应用自己持有。
- **结构化错误识别。** `isCommanderError` 读取 commander 的错误码前缀，而不是用 `instanceof`，因为树外插件会带来自己的一份 commander 副本，其 `CommanderError` 身份不同；`configureExitAndOutput` 会遍历每个子命令，因为 commander 只在注册时复制退出与输出设置。
- **可注入的输出流。** `internals` 持有输出流，使测试无需触碰进程即可捕获 commander 的文本。

### 解析约定

解析路径是一个只有两个所有者的小家族：`provideCmdline` 冻结宿主参数，并在任何配置树条目挂载前提供 `cmdlineArgs` 与 `appExit`；`parseCmdline` 针对不可变参数运行你的 commander program，把每个命令的 help、version 与错误输出都接到启动器上。被拒绝的值、`--help` 或 `--version` 会打印 commander 文本并请求 `ctx.appExit`，且不发布任何内容，因此依赖行绝不会激活；Loader 会把每行的 `!!js` 插值推迟到该行声明的注入全部激活之后。各导出的约定在代码中，不在本 README——见 [`src/index.ts`](src/index.ts)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `CmdlineArgs`/`AppExit` 类型、`provideCmdline`、`parseCmdline`、commander 退出／输出路由 |
| — | 不发布运行时不变式伴生入口；Loader 结算会报告缺失的服务。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从交接机制逐步进入消费它的应用。

- [dsh-app-boot](../app-boot/README.zh.md)——提供这些启动器值的启动序列。
- [dsh-web-app 组合包](../../bundle/web-app/README.zh.md)——通过此包持有 Web flag 家族的应用。
- [dsh-headless 组合包](../../bundle/headless/README.zh.md)——从命令行读取任务的一次性 runner。

-----

<a id="model-experience"></a>
## 模型体验

无。本包在任何会话存在之前解析进程自身的命令行；配置行持有每一个模型可见的后果。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明应用自有命令行在何时不合适，或何时需要特别注意。它们是当前包约束，不是任务积压。

- **启动器的 flag 必须写在应用参数之前**——切分按位置进行：启动器不认识的第一个 token 就是内层参数的起点，因此写在某个应用 flag 之后的 `--patch` 属于应用。启动器的解析器会消耗掉一个 `--`，因此必须以字面量 `--` 存活到应用的参数需要写成 `-- --`。
- **应用自有服务没有静态声明的提供方**——消费行通过普通注入点名它；缺少提供方的组合包会在结算时失败，由待处理条目点名该服务，而不是在加载时失败。
- **用户 patch 若整体替换某行的 `config`，会连同其中的表达式一起丢掉**——flag 胜过的是表达式旁写着的那个值，而不是用户用字面量替换掉表达式之后的结果；保留表达式才能保留 flag 的优先级。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 待定：解析器表面

`parseCmdline` 是 commander 适配器，而不是命令行框架：help、version 与错误输出遵循 commander 的格式，退出／输出路由也假定 commander 的控制流模型。改用其他解析器需要它自己的路由与错误处理；`cmdlineArgs` 服务约定中没有任何内容依赖 commander。

</details>
