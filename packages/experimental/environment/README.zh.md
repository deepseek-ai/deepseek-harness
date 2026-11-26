---
description: "在提供方提供的执行环境中运行自包含函数，并通过类型化回调调用发起端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-environment

[English](README.md) | 中文

## 概述

在选定的执行环境中运行工具的文件和进程操作，同时将状态和结果格式化保留在发起端 dsh 中。提供方提供稳定的句柄、显示名称和传输方式；注册表在所有传输方式上使用同一套函数协议。SSH、SSH 配置发现和本地提供方可分别使用。函数可使用文件系统和进程 API，以及调用发起端的类型化回调。此能力为实验性功能，需要显式组合；现有工具继续使用各自当前的执行提供方。

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

挂载注册表及一个或多个提供方，然后为每个函数定义一次，并以由提供方管理的句柄运行它。环境句柄是不透明标识符；显示名称是面向用户的标签，可以重复。

### 配置

```yaml
- name: '@deepseek-ai/dsh-environment'
- name: '@deepseek-ai/dsh-environment-ssh'
  config:
    handle: ssh-build
    displayName: Build machine
    host: build-box
```

无依赖的 `lib/daemon.js` 打包文件通过 `./daemon.js` 导出，需要 Node `^24.22.3 || >=26.13.1`。[单目标 SSH 提供方](../environment-ssh/README.zh.md)默认在远程 `~/.cache/dsh/environment/daemon.js` 安装缺失或较旧的守护进程；可选的 `daemonPath` 可指定其他绝对路径。校验和替换规则见该提供方文档。[SSH 配置提供方](../environment-ssh-config/README.zh.md)和[本地提供方](../environment-local/README.zh.md)各自独立提供环境。

| 注册表字段 | 默认值 | 含义 |
|---|---|---|
| `maxFrameBytes` | 1 MiB | 单帧的大小上限；更大的消息分成多个帧传输，并与其他消息的帧交错 |
| `maxMessageBytes` | 64 MiB | 编码后单条消息的大小上限，消息可以是一次运行的源码、参数和方法名称，该运行的结果，或单次发起端调用或其结果；也限制 `exec` 输出 |
| `maxPending` | 64 | 每个连接中未完成运行和未完成发起端调用各自的数量上限；一个连接的运行最多占用这么多个守护进程 worker 线程 |
| `cancelGraceMs` | 10000 | 取消运行后等待应答的时限，超时则关闭连接；取消后超过该时长一半仍未停止的运行会被守护进程终止 |
| `killGraceMs` | 2000 | 对剩余执行进程组发送 SIGTERM 后，等待发送 SIGKILL 的时间 |
| `connectTimeoutMs` | 30000 | 连接和握手的时限，不计人工信任确认耗时 |

两个字节上限均不得小于 1024，且 `maxFrameBytes` 不得大于 `maxMessageBytes`。完整字段参考见生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-environment)。

### 注册表与执行

提供方通过 `ctx.effect(() => ctx.environments.register(info, transport))` 将 `{ handle, displayName }` 与 `EnvironmentTransport` 一同注册。`ctx.environments.handle(value)` 接受非空标识符，不解析其格式。句柄重复会失败；显示名称无需唯一。`list()` 返回公开元数据的快照，`get(handle)` 返回当前注册项的元数据。连接细节由提供方保管。

不带载荷的 `environments/change` 事件在每次注册和每次实际生效的注销时各触发一次，触发时 `list()` 和 `get(handle)` 已反映该变化。展示环境的消费方（例如主机选择器）在该事件触发时重新读取 `list()`。监听器同步运行，可以注册或运行环境；监听器失败会被记录日志，且不会撤销该变化。

`ctx.environments.define(fn, options)` 绑定函数、其结果校验和发起端处理函数，并返回 `EnvironmentRunner`。发起端方法名称是定义时 `options.handlers` 的自有属性名；之后添加到该对象上的名称不会成为发起端方法，对这些名称的调用也不会得到处理，而每次发起端调用都在到达时从该对象上查找其处理函数。使用环境句柄、参数和 `{ signal }` 调用该运行器时，函数在该环境中最多运行一次。定义时不与任何环境通信，也不要求环境已注册，因此插件加载时创建的定义可用于之后在任意环境中的每次调用。注册表为每个注册项复用一个连接，并独立连接不同环境。注销提供方会移除其元数据并关闭连接。同一定义之后以同一句柄进行的调用会解析到该句柄的新注册项；已在进行的运行不会切换到替代注册项。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-environment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

export const inject = ['environments', 'tools']

export function apply(ctx: Context): void {
  const readPaths = new Set<string>()
  const readFile = ctx.environments.define(async ({ path }: { path: string }, env) => {
    const text = await env.fs.readFile(path, 'utf8')
    const first = await env.origin.markRead(path)
    return { text, first }
  }, {
    result: z.object({ text: z.string(), first: z.boolean() }),
    handlers: {
      markRead: (path: string) => {
        const first = !readPaths.has(path)
        readPaths.add(path)
        return first
      },
    },
  })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'read_environment',
    description: 'Read a file in the build environment.',
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, first: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: (args, exec) => readFile(ctx.environments.handle('ssh-build'), { path: args.path }, { signal: exec.signal }),
  })))
}
```

注册表和处理函数在发起端 dsh 进程中运行。只有函数源码和处理函数名称（由 `define` 读取一次并计算哈希）以及每次调用的参数会传到执行进程。`EnvironmentContext` 提供该进程的 `fs`、`path`、`cwd`、`platform`、不经 shell 的 `exec`、`signal`、`limits` 和 `origin`。函数只能引用自身参数、`EnvironmentContext` 和其 `node:vm` 上下文中的全局变量。每次运行都在 worker 线程中获得全新的上下文，其中没有 `require`、`import` 或 `process`；除 JavaScript 内置对象外，上下文还提供 `setTimeout`、`clearTimeout`、`setInterval`、`clearInterval`、`queueMicrotask`、`Buffer`、`TextEncoder`、`TextDecoder`、`URL`、`URLSearchParams`、`structuredClone`、`AbortController`、`AbortSignal`、`atob`、`btoa` 和 `performance`。这些实用 API、函数的参数和 `env` 返回的值都来自 worker 的 realm，因此用该上下文自身的内置对象（如 `Uint8Array`）对这些对象执行 `instanceof` 检查时，结果可能为 false。一个 worker 每次只执行一个运行，同一 worker 上的所有运行共享相同的 worker realm 对象，例如 `Buffer`、`URL`、`env.fs` 和 `env.path`；函数若修改这些对象（例如为其属性赋值），该修改会影响该 worker 之后的运行。运行通过 `setTimeout`、`setInterval` 或 `AbortSignal.timeout` 启动、且在运行结束时仍未触发的定时器不会再触发。上下文还为 esbuild 的 `keepNames` 提供空操作 `__name`；其他生成的辅助函数必须自包含。

函数第一个参数的类型决定每次调用接受的参数；接口与类型字面量同样适用，未标注类型的参数接受任意 `EnvironmentValue`。`env.origin` 的自有方法来自所属定义的 `handlers`，这些处理函数供每次调用使用，并且只接收函数发送的参数。因此，属于单次调用的发起端状态（例如某次工具调用的后台任务）需要专为该次调用创建的定义；为每次调用分别定义时，定义操作只读取处理函数名称，并对函数源码连同这些名称计算哈希，源码和处理函数名称都相同且名称顺序一致的定义共用连接中的定义缓存。这些方法的参数类型和 `await` 后的结果类型会自动推导；方法可脱离对象调用，无需接收者。请为内联处理函数的每个参数标注类型，使用 `signal` 时也须标注 `signal: AbortSignal`，以便 TypeScript 在检查函数前推导处理函数类型。TypeScript 允许标注返回 `void` 的函数返回被丢弃的值，因此其调用结果类型为 `EnvironmentValue`。接收不可信输入的处理函数应接受 `unknown` 并自行校验。

参数、结果、发起端参数和发起端结果都是 `EnvironmentValue`，在连接上以及执行进程的线程之间通过结构化克隆复制。除普通对象、数组和非 symbol 的原始值外，它们还可以包含 `Uint8Array` 及其他类型化数组、`undefined`、`Date`、`RegExp`、`Map`、`Set`、`bigint` 和错误；错误只保留消息、堆栈、cause 以及 `TypeError` 之类的标准名称。类实例到达时变为普通对象，`Buffer` 到达时变为 `Uint8Array`。省略的参数和 `undefined` 结果保持为 `undefined`。结构化克隆无法复制的值（例如函数）会使其所在消息在发送任何内容之前失败：若是参数，调用以 `ENVIRONMENT_REQUEST_REFUSED` 失败；若是结果，调用以 `ENVIRONMENT_RUN_FAILED` 失败；若是发起端参数或处理函数结果，该发起端调用会在函数内被拒绝。

每条编码后的消息都必须在 `maxMessageBytes` 以内；更大的消息会在发送前被拒绝，失败方式与无法复制的值相同，连接保持打开。调用方把更大的数据拆分到多次运行或多次发起端调用中：`ctx.environments.limits.maxMessageBytes` 向调用方报告该上限，`env.limits.maxMessageBytes` 向函数报告该上限。二进制数据按字节长度计算；字符串每个 UTF-16 码元最多计两个字节。注册表会把大于 `maxFrameBytes` 的消息拆成多个帧发送，因此调用方无需处理帧。

### 取消与失败

中止某次调用的信号会立即中止该次调用中的发起端处理函数，并向执行进程发送取消请求，执行进程会中止函数的上下文信号，并终止其 `exec` 进程组。函数返回或抛出异常时，会中止其上下文信号、结束剩余发起端调用，并终止剩余的 `exec` 进程组。已完成的副作用不会回滚。如果被取消的函数在 `cancelGraceMs` 的一半时间内仍未停止，执行进程会终止其 worker 线程并应答该取消请求，因此连接及其上的其他运行可以继续。未在 `cancelGraceMs` 内应答取消请求的守护进程会失去连接。

`exec` 返回退出码、信号、stdout 和 stderr，包括非零退出的情况。输出超过 `maxMessageBytes` 会使操作拒绝，运行的结果也必须在该上限以内。每次调用都通过所属定义的 `result` 校验返回值。`EnvironmentError` 错误码区分环境不可达、断连后结果未知、请求被拒绝、执行失败、结果无效和注册表已销毁等情况。发送前丢失的连接会重连一次；已发送的运行不会重放。提供方的 `HarnessError` 会原样传递。调用时传入的 `confirm` 选项允许等待中的调用方回答传输方式的信任确认问题；确认耗时不计入连接时限。

函数抛出异常时，运行以 `ENVIRONMENT_RUN_FAILED` 失败，错误消息取自所抛出错误的消息，`remote` 保存该错误的 `name`、`message` 和字符串 `code`，例如 `ENOENT` 这类 errno 名称或某个 `HarnessError` 错误码。如果 worker 线程在运行期间失败或退出，或者守护进程无法发送结果，`remote` 改为报告这一失败。处理函数抛出异常的发起端调用会在函数内被拒绝，所带错误包含处理函数错误的 `name`、`message` 和 `code`。

### 执行守护进程

独立构建产物以 `// dsh-environment-daemon ` 开头，后接包含 `version`、`protocol` 和 `node` 字段的 JSON，分别取自环境包版本、协议常量和仓库的 Node 引擎版本范围。提供方无需执行守护进程即可检查首行；SSH 提供方还会校验整个打包文件的 SHA-256 摘要。

`node daemon.js serve --stdio` 通过标准输入输出服务一个连接。入口仅接受 `serve --stdio`，可选参数为 `--auth-timeout-ms`。SSH 和本地提供方均为每个新连接启动全新的守护进程；复用活跃通道时保留同一进程。守护进程没有常驻监听器，也不在连接之间共享状态。

守护进程在 worker 线程池上运行每个连接的函数。一次运行占用一个 worker，并在运行结束时归还，线程池因而增长到该连接的峰值并发数，该并发数受 `maxPending` 限制；被终止的 worker 在退出之前仍计入线程池，这可能使线程池短暂地超出这一上限。关闭连接会结束所有 worker。因此，阻塞自身线程的函数不会延迟其他运行。没有任何代码捕获的异常（例如在定时器回调中抛出的异常）会使其 worker 正在执行的运行失败，如果已结束的运行在该 worker 上留下了待执行的代码，失败的可能是之后的某次运行；在两次运行之间，worker 会把这类异常报告到守护进程的标准错误，并继续服务。在运行期间失败或退出的 worker 只会使该运行失败，随后被停用；找不到空闲 worker 的运行会启动新的 worker。`exec`、其进程组清理和发起端调用都留在守护进程的主线程上。守护进程会丢弃 worker 写入 `process.stdout` 的内容，因为守护进程的标准输出承载协议；直接写入文件描述符 1 的代码（例如通过 `/dev/stdout`）会破坏连接。

每次运行都以 `[source, methods]` 经 JSON 编码后的 SHA-256 哈希指明其定义，定义由函数源码及其发起端方法名称组成；因此，源码相同但处理函数名称不同时，定义也不同。注册表在一个连接的运行中附带定义，直到守护进程应答其中一次运行；守护进程校验收到的每个定义的哈希，将定义保留到连接关闭，并拒绝指明未知哈希的运行。每个 worker 对一个定义的源码只编译一次，并在每次运行时于全新的上下文中对其求值。新连接（包括守护进程退出后打开的连接）会重新接收每个定义。

`transport` 认证机制信任提供方提供的通道。SSH 验证用户和目标机器；本地提供方管理子进程及其管道。调用方必须信任提供方、守护进程文件和执行机器。网络传输必须先认证其通道，才能使用此机制。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

提供方负责发现环境、启动和停止守护进程，以及任何维持执行进程存活的机制。注册表负责元数据、连接缓存和通用的对称请求通信端。每个连接均在接受运行前完成认证。每次运行发送定义哈希、定义（仅在连接尚未持有时）和参数；定义包含函数源码及其发起端方法名称，执行进程将这些方法构造为 RPC 调用。在执行进程内部，值通过 `postMessage` 结构化克隆在主线程与 worker 之间传递，错误则以其 `name`、`message` 和字符串 `code` 传递。发起端处理函数同时受其运行及该运行所属连接的作用域约束。

每个帧由 4 字节大端长度和其后的 `node:v8` 编码组成，解码后再校验。编码超过 `maxFrameBytes` 的请求、结果或错误以多个 `part` 帧传输，每帧携带其请求 id、方向、总大小和一段切片。除消息的最后一段外，每一段携带的数据至少为 1024 字节减去 `part` 帧自身字段所占的字节数。发送方在前一段写出后才将下一段排入队列，因此其他消息的帧会与之交错；接收方按 `maxMessageBytes` 检查总大小，并解码重组后的消息。通信端同时分段发送的消息，大小之和不超过 `maxMessageBytes`；更多的消息按顺序等待，直到之前的消息腾出额度，而单帧即可容纳的消息从不因额度而等待，只排在每条正在传输的消息的一个分段之后。接收方保留的仅部分接收的消息总计不超过 `maxMessageBytes`，对端若同时发送更多，接收方会关闭连接。错误帧携带所抛出错误的 `name`、`message` 和字符串 `code`。

请求使用各通信端独立的标识符和取消计数。取消请求会停止发送其剩余分段，并保留其待处理名额直到对端应答。收到取消的对端会丢弃仅部分接收的请求并以错误应答，或者停止发送其应答的剩余分段并改为报告取消；请求方会丢弃该应答的分段。关闭连接会丢弃所有仅部分接收的消息。无效帧、待处理数量超限或流断连会关闭通信端，并拒绝其待处理工作。无法编码或超过 `maxMessageBytes` 的结果会使对应请求明确失败。新连接启动独立的守护进程；注册表不会重放已发送的运行。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 注册表元数据、定义、连接和发起端调用分发 |
| [`src/types.ts`](src/types.ts) | 执行上下文与传输接口 |
| [`src/handle.ts`](src/handle.ts) | 由提供方管理的品牌类型句柄 |
| [`src/protocol.ts`](src/protocol.ts) | 对称请求通信端、帧拆分和校验 |
| [`src/daemon.ts`](src/daemon.ts) | worker 线程池、定义缓存、`exec` 和进程清理 |
| [`src/worker-loop.ts`](src/worker-loop.ts) | worker 线程内的运行求值、定时器和基础实用 API |
| [`src/daemon-entry.ts`](src/daemon-entry.ts) | 单个 stdio 连接与守护进程选项 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [执行环境子系统](../../../docs/subsystems/environment.zh.md) — 公共服务参考。
- [SSH 提供方](../environment-ssh/README.zh.md) — 单个配置的目标机器。
- [SSH 配置提供方](../environment-ssh-config/README.zh.md) — 具体的 OpenSSH 别名。
- [本地提供方](../environment-local/README.zh.md) — 受管理的本地执行进程。
- [SSH 文件系统与进程提供方](../../ssh/README.zh.md) — 替换整个 Session 的执行提供方。

-----

<a id="model-experience"></a>
## 模型体验

通过调用已定义函数的工具间接影响模型；这些工具负责模型 schema、渲染输出和日志结果。本包不增加提示词段落、模型工具或 Session 事件。

#### KV 缓存影响

无；本包不组装或发送模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **执行进程不是沙箱。** `node:vm` 隔离全局对象，但仍具有执行进程的文件系统和进程权限。直接使用 `fs` 和 `exec` 不会应用发起端 Session 的沙箱策略，本地提供方也如此。
- **尚无随产品交付的工具或配置使用此能力。** 现有工具继续使用各自当前的文件系统和子进程服务。
- **没有远程进程监管器。** 守护进程使用 Node 标准库 API，只有在观察到连接关闭后才会结束其 worker 和 `exec` 进程组。如果 SSH 没有把网络故障报告给远程守护进程，它们会继续运行；被 `SIGKILL` 终止的守护进程会留下仍在运行的 `exec` 进程组。
- **帧使用 `node:v8` 序列化格式。** Node 24 和 26 写入相同的格式版本；如果某个对端运行更新的 Node 版本，且另一端无法读取其格式，连接会因帧无法解码的错误而失败。
- **分段消息按顺序发送。** 大小接近 `maxMessageBytes` 的消息会使同一方向上之后所有单帧容纳不下的消息等待，直到该消息发送完毕。
- **定义按连接缓存。** 每个新连接都会重新接收每个定义，其守护进程会保留收到的每个定义，直到连接关闭。没有连接心跳。调用方为停滞的工作提供取消信号；已完成的副作用不会回滚。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

协议测试通过 stdio 直接使用 Node 启动仅含可擦除类型语法的守护进程源码。发布路径冒烟测试启动构建后的独立 `lib/daemon.js` 包。Vitest 覆盖率统计观察不到 worker 线程，因此 `tests/worker-loop.spec.ts` 在测试进程中通过 `MessageChannel` 运行 `runWorker`，守护进程测试和组合测试则使用真实的 worker。

</details>
