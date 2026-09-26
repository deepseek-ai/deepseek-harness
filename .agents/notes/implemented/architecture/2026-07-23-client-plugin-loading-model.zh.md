# Agent Note: client 插件装载——惰性 factory、Cordis 生命周期与热重载

Status: implemented

[English](2026-07-23-client-plugin-loading-model.md) | 中文

> 范围：浏览器侧插件装载机件——代码如何到达、Cordis 如何治理代码，以及热重载如何搭乘这套模型。本 Note 拥有装载链；[client 外壳分层 Note](2026-08-15-client-shells-and-dynamic-packages.zh.md)拥有包分类、构建 face、共享模块请求与 npm 依赖声明，[Web 客户端架构笔记](2026-07-19-gui-web-client-architecture.zh.md)则拥有 slot 与数据对象层。

## Problem

host 侧，cordis 插件装载站在 Node 的模块机制之上——require cache 与内部 ESM loader 拥有模块身份与字节。vendored `@cordisjs/plugin-loader` 在这层基座之上实现插件治理与热重载，二者在唯一一道边界相接：`Loader.internal`。

浏览器客户端跑同一套 cordis 插件机制，因此底下需要同样的基座——而浏览器没有 Node 模块系统。

常规前端工程在构建期消化全部依赖：单一 bundle，external 由打包器解决，运行时无物可管。在此之上再做运行时模块管理，正是这里的特殊需求。client 因此拆成两层：上层是经同一份 vendored Loader 的 cordis 插件装载，下层是模块粒度的依赖管理——`dsh-client-modules`。

下层供给四项能力：external（平台清单）、远程到达（同源外部 classic script 加惰性工厂登记）、不可变的版本化交付、热更新（invalidate/prefetch）。

插件 bundle 独立构建在 Vite 模块图之外。若把响应文本塞进内联 script，浏览器只能看到一次动态源码执行：网络资源、生成 bundle、TypeScript/TSX 源码之间没有标准 sourcemap 链，性能 profile 与 stack 只能落到生成后的 `client.js`；模块系统还要持有整份源码文本，并把同一项到达职责拆成 fetch 与 execute 两道传输边界。

在此之上，client 与 host 插件以一致的方式注册与装载：包声明一次 `dsh.client`，host 把声明扫描进 boot 图，同一套 Loader 语义在两侧治理 entry。

第一代 client loader（`createClientLoader`）把这两层手写进了同一个函数。这一融合留下的是：没有卸载/重载路径（装载一次性，style 标签从不移除）、在三个文件间人肉抄写且早已漂移的依赖清单、一条供跨插件 import 走的模块表后门——既复制了 cordis 的服务机制，又把装载顺序变成正确性约束。下文的结构取代了它。

## Decision

### 包成员与模块请求

[Client 外壳分层 Note](2026-08-15-client-shells-and-dynamic-packages.zh.md)定义当前的静态、动态包集合及其 import 规则。装载机件把每个 `dsh.client` 包视为一个 host graph row；每个包都有一个普通 `lib/client.js` factory bundle，还可有编译器生成的 `lib/client.<name>.js` chunk。包声明携带 Cordis `inject` 边、同步模块表 `external` 请求，以及可选的 `immediately` 预取标记；负责组合的 app 只拥有挂载名册。

Web 内核保持不依赖框架，也不 import 任何动态包实体。Modules 本身是动态图 row，但 host parser 会在 Vite 主模块前送达其 factory。内核调用 `create()` 时，由 HTML 安装的 `__ModuleLoader__` facade 使用该 factory 构造模块系统。其他每个动态图 row 都归属一个 application combo 脚本；React、Cordis 与静态 UI 库的身份由外壳 seed 提供。

### 一套模块系统，一个插件治理器

浏览器复刻 host 侧的分工。`dsh-client-modules`（`ClientModuleSystem`）坐上 host 侧由 Node 内部 ESM loader 占据的模块系统席位；同一份 vendored `@cordisjs/plugin-loader` 在两侧都坐治理席。二者的分界线一句话说尽：**模块系统拥有模块身份与字节——代码怎么到达、怎么登记、怎么变成导出内容；Loader 拥有插件生命周期——插件何时挂载、等待什么、如何拆除。**

`ClientModuleSystem` 是一张 lazy CJS 表。执行 bundle 只**登记**其 factory——入口调用 `window.__ModuleLoader__.load({ id, factory })`，chunk 还会提供其生成文件名——此外什么都不发生。模块体的一切副作用（包括 CSS 注入）都住在 factory 闭包里，在物化时运行：物化即该 id 的首次 `require`/import，此后记忆化。Import 和 prefetch 会先递归登记已声明的动态请求，再登记消费者；随后 factory 会同步物化任何已登记但尚未物化的请求。可调用的 `require` 解析同步模块表请求；其 `require.async` 操作返回 Promise，负责加载、登记并物化一个包内 chunk。共享 tsdown 预设把源码中针对包内 chunk 的 `import()` 表达式编译到这个独立操作。受支持的产物必须自包含：入口或 chunk 不能同步 require 另一个相对 `client*.js` 产物。模块表按固定分支顺序解析：seed word → 记忆化记录 → graph row classic-script 登记 → 已登记 factory 物化 → 大声抛错。Modules factory 是自举例外：HTML facade 先物化它，构造过程再把同一 exports 直接写入记忆化表。最后这一抛是构建期纯度门禁在运行时的镜像。系统还保管逐模块簿记——名下 `<style data-plugin>` 标签 id、观测到的 require 边——并暴露 HMR（热模块替换）需要的两个动词：`prefetch(id)`（登记所请求的动态 factory 和本 row 自身的 factory；并发到达共享一个任务）与 `invalidate(id)`（推进 owner 代次并丢弃非 bootstrap 包的入口和 chunk factory 及记录，让下次到达重新加载它们）。在旧代次捕获的 chunk 请求不能填充新代次。

vendored Loader 经其 `internal` 约定消费模块系统——唯一调用点是 `tree.import`——并拥有一切 entry 形状的事务：entry 创建、fiber 经 cordis 服务等待的激活（注入的服务未就位即保持 PENDING，服务 provide 时级联激活）、update/refresh、拆除。治理代码按 vendor 政策与 host 侧逐字节相同。浏览器化是壳 vite 配置里的编译期映射：一个 `node:module` stub 别名加若干 `process.*` define，使 `ModuleLoader.fromInternal()` 返回 undefined——这正是留给壳来填的空槽。模块系统挂载为 `ctx.modules`。

### Combo 外部脚本到达与源码映射

Host 会快照每个已构建插件入口 bundle，并把每个调度阶段的有序 row 划入一个或多个同源 classic script。它在更长的 map 形式请求 URL 保持在 3 KiB 以内时贪心填充每组，既保留 graph 顺序，也以增加请求代替超长 URL。每个脚本只包含 `client.js` 资源，并由这些 package 资源寻址，例如 `/plugins/??<package-a>/client.js,<package-b>/client.js&rev=<rev>`。Host 不扫描同级文件，也不把 chunk 加入启动 combo。`bootstrap` 与 `application` 是图中的调度阶段，不是 URL 组成部分：HTML 先预加载所有 application URL，再执行所有阻塞 parser 的 bootstrap URL。模块系统按 combo URL 复用进行中的传输，因此同组 row 的并发到达只执行一个脚本。成功结算仍要求模块表中已经存在被请求 row 的 factory id；登记不会运行 factory，所以副作用边界依然是首次物化。

一次 `require.async("./client.<name>.js")` 调用会请求精确的带 revision URL：`/plugins/<package>/client.<name>.js?rev=<rev>`。Host 只在收到请求时读取该文件，把文件已有的 chunk 登记包装为一个脚本响应，并按 URL 缓存响应。并发调用共享一个进行中的脚本任务；成功结算要求 chunk 已登记，随后 loader 才会物化并记忆化其 exports。未知名称、缺失文件以及不同于所属 graph row 的 revision 都返回 404。

共享 tsdown 预设为每个插件入口与 chunk 产出 map，并把第一方源码路径重写成浏览器可识别的仓库形式 `/packages/<group>/<package>/src/...`。生产 Client 构建会消费 `lib/types`；预设把每份 tsc map 交给 Rolldown，并从原文件补齐 `sourcesContent`，使最终 map 回到 TypeScript/TSX，而不是停在编译后的 JavaScript。内联进 bundle 的其他 workspace 源码同样回到其 `packages/` 归属，依赖包路径保持原样。Combo 生成会移除每个局部调试指令、记录其生成行偏移、以原插件 map URL 解析每个自带 source，再产出 Indexed Source Map v3。插件有自带 map 时直接用于对应 section；没有时则生成 identity section，内嵌构建后 bundle，并在存在时把 packer 写入的 `sourceURL` 用作 source 名。绝对 combo map URL 会平行改写脚本资源列表中的每个 `client.js` 后缀，因此 `/plugins/??<package-a>/client.js,<package-b>/client.js&rev=<rev>` 指向 `/plugins/??<package-a>/client.js.map,<package-b>/client.js.map&rev=<rev>`。chunk 脚本同样指向自己的 map URL。只有在这些 map URL 收到 `GET` 后，source map 文件才会被读取和组合；`HEAD` 不会物化脚本或 map body。Vite 壳同样产出 sourcemap，使壳代码与经外部加载的插件都能从 stack 和性能 profile 回到 TypeScript/TSX。

图为 HMR 保留每个 row 带 revision 的单资源 combo URL，并为每个启动 combo 请求增加带 revision 的描述；多条描述可以使用同一调度阶段。首次发布与 `rebuilt(id)` 使用相同的入口 mtime、ctime 和大小哈希；产物内容不参与求哈希。ctime 用于区分保留 mtime 和大小的重写。Host 重启时若产物未变，每个 row 的 revision 都保持不变，因此重连后的 SSE 快照不会触发浏览器插件替换。共享预设会在每个包输出写完后标记入口；因此只重建 chunk 也会推进 owner revision，无需 Host 扫描 sibling。启动 combo revision 从有序 row revision 派生。脚本 body 在首次 `GET` 时组合；source map 文件在首次 map `GET` 时单独读取并组合。`HEAD` 不会物化任一 body。版本化脚本与 map 使用 immutable 缓存，无关图重组会保留相同 revision 下已经物化的 chunk 响应。Host 只提供精确生成的 URL；陈旧 revision 与未发布资源列表返回 404，不会别名到其他字节。外部脚本的 `error` 事件不给响应状态与正文，因此失败诊断只报告 URL；同源 Host 与构建期写入的 registration id 是身份边界，`load` 后的 factory 存在性检查负责拒绝未登记预期 id 的产物。

### 装载流程，端到端

从 `dsh web` 启动到 UI 出现之间发生了什么？三个阶段：host 组合 graph 并由 parser 预载 bootstrap factory，HTML facade 创建模块系统且外壳执行预取，然后 Cordis 编排。

**host 侧——组合这张图。**

1. 负责组合的 app（`apps/cli`）把名册作为普通行放进它的 `cordis.yml` 配置树——client 插件包与每个 host 插件一样是 entry 行，包括无条件挂载的 `client-hmr` 行。`auditStartupEntries` 报告 import 失败、带原始 stack 的激活错误，以及待满足的依赖；optional entry 输出 warning，required entry 则使启动失败（[启动策略](2026-09-09-consumer-owned-startup-strictness.zh.md)）。
2. `dsh-client-modules` 的 node 半（该包是双面的：浏览器半就是模块表）使用 Host face import 时相同的 `name` 与所属 tree `baseUrl` 解析每个 live Loader entry，再读取最近归属 package.json 的 `dsh.client` 声明并组合出 `window.__DSH_BOOT__`：`{ rev, entries: [{ id, url, rev, inject?, immediately?, external? }], batches: [{ phase, url, rev, entries }] }`。即使 overlay 指向相对的 source 或 built entry 文件，manifest 包名仍是浏览器模块身份。若不同的 active Loader source 解析到同一包名，组合会失败；一个来源卸载后，仍存活的来源无需重启 fiber 即可提供该 row。Row 的三个可选字段都来自 manifest，永不人肉抄写。组合会把被请求的动态图 row 排到消费者之前、拒绝同步请求环，并把每个 row 恰好分配给一个初始批次。它会拒绝没有已构建 `./client` bundle 的已声明插件，并把它们的 package/path 行归到一条源码构建要求下；畸形声明字段同样会让激活失败，Host 检查会从 FAILED fiber 报告这两类错误。
3. 扫描是单包增量——不存在全量重扫代码路径。每次 cordis `internal/plugin` 发射把该 fiber 的 entry 名标脏（无 entry 的 fiber O(1) 丢弃）；微任务 flush 把每个脏名对账 live loader entries，包元数据（含「非 client 包」的否定结论）按 entry 名与所属 tree base URL 缓存至进程结束，变化后 bundle 的发布只经 `rebuilt(id)` 可达。激活趟从当前 entries 灌同一脏集合并同步 flush，初扫与稳态共享一条实现。初始 row 对读取前的文件系统元数据求哈希；启动 combo revision 对有序 row 的身份与 revision 求哈希，row 与批次描述再共同哈希进 `graph.rev`。图类型单源在 modules 包的 `./client` 出口——webserver 对图一无所知；modules 会注册 combo 路由并贡献结构化 index 注入行。

为什么名册是 yml 行而不是扫描？因为哪些插件组合进一次部署是组合决策，不是包属性——一个在仓库中声明了 dsh.client 的包，不代表这次部署要挂载它，扫描发现无从替人做这个决定；node 半只扫描配置树实际挂载了的东西。

**第一阶段——模块面。**注入的 HTML 以 queue 模式安装 `window.__ModuleLoader__`，开始预加载所有 application combo URL，以阻塞式 classic script 依次执行所有 bootstrap combo URL，赋值 `window.__DSH_BOOT__`，然后启动 Vite 主模块。内核把原始图和外壳 seed 传给 facade 的 `create()`。Facade 移除 modules registration，用拒绝全部 external 的 bootstrap `require` 将其物化，再调用其 `createClientModuleSystem` 导出。Modules bundle 解析图、构造并返回系统、记忆化自身 exports，并把同一 facade 切换到 live registration。随后内核并行预取每个 `immediately` row；同一 application combo 中的 row 共享一次执行，不同 combo 会在 immediate row、被请求依赖或普通 entry import 首次触及时独立加载。预取失败在这里被吞下，因为第二阶段 import 会重试并拥有那次大声失败。`immediately` 仍是 registration barrier，不是包身份。

**第二阶段——插件面。**

1. 内核挂载 vendored Loader，在任何 entry 存在之前就把模块系统注入为 `internal`。顺序有讲究：`tree.import` 的裸 import 兜底分支在浏览器里绝不能跑到。
2. 它统一创建每个 graph row。Import modules row 会返回记忆化的 bootstrap exports，其 `apply()` 读取该树的 `Loader.internal`，把同一个实例提供为 `ctx.modules`；需要该 service 的 row 会保持 PENDING 直至此时，因此 modules row 无需特殊创建位置。渲染组装是由 `dsh-client-ui-renderer` 提供的普通 host graph row；内核不追加组装伪 entry。
3. Graph 顺序治理同步 factory 可用性；Cordis 激活与之独立，仍经服务等待推进。
4. `settled` = 每个 entry 已创建 + `loader.await()` 完全停稳 + 一次全 ACTIVE 扫描。扫描列出每个 import 失败、FAILED 或 PENDING 的 fiber 及其缺失的服务。它存在的理由：cordis 的 inject 等待没有超时——这次扫描就是大声失败的兜底线。
5. 不依赖框架的 loading 页经 `internal/status` 投影真实 fiber 状态。检查完成后，内核调用 `ctx.uiRenderer.mount(container)`，一次切换到真实 UI。

### 动态图对账

modules 控制器只持有从启动清单创建的 Loader 条目。Host 的完整快照更新模块描述并对账这些条目；其他 Loader 贡献方保留自身所有权。新增模块通过单资源 URL 到达，因为重放启动 batch 可能重复注册现有 factory。移除使用 Loader 删除语义，随后等待已捕获 fiber 清理完毕，再移除未使用的模块与样式。已声明及已观察到的传递依赖使共享模块保持存活。Factory revision 的跟踪独立于条目激活，因为下载或物化完成后仍可能没有创建条目。图更新会在任何消费者导入依赖前，使未归属受管条目的陈旧 factory 和失败的到达目标失效，并清除其样式；重建帧也会对账因导入失败而缺失的条目。

Host SSE 适配器转发现有图变化通知，并在连接时发送当前完整图。图描述浏览器的目标条目，不代表 Host 清理完成：Host 生命周期顺序属于其 Loader，每个浏览器则等待自身被移除 fiber 的清理。图对账与代码重建共用一个页面队列。本地代际阻止过期下载挂载；不透明 revision 只比较相等。失败页面报告本地错误，并可重试同一张图而不改变 Host 启用状态。这保留了无关页面状态，也无需重启应用或引入第二套插件执行器。Electron 的独立安装流程不属于此机制。

### 热重载：一个驱动插件，自行监视的 bundle

热重载是一项组合决策：web 组合包无条件挂载 `client-hmr` 行（一个常规的插件包），其 node 半带来 bundle 监视与 SSE（Server-Sent Events）通道；没有重建 watcher 改写客户端 bundle 时链路保持空闲。不应暴露它的组合可以禁用该行。

重建好的 bundle 怎么变成重载信号？hmr 的 node 半自己观察——没有构建器来通知它。模块 host 在读取每份启动快照前捕获入口 stat 基线，并通过 `ctx.clientModules.artifactBaseline(id)` 暴露它。HMR 自持的单个定时器把当前图的每个 row 与这份基线比较：未变化的 row 直接开始监视，不读取内容也不求哈希；基线捕获后的写入已经形成 stat 差异，只有该 row 会进入 `rebuilt(id)`。这既避免安装 watcher 时重复读取，也避开 `fs.watchFile` 以异步首次 stat 建立基线、可能静默吸收构造期重建的问题。监视集合的成员随 `onGraphChanged` 更新；消失的 row 撤下监视，轮询时缺失的入口则让对应 row 保持标脏状态，文件重现时即使 mtime 和大小与基线相同也重试发布。共享 tsdown 预设会在每个 sibling 输出写完后标记 `client.js`；入口 mtime、ctime 或大小变化、或 row 处于标脏状态时，`rebuilt(id)` 从这三个元数据值派生 revision。只有 revision 变化时，它才读取新的 bundle 快照。只修改 chunk 因此也会更换 revision；部分写入之后的完成标记还会提供一次更晚的 stat 变化以完成自愈。`rev` 变化时，node 半在 `GET /plugins/events` 上广播 `rebuilt` 帧——这是一条系统级 SSE 通道，连接即发全量图，变更时发 `rebuilt` 帧，仅供呈现的 wire，永不进会话日志。轮询是刻意选择：inotify 在 weka 网络挂载上不触发，构建侧监视器需要 `--poll` 也是同一原因；每个 row 每个间隔只需一次入口 stat，轮询间隔是一个经校验的配置字段（默认 500ms），dispose（资源释放）会清掉那一个定时器。重建产物的进程必须使用共享 Client tsdown 预设；`scripts/dev-web.ts` 仍作为 watch 构建入口保留，其包清单在启动时扫描 `packages/*/*/package.json` 按 dsh.client 发现，构建器与 host 之间没有通知协议。

浏览器侧的传输把代码替换交给负责图对账的同一个 modules 控制器：

1. `invalidate`——丢弃陈旧的 factory 与记录，并把 rebuilt 帧的 revision 绑定到该 row 的单资源 combo URL。Factory 还活着会让下一步变成 no-op。
2. `prefetch`——加载该单资源外部脚本并登记新 factory，旧 fiber 此刻仍在服役。初始多资源脚本不会再次执行。
3. `registry.delete`——先于任何 fiber 操作。裸做 fiber dispose 会触发 vendored Loader 的自 dispose 分支，把 entry 永久停用。
4. 排空旧 fiber 的各 disposer。
5. 移除名下的 `<style data-plugin>` 标签。
6. 通过模块系统物化新导出，再调用 `entry.refresh()` 由 Loader 挂载。CSS 在旧 disposer 清理完成后重新注入；显式物化使导入错误能够被捕获，而不只留下 Loader 的控制台日志。
7. `fiber.await()`——让失败大声重抛。

Bootstrap 替换会在失效或卸载前被拒绝：模块系统保留其初始导出，重新挂载旧代码会重置消费者，却无法应用请求的 revision。页面会报告需要刷新，并保留 bootstrap fiber。所有非 bootstrap 插件都共享同一套替换语义；`immediately` 行的重载与 lazy 行分毫不差。依赖级联不花一行 client 代码：fiber 的激活纪元串接着它各服务提供方的 uid，因此替换 connection 等基础 provider 的 fiber 时，每个依赖方都会经 cordis 本身重新装载——行为正确，但代价较高。

重载会创建新的 fiber 和组件状态，不保留被替换插件内部的 React 状态。静态组装库与应用壳需要重建后的页面。导入或激活失败仍可诊断和重试，不会回滚无关插件。自重载关闭旧 SSE 通道并打开新通道；其完整快照补齐遗漏的图变更。启动、图更新和重建帧共用同一队列，因此代码替换不会与初始模块到达重叠。

## 包归属

当前包盘点与构建形态位于[client 外壳分层 Note](2026-08-15-client-shells-and-dynamic-packages.zh.md)。本 Note 只保留适用于每个动态图 row 的装载属性：惰性 factory 登记、Cordis entry 治理、外部 script 到达、sourcemap 与 HMR。

## Consequences

Wire 两侧运行同一份治理实现；浏览器特有层只包含一套模块系统和一个重载插件。动态包只有一种产物形态，因此纯度检查覆盖全部动态包。Cordis 依赖、模块请求与启动档位都与其所有者——manifest——同住，负责组合的 app 只握名册。Host graph 校验与递归请求到达使同步 factory 依赖保持显式。浏览器原生 script 装载保留插件网络资源、生成 bundle 与 TypeScript/TSX 源码之间的标准映射，模块系统也只保留一个可替换的 `loadBundle` 钩子。

接受的代价：vendored Loader 在浏览器里背着闲置机件（EntryTree 持久化是 no-op，分组／隔离未用）；开发期每次修改插件都要付一次 bundle 重建加 fiber 重挂；graph `inject` row 指导 factory 到达，但服务可用性仍是激活权威，因此不匹配会在 settled 扫描时浮出；静态 UI 库保留直接实体导出；每个 bundle 多出一份 sourcemap 产物，外部 script 失败也只能给出粗粒度 URL 诊断，不能像显式 fetch 那样报告 HTTP 状态。Host 为当前图及上一代启动图保留 bundle 快照与惰性响应计划。脚本和 map body 在首次 `GET` 后缓存，因此内存随 bundle 快照和已请求的响应 body 增长。每份已物化响应在其 URL 下保持固定；若上一代 map 在重建后才首次被请求，则会读取当前 map 文件。

名册位于 web 组合包的配置树（`packages/bundle/web-app/cordis.patch.yml`）；`mountWebPlugins` 与 `CLIENT_PACKAGES` 常量已消失，重组一次部署等于替换 yml/overlay。Graph 组合器位于 `dsh-client-modules` node 半，由 parser 预载的 Client face 则自举浏览器模块表。Webserver 继续作为朴素路由注册插件；`/api/*` 绑定、浏览器认证、RPC envelope 与精确 Fetch 路由属于 Connection node 半，Remote 分发属于 API Gateway，开发期 bundle 监视与 SSE 通道属于 HMR node 半。

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| 两轴分类体系（entry × 到达），基础设施包不带 dsh.client | 抹掉了 manifest 依赖边（inject 泄漏给组合方）、把插件形态拆成两种、让纯度门禁对一半插件失明 |
| 继续把手写 loader 演化成治理器 | 重新实现 vendored Loader 已拥有的 entry/fiber 生命周期；HMR 将与 host 侧毫无共享骨架 |
| 在浏览器复用 `@cordisjs/plugin-hmr` | 约 80% 在解决浏览器没有的问题（fs 监听、深度图着色、Node 的双缓存）；只按形状抄用其重载骨架 |
| 模块联邦（module federation） | 独立构建的远端 bundle 恰是 vite 联邦不支持的形态 |
| import map | 早已排除；DI require 表是终局机制 |
| 现在就彻底 ctx 化（React 与库全走服务，不设模块表） | 静态 UI 库仍暴露同步实体，因此删除模块表会让这些 import 失去共享身份 |
| 冻结表 + 到达即实例化 | 会在 script 到达时执行 bundle 副作用；惰性登记把执行推迟到 Cordis import，并由递归 `require` 物化已登记请求 |
| fetch 响应文本后注入内联 `<script>` | 模块系统必须缓冲整份源码并维护 fetch/execute 两条路径；动态源码执行也切断浏览器网络资源、sourcemap 与 profile 的原生关联 |
| 构建器推送重建通道（编排器在 `onSuccess` 里 POST `/plugins/rebuilt`） | 把重载耦合到一个钦定的构建器进程和第二套 wire 协议；webserver 本就握有每个 bundle 路径，stat 轮询（每次 stat 变化即发布）已兜住当年为推送辩护的撕裂写竞态 |
