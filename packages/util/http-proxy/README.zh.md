---
description: "Harness 的出站 HTTP 代理支持：从启动环境解析出的一份策略，如何覆盖到 Node fetch 本来会直连的每一个请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-http-proxy

[English](README.md) | 中文

## 概述

Node 内置的 `fetch` 会忽略 `HTTP_PROXY` 与 `HTTPS_PROXY`，因此在代理后面运行的 Harness 无论用户导出了什么都会直连——LLM（大语言模型）请求、每次 web 搜索、走 HTTP 的 MCP 与沙箱 SDK 一概如此。本包从启动器的环境快照解析出一份代理策略，并把它装成 undici 的全局 dispatcher，而这正是 `fetch` 解析的对象。因此普通调用点无需改动、也无需引入本包：写 `fetch()` 就已经走代理。全局 dispatcher 自身够不到的场合由四个函数覆盖——安装策略、询问某个请求怎么发、把策略交给派生的子进程、以及为重放清掉它。

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

无需挂载，也无需配置。`dsh` 启动器会在第一个插件加载之前，为每个 profile 解析并安装策略，因此导出了 `HTTPS_PROXY` 的用户在所有位置都会走代理。本包是库而非插件，因为传输策略每个进程只有一个答案：没有第二个实现可替换，也没有比进程更窄的作用域可赋予。

### 编写新的出站调用

普通 `fetch()` 已经走代理，任何最终落到 `globalThis.fetch` 的 SDK 也一样——MCP HTTP 传输与 pi-ai 提供方栈都是如此。不要对任何 SDK 想当然，去查。

| 你要写的东西 | 使用 |
|---|---|
| 普通请求，或最终落到 `globalThis.fetch` 的 SDK | 什么都不用——全局 dispatcher 已经在路由它 |
| 需要按“这次请求是否走代理”分支的调用 | `proxyRouteFor(url)` |
| 接受自有代理 URL 的 SDK | `proxyRouteFor(url)`，把 `route.proxy` 传进去 |
| 由你自己构造环境的派生进程 | 把 `proxyEnvironmentForChild()` 应用到它上面（`undefined` 表示删除） |
| 必须连到自带 fixture 服务器的测试框架 | 把 `clearedProxyEnv()` 应用到该派生进程 |

`proxyRouteFor` 给出的不只是答案，还有该答案所假定的传输：走代理的那一支携带着此刻正按该策略路由的 dispatcher。若调用方先读策略、再自建传输，卸载就可能落在两次读取之间，把请求发往其分支从未放行的去处。

自建传输的 SDK 接触不到上述任何一条，而本仓库随附的 SDK 里有两个如此。E2B 接受自有代理 URL，现在接收 `route.proxy`。OTLP 遥测导出器通过 `node:http` 投递，被有意保留为直连——见下方限制一节。

构造 `new Agent(...)` 再作为 `dispatcher` 传入会覆盖全局 dispatcher，从而静默绕开代理。`verify-no-bare-dispatcher` 会在本包之外拒绝该写法。有一处调用点确实自有传输——`web-fetch-http` 会把请求钉在它已校验过的地址上，而这是进程级 dispatcher 无法承载的单次请求状态——它在该行用 `proxy-exempt:` 注释说明。

该门禁看不进 SDK 内部，因此仓库中每一个出网点都另有一份 `egress.spec.ts`：它驱动该点的真实代码路径穿过一个假代理，并断言代理确实收到了请求——遥测那份则断言代理什么也没收到。新增出网点就补一份。它是唯一能双向发现 SDK 在我们脚下更换传输的手段：OTLP 与 E2B 这两个漏洞正是这样被发现的，而某次升级若开始静默地把遥测送去代理，也由它拦下。

### 策略读取哪些值

`http_proxy`、`https_proxy`、`no_proxy` 与 `all_proxy`，小写优先、大写兜底，空值视为未设置。`ALL_PROXY` 为两种协议兜底，HTTPS 最后回退到 HTTP 代理——其中第一条 Node 与 undici 都不会自行推导。取值来自启动器的快照：先看导出的环境变量，再看 `$DSH_HOME/.env`。项目自己的 `.env` 不能携带这些名字——那个文件随 clone 一起到来，启动器宁可拒绝启动，也不让一个仓库决定 Harness 把流量发往何处。

loopback 始终被绕过——`localhost`、整个 `127.0.0.0/8` 段、`::1`、`0.0.0.0`，以及它们的 IPv4 映射写法。否则 Harness 自己的 Web UI、Connection 传输以及每一个本地测试服务器都会经由代理并形成回环。发布出去的绕过列表只包含读取环境的消费者能匹配的四个字面量条目；`proxyForUrl` 自行识别整个网段，因为列表条目无法表达一个范围。

### 失败处理

本包无法使用的代理值——SOCKS 或 PAC URL、无法解析的字符串、不受支持的协议——会被报告并跳过，该 scheme 转为直连。该变量可能是用户为其他工具导出的，不应因此阻止 agent 启动。

-----

<a id="understand-the-implementation"></a>
## 理解实现

### 设计理念

**一次解析，一个匹配器。** `proxyForUrl()` 与已安装的 dispatcher 绝不能对同一个 URL 给出不同答案，否则 `dsh-web-fetch-http` 会把 dispatcher 本打算隧道转发的连接固定到某个地址上。因此该 dispatcher 是一个 `Agent`，其按 origin 调用的 `factory` 自身调用 `proxyForUrl()`，不存在可能与第一个解析器产生漂移的第二个解析器。undici 的 `EnvHttpProxyAgent` 在此无法胜任：没有 `HTTPS_PROXY` 时它让 `https:` 复用 HTTP 代理，于是本包在拒绝用户为该 scheme 指定的 URL 后本应保持直连的 scheme 仍会被隧道转发。

**子进程继承用户自己的值，以及用户未设置部分的解析结果。** 用户以任一大小写指定过的 scheme，会以他们书写的形式原样传给子进程，因此用户为 `curl` 设置的 SOCKS 代理绝不会被替换成为其他 scheme 指定的 HTTP 代理。两种大小写都未指定的 scheme 则携带解析值，否则子进程的路由会与父进程分歧：Node 的 `NODE_USE_ENV_PROXY` 不读 `ALL_PROXY`。绕过列表始终采用解析结果——它只会追加 loopback 条目，用户写下的内容不会丢失。让父子进程只有一个路由答案的代价是：`curl` 也会看到本包由 HTTP 代理推导出的 `https:` 代理。有一处例外是为了保护子进程自身：当子进程收到的某个值是本包拒绝过的——比如为 `curl` 保留的 SOCKS URL——就不再设置 `NODE_USE_ENV_PROXY`，因为 Node 在该标志下会在运行程序之前先解析 `HTTP_PROXY` 与 `HTTPS_PROXY`，遇到这类值直接退出。此时子 Node 直连（本进程已为该协议如此报告），而不是根本起不来。

### 源码地图

| 文件 | 承载 |
|---|---|
| `src/policy.ts` | 解析与绕过匹配；诊断只点名变量，从不带出它的值。不引入任何传输实现，因此在没有 undici 的环境中仍可加载。 |
| `src/install.ts` | 全局 dispatcher、生效策略记录、路由与子进程环境。动态引入 undici。 |
| `src/index.ts` | 本包的对外面：四个函数与一个类型。 |

### 绕过匹配

一个条目写的是主机名，它连同其下所有子域名一起匹配：`NO_PROXY=example.com` 也会放行 `api.example.com`。前缀 `.` 或 `*.` 可以写，含义相同。条目可带 `:port`，`*` 则放行全部。带方括号与裸写的 IPv6 字面量都能匹配——裸写的 `::1` **不会**被读成主机 `:` 端口 `1`，而 undici 自带的匹配器正是这样出错的，这也是解析结果中同时携带 `::1` 与 `[::1]` 的原因。CIDR 不参与匹配：操作系统的绕过列表常含 `10.0.0.0/8`，必须改写成后缀形式。

-----

<a id="further-exploration"></a>
## 进一步探索

- [网络代理指南](../../../docs/user/guide/network-proxy.zh.md)——需要导出什么，以及为什么浏览器走代理而终端不走。
- [`dsh-web-fetch-http`](../../web/web-fetch-http/README.zh.md)——唯一一个安全规则会因代理而改变的消费方。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只承担传输策略：它改变字节如何抵达网络，不注册任何提示词、schema 或结果文本。

#### KV Cache 影响

不会直接失效：本包不贡献任何请求 token，也从不改变请求前缀，因此提供方缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了本包不适用的场景，属于当前的包级约束。

- **不支持 SOCKS、PAC 或操作系统代理探测**——只接受来自环境的 `http(s)://` 代理 URL。不会读取 macOS 或 Windows 的系统代理设置，因此仅在代理软件里拨了开关的用户仍须导出环境变量；SOCKS URL 会被报告，且该协议保持直连，不会借用另一协议的代理。
- **不支持自定义证书颁发机构**——做 TLS 拦截的企业代理需要在启动前为进程设置 `NODE_EXTRA_CA_CERTS`，本包既不设置也不校验它。
- **派生的子进程只在足够新的运行时上遵循策略，且仅当它继承的每个值都是 Node 接受的**——它通过 Node 的 `NODE_USE_ENV_PROXY` 读取已发布的环境（22.21+、24+），而 engines 范围允许 22.19 与 22.20，在这两个版本上这样的子进程保持直连。若用户环境里还有 SOCKS 或其他被拒的代理，所有子 Node 都保持直连：标志被扣下，子进程才起得来。子进程还会按 Node 自己的 `NO_PROXY` 规则匹配绕过条目，其分隔符与 IPv4 区间处理与本包不同。本进程内不依赖任何 Node 版本：每一次进程内请求都会落到全局 dispatcher。
- **遥测按设计直连**——OTLP 导出器通过 `node:http` 投递，全局 dispatcher 触及不到。要让它走代理，要么依赖 `http.Agent` 的 `proxyEnv`，而该选项晚于本项目支持的最低 Node 版本；要么改用 SDK 的 `fetch` 传输，但它没有压缩能力，而随附配置启用了 gzip。遥测是唯一一条丢失了对用户毫无代价的通道，因此维持原状；`DSH_TELEMETRY_MODE=DISABLED` 可关闭它。
- **执行模型编写代码的 worker 完全不获得代理**——`code-runtime` worker 与 `workflow` worker 都不接收代理配置，它们自身的请求直连。代理 URL 可能携带 `user:password`，而两者运行的都是模型写的脚本。
- **防回归门禁只看源码，看不到依赖内部**——`verify-no-bare-dispatcher` 解析 `packages/*/*/src` 与 `apps/*/src`；测试、脚本以及第三方 SDK 的内部都在其之外。这正是每个出网点还各配一份 `egress.spec.ts` 的原因。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

userland undici 能触及 Node 内置的 `fetch`，依赖的是两者都会写入 legacy 的 `Symbol.for('undici.globalDispatcher.1')` 槽位。那是跨版本的隐式耦合，不是约定——参见 [corepack#834](https://github.com/nodejs/corepack/issues/834) 中它失效的实例。`tests/install.spec.ts` 断言真实请求会抵达一个 loopback 代理，因此破坏该耦合的版本升级会在那里失败，而不是流到线上。

</details>

**运行时不变量：** 不发布伴生入口。本包唯一的可变状态——生效中的策略——由单元测试对照它所安装的 dispatcher 断言：测试会释放注册并观察一个真实的 loopback 代理。
