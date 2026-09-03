# Agent Note: 一份出站代理策略，在任何请求发生之前装好

Status: implemented

[English](2026-08-27-outbound-proxy-policy.md) | 中文

## Problem

Node 内置的 `fetch` 会忽略 `HTTP_PROXY` 与 `HTTPS_PROXY`。开发者运行的其他工具——curl、git、npm、pip——都遵循它们，所以代理后面的用户导出一次变量就期待一切随之生效。Harness 并没有：`setGlobalDispatcher`、`ProxyAgent` 与 `EnvHttpProxyAgent` 在 `packages/` 与 `apps/` 中出现次数为零，因此模型请求、每次 web 搜索、`web_fetch`、走 HTTP 的 MCP、OTLP 导出器与 E2B SDK 全部直连，且是静默的，任何地方都没有诊断。

仓库曾短暂拥有过答案，又在无人察觉时弄丢了。PR #971 在 `bin/dsh` 里设置了 `NODE_USE_ENV_PROXY=1`；十一天后 `bbb1b1cc38 cleanup: remove managed source installer` 整体删除了那个启动器，把该标志一并带走。留下的只有 `apps/cli/reference/README.md` 里的一句话，让读者去设置一个已经无人消费的变量。

即便照做，那句话也不可能生效，原因有三条且都经过实测。`NODE_USE_ENV_PROXY` 在进程启动时对环境取快照，而 `loadLayeredEnv()` 是在之后才合并 `.env` 层，因此写在 `$DSH_HOME/.env` 中的代理对它不可见。它只覆盖 Node 24.0+，在 22 线上只覆盖 22.21+——而 `engines` 允许 `^22.19.0`，那里根本没有这个变量，设置了也不会有任何警告。它也完全触及不到 `web-fetch-http`：该提供方向 `fetch` 传入自己的 `dispatcher`，而显式 dispatcher 无论标志如何都会覆盖全局的那个。

## Decision

**一份策略，从启动环境解析一次，装为全局 dispatcher。** `packages/util/http-proxy` 解析出 `ProxyPolicy`，并在 `runProfile` 中于环境快照提供之后、任何 entry 挂载之前完成安装。Node 的 `fetch` 解析的正是 undici 的全局 dispatcher，因此每一处普通 `fetch()` 以及每一个最终落到 `globalThis.fetch` 的 SDK 都无需改动即被覆盖——撰写时是九个调用点，未来新增的也自动覆盖。`loadLayeredEnv` 只有一个调用方，且 `apps/web` 不提供 bin，因此这一处即覆盖全部 profile，包括不叠加 `base` 的 `sdk-minimal`。

解析读取的是启动器的快照而非 `process.env`，这正是让 `$DSH_HOME/.env` 中的代理生效的原因——也是环境变量方案不可能具备的能力。仅限该文件：`loadLayeredEnv` 拒绝项目 `.env` 里的代理名，正如它在那里拒绝 `PATH` 或 `NODE_OPTIONS`，因为那个文件随 clone 一起到来，不得替 Harness 选择路由。home 文件仅对这四个代理名豁免，而 `DSH_HOME` 本身是 bootstrap-only，因此没有任何 `.env` 能把这份豁免指向仓库控制的目录。

**放在 `util/` 的库，而非插件。** 传输策略每个进程只有一个答案：没有可替换的实现，也没有比进程更窄的作用域可赋予。因此本包只导出函数、不挂载任何东西——`boot`、`web`、`subprocess` 与 `workflow` 都消费它，而 `util/` 正是其他所有组都可以依赖的那一组。

早先的修订把它放进新建的 `net/` 包组，理由是依赖 `undici` 使它不符合“零依赖”组。那个理解是错的：[优先使用依赖而非手写](../process/2026-07-26-dependencies-over-hand-rolling.zh.md) 记录了该章程约束的是 *harness* 依赖——util 不依赖它们，任何组才都能依赖 util——并不禁止外部包。真正需要去掉的是对 `dsh-launch-environment` 的依赖：解析只用到它的一个方法，于是改为声明结构化的 `EnvLookup`，启动器原样传入自己的快照即可。

那次修订一并引入的插件也随之删除。它让某个组合可以把策略写进 `cordis.yml`，但没有任何随附 bundle 挂载它，因此启动器那条路径是唯一可达的——而它的 `Config` 是那条配置分支唯一的供给方，别处无从到达。

**四个函数——收敛的是调用方，而不是让本包为每个 SDK 各加一个导出。** 早先一版导出六个：dispatcher 工厂、`node:http` agent 工厂、代理 URL 查询、策略访问器、安装器与子进程环境构造器。每一个都为某个 SDK 的传输而存在，而这正是一个传输策略包退化成「别的包的约束目录」的过程。Review 问能不能反过来让调用方收敛；能，而且每删掉一个导出都带走了一整种写法。遥测不再被路由，`node:http` agent 工厂随之退场。`web-fetch-http` 在带注释的豁免下自建 pin agent，dispatcher 工厂随之退场。E2B 读 `route.proxy`，代理 URL 查询随之退场。

剩下的是 `installProxyFromEnvironment`、`proxyRouteFor`、`proxyEnvironmentForChild` 与 `clearedProxyEnv`——按「调用方需要策略的方式」各一个，而不是按 SDK 各一个。安装吸收了解析与诊断上报，因为没有调用方需要把它们分开：解析出来却不安装的策略什么也路由不了。

`proxyRouteFor` 还堵掉了旧访问器让人写得出来的一个缺陷。`web-fetch-http` 先读策略决定是否 pin，再读一次去构造传输；两次读取之间发生卸载，就会为第一次读取已判定走代理的 URL 返回一个直连且未 pin 的 agent。路由把两者一起交出，分支与请求便无从分歧。它携带的是进程级 dispatcher，dispose 时是 close 而非 destroy，因此策略被卸载时已经发出的请求仍会跑完。

**已安装的 dispatcher 按策略路由，而不是重新解析一遍环境。** 安装过程构造一个 `Agent`，其按 origin 调用的 `factory` 会询问 `proxyForUrl` 该 origin 的去向，并据此返回 `ProxyAgent` 或 undici 自带的默认客户端。undici 的 `EnvHttpProxyAgent` 曾是首选，但对这套策略是错的：没有 `HTTPS_PROXY` 时它会把 HTTPS agent 设为 HTTP agent，于是本包在拒绝某个 SOCKS 或畸形 URL 后本应保持直连的 scheme 仍会被隧道转发，而诊断却声称直连。让路由走同一个谓词，从构造上而非靠测试消除了这一类分歧。把策略发布到环境中的做法保留下来，但如今只服务一类读者：派生的子进程——它没有策略对象可查。

这样 `proxyForUrl()` 与 dispatcher 就从同一组值给出答案。两者必须一致：一旦对某个 URL 产生分歧，`web-fetch-http` 就会把 dispatcher 本打算隧道转发的连接固定到某个地址上。

**解析补上 Node 与 undici 都不提供的部分。** `ALL_PROXY` 为两种协议兜底；空值视为未设置，因为 undici 的 `??` 链会让空的小写名遮住有值的大写名；loopback 始终绕过，否则 Web UI、Connection 传输以及每一个本地测试服务器都会经由代理并形成回环。绕过列表同时携带 `::1` **与** `[::1]`：undici 自带的匹配器会把裸写的 `::1` 读成主机 `:` 端口 `1`，从而永不豁免它。

**拒绝是静默的，且绝不为被拒协议改道。** 用户填写而被本包拒绝的槽位，会让该协议保持直连，而不是继续回退到 `ALL_PROXY` 或 HTTP 代理，从而让诊断与实际路由一致。SOCKS URL、无法解析的字符串或不受支持的协议，会在 stderr 上报告并跳过——该变量可能是为其他工具导出的，它的笔误不应阻止 agent 启动。环境是唯一来源，因此不存在一个本应适用 `AGENTS.md` 「配置错误必须响」规则的配置面。

**经由代理时，`web_fetch` 不再解析与固定地址。** 该提供方会校验一组公网地址并把连接固定到其上。经由代理时没有可固定的对象——origin 的 DNS 由代理执行——而固定后的直连会彻底绕开代理。因此代理转发的一跳跳过解析，配置代理即表示信任该代理进行目的地选择。被策略绕过的一跳，包括每一个 loopback 与每一条 `NO_PROXY` 条目，仍走原有的解析并固定路径。Kimi Code 与 Claude Code 各自独立得出了同一结论。

URL 层策略未受影响：仅 `http(s)`、禁止内嵌凭据、长度上限与跨域重定向拒绝在每一跳上依然生效。

**派生的子进程通过环境获得策略；执行模型代码的 worker 什么也不获得。** `proxyEnvironmentForChild()` 并入 `scrubbedParentEnv()`——每个 spawner 本就共享的那一个函数。workflow worker **不**接收它：它执行的是模型编写的脚本体，而代理 URL 可能携带 `user:password`。这与 code runtime 保持的隔离相同，也是 `docs/defensive-patterns.md` 的要求，因此 workflow 自身的请求直连。

子进程拿到的是用户自己的值，而这恰恰曾把它弄坏。Node 在 `NODE_USE_ENV_PROXY` 下会在运行程序之前先解析 `HTTP_PROXY` 与 `HTTPS_PROXY`，遇到 `http:`/`https:` 之外的协议直接退出；于是一个为 `curl` 保留的 `socks4://` 会让每个 Node 子进程——MCP server、subagent CLI、`npm`——在第一行之前就终结，而本进程此前只报告过该协议保持直连。在 Node 24.17 上实测：`socks4://`、`ftp://` 与畸形值均以 1 退出；`socks5://` 恰好在该版本被接受。现在只要子进程收到的某个值是本包拒绝过的，就扣下该标志，这样的子进程直连，`curl` 仍读到为它保留的值。若改为把解析后的值交给子进程，Node 固然能继续走代理，代价却是悄悄改写用户为另一工具设置的值。

这接受了一处已记录的接缝。此类上下文按 Node 自己的规则匹配绕过条目，其分隔符与 IPv4 区间支持与本包不同，且该标志仅存在于 Node 22.21+ 与 24+。

**有两个 SDK 并不落到 `globalThis.fetch`，而读代码给出的答案是相反的。** 审计最初把 OTLP 导出器与 E2B SDK 判为已覆盖，依据是在 `@opentelemetry/otlp-exporter-base` 里 grep 到了 `globalThis.fetch`。那处命中属于**浏览器**传输；在 Node 上 delegate 选择的是 `http-exporter-transport`，它通过 `node:http` 投递——那里全局 dispatcher 触及不到。E2B 又是另一种形态：它自建 undici `Agent`／`ProxyAgent`，并接受一个自己从不从环境读取的 `proxy` URL。两者都实测为直连。E2B 接收 `proxyRouteFor` 给出的 `route.proxy`，与 `web-fetch-http` 调的是同一个函数。遥测则被有意保留为直连，而这个排除项才是更值得说的一半。

**遥测的直连是有意为之。** 要让它走代理只有两条路，代价都超过这条通道本身的价值。`http.Agent` 通过 `proxyEnv` 读取环境，而该选项自 Node 22.21 与 24.5 才有——落在 engines 范围之内，因此 22.19、22.20 与 24.0–24.4 无论如何仍是直连，而代理包还得为一条只在部分运行时生效的路径保留 `createNodeHttpAgent` 导出。改用 SDK 的 `fetch` delegate 替换传输可以覆盖所有运行时，但该 delegate 没有压缩能力，而随附的 `base` bundle 启用了 gzip：实测一批真实规模的 OTLP 数据启用后体积只有 1/6.4。曾有一版转而在加载期拒绝 `exporter.compression`，结果凡是启动随附 bundle 的测试全部失败；另一版在 serializer 处 gzip 确实能跑通，但代价是把传输层代码塞进了遥测插件。

与之相比，遥测是唯一一条丢失了对用户毫无代价的出网通道：没有任何工具、模型请求或会话依赖它，而连不上的导出本就被静默丢弃。处在强制代理后的用户，只是停留在本次改动之前的状态，而不是被弄坏。`egress.spec.ts` 现在断言这一排除——若某次 SDK 升级把导出器挪到 `fetch` 上，遥测就会开始静默走代理，而该用例正是让这件事暴露出来的东西。

**每个出网点都配一份出网测试，因为读代码不够。** 各所属包中的 `egress.spec.ts` 驱动该点的真实代码路径，目标是无法解析的 `.invalid` 主机，穿过一个假代理，并断言代理确实收到了请求。九份测试覆盖搜索后端、pi-ai 发现、走 HTTP 的 MCP、E2B、派生的子 Node、worker 线程，以及遥测的排除。下面那条门禁看不进依赖内部；这些能，它们把「某个 SDK 换了传输」从静默回归变成失败的测试。

**用门禁防止该缺陷复现。** `verify-no-bare-dispatcher` 解析 TypeScript AST——`scripts/AGENTS.md` 要求 source-ownership 门禁使用语法感知发现，而逐行正则漏掉了本仓库已在使用的 `{ dispatcher }` 简写，以及重命名导入后的 `new Alias(...)`。它在所属包之外拒绝 undici agent 构造与显式 `dispatcher` 选项。`proxyRouteFor(url)` 是受支持的替代；唯一一处确实自有传输的调用点——`web-fetch-http`，它把请求钉在已校验的地址上——用 `proxy-exempt:` 注释说明。这条规则之所以存在，是因为 `web-fetch-http` 里原本那行 `new Agent` 在写下时完全合理——那时根本还没有代理这回事，也没有任何机制会拦下它。

## Alternatives considered

**只写文档，让用户设 `NODE_USE_ENV_PROXY=1`。** 基于上文三条实测被否决：对 `$DSH_HOME/.env` 不可见、在最低支持的 Node 上不存在、且无论如何被 `web-fetch-http` 绕过。而这恰恰是仓库此前声称的做法。

**把策略值传递到每一个调用点。** DeepSeek-Reasonix 在 98 处这样做，换来每提供方的 opt-out。被否决：该能力服务于本 Harness 并不具备的需求，而手工改九处意味着第十处会被遗忘——Pi 的变更日志正记录了 OAuth 与 Bedrock 两次事后补漏。它关于隔离性的论点确实成立，本方案改为显式处理 worker 线程、并以「dispose 后还原前一个 dispatcher」的断言来回应。

**`http.setGlobalProxyFromEnv()`。** Node 自带的程序化开关同时覆盖 `fetch` 与 `node:http`，并返回还原函数——正是 `ctx.effect()` 想要的形态。不可用：`added: v24.14.0`，22 线上完全没有。若 `engines` 日后升过该版本，值得回头替换。

**用 `undici.install()` patch `globalThis.fetch`。** Pi 这样做，是为了让 fetch 与 dispatcher 处于同一个 undici——较新 Node 的内置 fetch 经 userland dispatcher 处理压缩响应时会出错。此处被否决为投机性复杂度：本仓库 `engines` 的上限尚未触及该运行时。

**做成能力接缝。** 被否决。Service Definition／Provider／Consumer 用于可替换后端；这里每个进程只有一种实现、一个答案。若日后要支持操作系统代理或 PAC，`resolveProxyPolicy` 就是扩展点。

**读取操作系统的代理设置。** 本次变更中被否决。所调研的六个产品中只有 Codex 与 Reasonix 这样做，且 Codex 把它放在默认关闭的开关之后。在作者机器上实测，它什么也读不到：代理软件把设置写在了 Wi-Fi 服务上，而主接口是一块没有代理的 USB 以太网卡，因此 `scutil --proxy` 报告无代理，而导出的环境变量却工作正常。它还需要自带的绕过匹配器，因为操作系统的列表含有 undici 与 Node 都不匹配的 CIDR 条目。

**也把代理给 `code-runtime` worker。** 被否决。模型编写的程序在那里运行时完全没有环境变量——这比派生命令得到的 scrubbed 环境更严——而代理 URL 可能携带凭据。把带凭据的 URL 交给模型代码去访问网络是错误的取舍；该排除已记入那个包的限制清单。

## Consequences

导出了 `HTTPS_PROXY`、或把它写进 `$DSH_HOME/.env` 的用户，在 Harness 发起请求的每一处都会走代理，无需任何标志与配置。启动器在第一个插件挂载之前恰好安装一次。

由于不读取操作系统设置，面向用户的文档从补充材料变成了承重件：仅在代理软件里拨了「系统代理」开关的用户什么也得不到，且没有诊断。因此 `docs/user/guide/network-proxy.md` 说明了要导出哪些变量，以及为什么浏览器走代理而终端不走——这个「三套机制」的困惑是最常见的报障，且并非本 Harness 特有。

`web_fetch` 的安全叙述现在有两种形态，其 README 已如实说明：直连的一跳保留地址校验与固定，代理转发的一跳把目的地选择交给运维方配置的代理。这是本次变更唯一改动的对外安全承诺。

userland undici 能触及 Node 内置的 `fetch`，依赖于两者都会写入 legacy 的 `Symbol.for('undici.globalDispatcher.1')` 槽位。那是跨版本的隐式耦合而非约定——corepack#834 记录了它失效的实例——因此 `tests/install.spec.ts` 会驱动一次真实请求穿过 loopback 代理。破坏该耦合的版本升级会在那里失败，而不是流到线上。

测试套件对开发者自身的环境免疫：每份 Vitest 配置都会先运行 `scripts/test-proxy-environment.ts`，在任何测试之前清除全部八个代理变量名的两种大小写形式；`install.spec.ts` 则在每个自行设值的用例前后还原本机的值。这是必需的。开发过程中，一个已导出的小写 `all_proxy` 曾决定了某个测试的结果，因为解析优先读取小写。

## Testing

`packages/util/http-proxy` 有 84 个测试，per-file 覆盖率 100%。解析覆盖优先级、`ALL_PROXY` 兜底、空值遮蔽、SOCKS 与畸形值诊断，以及只设 https 变量时 `http:` 保持直连；路由以结构化方式覆盖整个 loopback 网段，绕过匹配覆盖后缀、端口、两种 IPv6 写法，以及刻意不匹配的 CIDR 条目。安装驱动一个真实的 loopback 代理，断言绝对形式的请求确实抵达、被绕过的目标不抵达，且 dispose 会还原 dispatcher、策略与环境。所有用例一律经 `installProxyFromEnvironment` 安装，因此没有测试能断言一次真实启动无法产生的策略对象。

`packages/web/web-fetch-http/tests/proxy.spec.ts` 断言了最关键的那个决定：经由代理时公网地址解析器完全不被调用，而被绕过的一跳仍恰好调用一次，且跨域重定向拒绝在代理路径上依然成立。

`verify-no-bare-dispatcher.spec.ts` 证明该门禁能拒掉本包所要修复的那种写法、接受 `proxyRouteFor`、接受带注释的豁免，并在当前代码树上通过。

出网测试以负向形式承载遥测这一项：随附后端在已安装策略下执行导出，而假代理什么也没收到——这个有意的排除因此是被断言的，而不只是被记录的。另有一组一致性测试，对文档所述 `NO_PROXY` 词汇中的每种形态，把 `proxyForUrl` 的判断与真实 `fetch` 的实际去向相互核对；由于 dispatcher 正是按同一谓词路由，它现在能抓住的是 `bypassesProxy` 对某种形态的读法与词汇文档不一致，以及未来任何重新引入第二个匹配器的 dispatcher。

无录制会话快照变更：本次改动不影响任何模型可见输入或产品用户可见的 transcript 输出。
