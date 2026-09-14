# Agent Note: 基于端点具名 Remote mock 的整机客户端测试档

Status: implemented

[English](2026-09-06-client-assembly-test-line.md) | 中文

## 问题

浏览器功能 spec 各自手拼测试台：一个裸 Cordis context、`locale`、`connection`、`remote` 的替身，以及本该由真声明者做出的 slot 声明。它们的断言因此描述的是测试台而不是产品：一个插件新增了设置 section、一个声明者经 Loader 重载、一个 Connection 重连，对它们都不可见，而每个测试台都重复着同样的四十行并各有细小漂移。

API 客户端 spec 用一个可编程的 Remote 面假件驱动对象。这个假件重新实现了它本该只是调用的 Gateway 语义：从历史列表推导 follow 流的开场快照、切页、带投递 promise 的流泵，以及一层信封。每一样都是产品已有契约的第二份实现，它还让测试描述出生成客户端做不出来的行为，比如一次会 reject 的一元调用。

没有聚焦源码测试按生产方式起客户端——`bootClient` 按 manifest 每行建一个 Loader entry，再 `mountClient`——插件之间的组合故障会被手工测试台遮住。

## 决定

整机档放在 `@deepseek-ai/dsh-client-test-runtime` 的深 import `src/assembly/` 下，新的 test-support 包 `@deepseek-ai/dsh-remote-mock` 按端点名应答 Remote 流量。两者的用法由各自 README 描述（[client-runtime](../../../../packages/test-support/client-runtime/README.zh.md)、[remote-mock](../../../../packages/test-support/remote-mock/README.zh.md)）；本文记录它们背后的决定。

**roster 从 bundle 现读，绝不拷贝。** `bundleRoster(bundles)` 用 include 插件自己的 YAML 方言（带 `!!js` 的 `entryListSchema`）解析每个 bundle 的 `dsh.bundle.patch`，用它的 `applyEntryPatches` 合成各层，再保留每个未禁用且其包声明 `dsh.client.platform === 'web'` 的行，带上该声明的 `inject` 与 `immediately`。`webApp` 是 `web` profile 的 roster（先 `dsh-base`、再 `dsh-web-app`），import 时算出。spec 点名它要测的东西，其余推导：`webApp.closure([row])` 保留一行及其传递 `inject` 锥；`pick` 与 `without` 留给刻意裁剪。测试运行时仍是 Client 面的包：它不 import 任何 Host 模块，此处不用动态 import，其 client 面的 `types` 在 `client-build-environment` 之外加了 `node`，好让读取器使用 `node:fs`。`closure` 把 shell 静态种入的平台模块（`PLATFORM_MODULES`）视为无需行即已满足。

**生产启动路径只替换 Connection 输入适配。** `TestClient.start(plan, mock)` 加载每个 roster 行的 `/client` 模块，用 `installConnection(ctx, { transport: { rpc: mock.rpc } })` 替换 Connection 行的页面全局适配，经生产模块 facade 的 `pendingQueue` 登记这些工厂，经 `bootClient` 启动，可选经 `mountClient` 挂载，然后等 `connected`。`reload(name)` 经 client-hmr 导出的 `tearDownEntryFiber` 重建一个 Loader entry；`unload(name)` 移除它；`dispose()` 拆掉一切，然后对任何没有规则的端点让测试失败。jsdom 没有 `EventSource` 与 `ResizeObserver`；`start` 只对全局缺失的惰性替身做引用计数。模块系统、Connection 载体、Remote mock、重载和销毁都归实例所有，因此客户端可以并行启动，不通过页面全局变量协调。

modules 插件激活时从自己的 `ctx.loader.internal` 读取模块系统。重载 bootstrap 行会重新发布同一个实例而不让 bootstrap 代码失效，另一个客户端的 Loader 与 `ctx.modules` 不受影响。

**`remote.<ns>` 是无契约代理，不是生成客户端。** `@deepseek-ai/dsh-api-remotes` 行被去掉，因为它生成的客户端只存在于构建后的 `lib/`。对 roster 行注入的每个 `remote.<ns>`，加上 mock 有规则的每个命名空间，本档各提供一个 Proxy：`ctx.remote.<ns>.<method>(...args)` 经 roster 自己的 Connection 用位置参数调用端点 `<ns>/<method>`，mock 为它登记了流脚本就走流、否则走一元。Cordis 把 `ctx.remote.<ns>` 解析到服务 `remote.<ns>`，所以 Gateway 客户端本身不动。一元应答原样返回；一元拒绝按生成客户端折叠载体抛错的方式折叠，经 Gateway 客户端导出的 `carrierFailure` 与 `cancelledFailure`，因此不等待就发出 Remote 调用的产品代码看不到任何 reject。流的项与失败按流吐出的样子直传。

**原生 mock 负责响应配置和调用断言。** 测试通过 `mock.remote.<namespace>.<method>` 使用 `mockResolvedValue`、`mockResolvedValueOnce`、`mockReturnValueOnce` 或 `mockImplementation`，签名由生成的 API 提供。每个 mock 实例独立持有原生响应队列。可复用的表只登记默认值或位置参数 handler，每个端点仅保留最新默认响应。有状态回调和 deferred promise 归各测试所有。`ok` 构造成功信封。流需要显式声明，可提供接收打开参数与句柄（`push`、`end`、`fail`）的脚本；无脚本的声明产生流漏配，未声明端点默认走一元。值不校验。`mock.streams` 控制脚本流并提供打开／排空等待；`mock.log` 记录载体调用（`pending`、`answered`、`failed`）、脚本流状态、首参数 `requests(endpoint?)` 和未匹配请求。`RemoteMock.create()` 为 `$events` 应答 ready 帧，让客户端可以连接。

**Vitest 拥有每条测试的 mock 和客户端生命周期。** `createClientTest(plan, options)` 增加原生 `mock`、`remote` 与 `start` fixture。mock 每次新建并携带默认响应；`remote` 是它的命名空间 Proxy，显式 `start()` 留出配置启动期应答的时机，同一测试共用一个启动 Promise。不需要 Connection 的对象层 spec 直接使用 `remote`；需要 Gateway `$stream` 的用例调用 `start()`。收尾等待启动，即使断言失败也销毁成功创建的客户端、检查漏配，并拒绝后续启动。启动错误由调用方 await 观察。分别拥有多个客户端时仍用 `TestClient.start`。场景数据直接配置原生 mock；返回 mutation 应答与更新后续 describe 应答仍是两个独立操作。

**`remoteDefaultResponses` 是启动期 Remote 端点的默认响应。** 这张表恰好列出 `web` roster 在没有 session、没有 workspace、默认设置下启动并渲染时会打的端点，每行注明调用方。spec 在其上叠加自己的 `RemoteTable`；新的启动期调用会在 `dispose()` 时让 spec 失败。

归应用所有的 built-bundle 测试会在 `AppWebEntry` 启动前通过 `__DSH_TRANSPORT__` 安装一份新的 `RemoteMock`。场景数据留在 `apps/web/tests` 下；生产 Connection 包不包含场景数据集或由 query 选择的测试 transport。需要 Host 行为的浏览器用例使用 `launchWebScaffold()` 和真实 HTTP/WebSocket 路径。

`mock.remote` 使用直接调用方与 Connection 分发共用的原生 `@vitest/spy.fn` 函数。`MockedRemote` 对完整生成的命名空间映射应用 Vitest 深层 mock 类型转换；映射为空时仅这个 Proxy 弱化为 `any`。生产 `Context` 与 Remote 声明保持严格，不需要命名空间专属类型副本或编译器 Flag。[Proxy 类型指引](../../../../packages/test-support/remote-mock/README.zh.md#remote-proxy)要求即使无构建测试通过，本地也必须执行构建后的类型检查。

## 为本档新增的产品导出

- `client/connection`：`ClientTransportHooks.rpc?` 接受由进程内组合持有的已解码载体；`fetch` 可选。`installConnection(ctx, options)` 从实例局部的 transport、recovery 与 location 输入安装同一个生产服务。
- `client/hmr`：`tearDownEntryFiber(entry)` 就是 `reload` 本来执行的 registry 先行的 fiber 拆除。
- `client/modules`：`parseDshClient` 与 `exactPackageSpecifier` 从 client 面导出，由 Host 和 roster 读取器共用。测试工厂使用已有注册队列。roster 行到 boot graph 的合成只有测试消费者，放在本档里。
- `client/web`：`bootClient` 与 `mountClient` 从 `AppWebEntry.run()` 抽出，后者现在调用它们。
- `api/gateway`：导出 `carrierFailure` 与 `cancelledFailure`，让生成客户端的替身折叠得一模一样。

## 考虑过的替代方案

**从构建后的 `lib/` 运行生成的 `/remote` 客户端。** 否决：它让源码面的 spec 依赖构建产物，而代理只需要 mock 已持有的一元或流声明。

**带漂移门禁的生成静态 roster 模块。** 评审后否决：它是测试包内的一份 bundle 数据拷贝，基于它写的每个子集都是会漏行的手列清单。用 include 插件自己的 schema 与补丁应用在 import 时读 bundle，把拷贝、生成器和门禁一起去掉。

**给测试运行时加 Host 编译面、动态 import 一个 Host 模块，或用 vitest `globalSetup` 经 `provide`/`inject` 传 roster。** 否决：Client 测试运行时不得 import Host 代码，动态 import 藏起依赖，配置层通道藏起 roster 的来源。启动器用的合成函数本就面中立，这些都不需要。

**自写一套测试侧的 YAML 与补丁解析器。** 否决：`entryListSchema` 与 `applyEntryPatches` 就是启动器自己的，不带 Host Context 合并；本档只写读文件、定位 package.json 和 web 行过滤。

**用一个 mock 模块替代 Gateway 客户端。** 否决：mock 不得干涉 Gateway 内部；把它传给生产 Connection 安装函数会让重试、折叠与流语义都保持真实。

**在生产 Connection 包中保留由 query 选择的 fixture transport 与场景数据集。** 否决：这会把交付代码耦合到易变的应用测试数据，并让 URL 标记成为隐藏的 transport 选择器。仅客户端的组装测试注入 `RemoteMock`；拥有 Host 行为的浏览器测试使用真实 Host scaffold。

**用 worker 级启动轮次包住页面全局 Connection 载体。** 否决：客户端会共享可变进程状态，每次启动或 Connection 重载都必须串行安装当事客户端的载体。实例局部的 Connection 安装让独立插件树可以并行启动和重载。

**第二套带类型的 Gateway 实现，包含 `Api` 泛型、信封与错误类以及 fixtures 目录。** 否决：它重复 Gateway 声明与编解码。mock 从生成的命名空间映射派生方法类型，运行时只声明一元或流行为。

**代理把一元拒绝原样直传。** 否决：产品代码从不等待 Remote 的 reject，因为生成客户端会折叠载体抛错，于是没匹配的端点造成未处理的拒绝；经导出的辅助函数折叠恢复了客户端的面。

**保留 CallContext，再用适配器包装原生 spy。** 否决：每个测试都要解开合成调用对象，还保留没有业务 spec 消费者的计数／状态机制。位置参数 handler 直接使用现有测试生态。

**独立的 `once` / `sequence` DSL 与回退规则栈。** 否决：按实例持有的原生队列已经能表达消费方使用的延迟响应和临时失败。不可变表声明配合每次登记的游标虽能共享一次性响应表，但当前没有共享表需要它。本档放弃最新登记优先的回退和表级末项重复声明，测试改用原生队列顺序与持续默认响应。响应值和有状态 handler 仍按引用借用，不做克隆。

**独立的预加载模块选项或 `staticModules`。** 否决：现有待注册队列能在 Loader 启动前接收同样的工厂。`staticModules` 绕过工厂物化，也不共享图的预取／失效行为；队列在保留这些行为的同时省掉额外选项。仅装配内部使用的 helper 保留在叶模块，不从推荐入口再导出。

**编译器级全局降级 Flag 或私有类型增补包。** 否决：声明合并会影响同一 TypeScript Program 中能够到达该导入的所有文件；`private: true` 只阻止发布。拆分测试编译图或增加策略检查会增加配置维护成本，却不能把降级限制在真正使用它的 Helper 中。局部条件类型只弱化这些消费方的类型推断。

**为每个命名空间编写方法清单和独立 spy 别名的 Helper。** 否决：它们重复操作名称和原生 mock 已经提供的控制功能。通用 Proxy 从生产命名空间映射派生每个方法，fixture 拥有返回数据，而不再实现另一份领域写入或发布机制。

## 后果

spec 起的是真插件：整个 `web` roster 冷启动约五秒、热启动远低于一秒，三行的锥每例约二十毫秒。断言读的是产品事实——真实的 section 清单、真实的声明者、一次 Loader 重建、重连时的第二代 `$events`——并随产品变化而变化。

代理跳过了生成客户端的 zod 校验、wire 字段名映射与 scoped 身份注入；mock 规则读位置 `args`，生成客户端仍由构建产物 e2e 车道覆盖。插件新增启动期调用时 `remoteDefaultResponses` 必须加一行，加之前会响亮失败。`web` profile 的两个 bundle 名在 `WEB_PROFILE_BUNDLES` 里重复了一次，对应启动器的 `PROFILE_TEMPLATES.web`，且两者之间没有机检联系：客户端测试程序不能 import `@deepseek-ai/dsh-app-boot`（其 Host `Context` 合并与 Client 的冲突），而测试运行时连测试也不引入 Host 依赖。模板变更因此要靠人工带到这个常量。

共享函数让生产和测试调用方使用同一份实现。`AppWebEntry.run()` 在立即层预取落定后挂载 Loader；应用 entry 仍在预取之后创建，因此让 Loader 安装与预取串行不会提前应用激活。

原生流覆盖可以返回自有 iterable，此时调用方负责消费与取消，这些 iterable 不参与脚本流日志或控制。已登记的脚本仍使用受控队列与取消机制。这一区分保留原生 mock 行为，无需再添加 iterator 包装器或改变拉取时机。

## 遗留事项

本档暴露出来、原样保留的产品事实：

- 没有任何 `declare module` 增强声明 `Context.connection`；消费方一律 `ctx.get('connection') as ConnectionHandle`，`TestClient.connection` 是本档提供的带类型入口。
- `TestClient.start` 没有页面 URL 选项，需要 `connection` 插件把页面判为 off-loopback 的 spec 只能重配 vitest 挂在 `globalThis.jsdom` 上的 jsdom 实例，这是 jsdom 环境提供者的私有细节。
- `ISessions` 没有 queue 观察点，queue 帧只能直接经 `handleControlFrame` 到达 `Session`，而不是走 `session/control` 流。
- 同 seq 的 durable 事件二次推送在 `RemoteJournalStream` 尾部被当作重放丢弃，到不了 `SessionQueueMirror.acceptDurable`。
- vendored Loader 在模块 import 失败时让 `create()` reject，因此 `assertEntriesActive` 的 import 失败分支经 `create()` 不可达。
- session-controller 客户端把 `ctx.remote` cast 成 `SessionRemotes`；在客户端测试程序里这个 cast 是多余的，因为生成的 `/remote` 合并在那里可见。

## 测试

`packages/test-support/remote-mock/tests/` 覆盖规则、流、日志与载体面；`packages/test-support/client-runtime/tests/` 下的 `assembly-` 系列 spec 覆盖在真 bundle 与临时安装上的 roster 读取器、模块加载、含折叠的代理、并行客户端启动、实例局部的模块与 Connection 重载，以及 jsdom 与纯 Node 下的 `TestClient`。`apps/web/tests/` 下归应用所有的 built-client spec 注入一份新的 RemoteMock，并将有状态场景数据留在这些 spec 旁边。`packages/client/ui-settings-general/tests/` 下，shell 与 apply 两条起整个 `web` roster；apply 从 mock 应答的 Host settings 文档读它的中文文案，并为 off-loopback 分支重配 jsdom 页面 URL。`packages/client/ui-message-feedback/tests/` 下，对象层 spec 直接传入 RemoteMock 的 `messageFeedback` 命名空间。`packages/api/session-controller/tests/` 下，Session、queue-store、pending-submission、projection tail-page、sessions-service 以及验证流的 manager 用例启动 Gateway 依赖锥；其余 manager 用例与 projection-store 的 manager-routing 用例直接使用同一组逐测试 Remote fixture，不启动客户端；client-apply 则启动插件的依赖锥，把 Remote 事件作为 `$events` 上的 emit 帧投递。`packages/api/workspace-controller/tests/` 下，transport 的 apply 用例起插件锥、手工构造流与 controller 的用例起 gateway 锥，因为进了 roster 的插件会共用 follow 端点。每个包在 `tests/remote/` 保有自己的默认响应与帧构造。fixture 测试包含预期的断言失败，并独立观察客户端清理完成；settings 重载测试观察注册身份被替换，写入测试断言全部 mutation 参数。teardown 失败测试先执行真实树清理，再报告注入的失败，并观察 `$events` 流的取消状态。
