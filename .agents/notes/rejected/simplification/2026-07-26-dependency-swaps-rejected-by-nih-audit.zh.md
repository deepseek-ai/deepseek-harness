# Agent Note: 2026-07 NIH 审计否决的依赖替换

Status: rejected — 下列每一项替换在证据上都未达到净简化门槛；记录在案，以免这轮普查日后从零重来

[English](2026-07-26-dependency-swaps-rejected-by-nih-audit.md) | 中文

## 问题

一次仓库级的「Not Invented Here（非我发明）」审计（2026-07-26，十路并行普查，覆盖每个包分组、scripts/、native/、vendor/ 边界、python/、测试基础设施与 CI）对每一处手写接口面追问同一个问题：在[依赖政策](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.zh.md)之下，是否有持续维护的外部包或 Node 内置能力能以净收益把它删除？得出肯定结论的发现已各自写成独立的提案 Agent Note。否定裁定的价值不相上下——每一条都点名了一个看似可行、实则手写形态在承重的替换——但否则它们只会留存在某个 PR（Pull Request）正文里。本 Agent Note 将它们固化在案。

## 提案

采纳下列依赖替换。已否决——逐项证据见下；未来针对任何一项的提案都必须胜过其记录在案的理由，而不能只是重新援引政策。

**协议与解析：**

- **以 `vscode-jsonrpc` 承担 LSP 基础协议的分帧/关联**（`lsp-stdio`）：可替换的核心只占 src 约 1,800 行中的约 255 行；该包无法表达已配置的 `maxMessageBytes` 入站大小上限（要恢复它就得重建被删掉的分帧代码），反转了取消宽限期的拆除语义（`raceAbort` 立即 reject 再拆除；vscode-jsonrpc 让 promise 保持挂起），会在真实服务器输出的 header 前 stdout 横幅上报错，而且在这个全面采用 ESM 的仓库里它是 CJS。[LSP seam 决策](../../archived/architecture/2026-07-15-lsp-capability-seam.md)把 JSON-RPC 的所有权划给 `dsh-lsp-stdio`；本次审计正是对该决策当时缺失的这项依赖权衡的明文记录。
- **以 `vscode-languageserver-types` 承担 lsp-stdio 的协议类型子集**：约 80 行类型加约 45 行守卫，但上游守卫在两个方向上都与本仓库不一致（接受本仓库必须拒绝的 `uri: undefined`；强制要求本仓库容忍缺失的 `targetRange`），而且 initialize 结果的形状住在 `vscode-languageserver-protocol` 里，会把 `vscode-jsonrpc` 拖成运行时依赖——为 80 行严格贴合规范的代码付出约 1 MB。
- **以 `json-rpc-2.0` 替换 `dsh-sdk-jsonrpc-server`**：可删除的关联/分发代码确实存在（约 100–130 行），但 NDJSON 协议格式（wire format）必须与手写的 Python SDK 客户端逐位一致，该包只有单一维护者，且[已归档的 GUI RPC 决策](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)已把这个包当作冻结的窄接口面对待。`vscode-jsonrpc` 更不合适（Content-Length 分帧、该协议并不具备的取消词汇）。
- **以 `jsonrpcclient` 承担 Python SDK 客户端**：v4 只做消息的构造/解析——约 20 行——而真正要紧的 500 行（子进程生命周期、线程化读取器、id 关联、双向的服务端角色应答）全都保留；该库处于低维护模式。
- **以 `eventsource-parser` 替换 apiproxy 的 `readSse`**：可删除的分帧只有约 15 行，线路两端都在仓库内，规范符合性无关紧要，而且这会给一个浏览器安全的包添加依赖。（对比[已归档的 llm-deepseek 依赖决策](../../archived/simplification/2026-07-26-eventsource-parser-for-deepseek-sse.md)：那里线路对面是真实的提供方。）

**重试、定时器与异步：**

- **以 `p-retry`/`exponential-backoff` 替换 `llm-retry`**：执行模型不对——该插件是一个返回决策的 waterfall（瀑布式事件）监听器，重新执行由 agent loop（智能体循环）依据持久日志负责；根本不存在可供重新调用的函数，而那恰是这些库的全部 API。提供方 `Retry-After` 覆写、依据先前失败代码计算预算、持久化的 `llm/retry` 事件、HMR（热模块替换）完全停稳式中止，全都无从覆盖。[LLM（大语言模型）请求受限恢复决策](../../implemented/architecture/2026-06-21-bounded-llm-request-recovery.zh.md)已经否决了由 SDK 持有的重试。
- **以 `p-timeout`/`AbortSignal.timeout` 替换 `dsh-timeout`**：内置能力无法提前解除，抛出的是通用 `TimeoutError`，而不是能区分嵌套截止时限、按能力编码的 `TimeoutReason`；`idleWatchdog` 按需逐次重新装定的能力没有等价物。设计归[超时库决策](../../implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)所有。
- **以 `p-limit`/`p-queue` 替换 agent loop 的工具调用池**：池的簿记只有约 25 行；实质部分（按模型顺序提交、组中途重新分类、排他屏障、带合成持久结果的中止排空）根本不是并发限制器的形状。
- **以 `p-queue`/`async-mutex` 替换按 key 的 promise 链串行器**（`fs-local`、`storage-domain`）：串行器只有 8–14 行；这些包严格大于它们所能删除的代码。
- **以 `events.once` + `AbortSignal.timeout` 替换 subagent-subprocess 的 `exitsWithin`**：`error` 先触发时 `events.once` 会 reject，而手写实现有意忽略 `error`（由 spawn 失败路径单独捕获）；这次替换恰恰会在语义本身就是拆除竞态的那段代码里改变拆除竞态行为。

**数据与校验：**

- **以 Ajv 承担 tools 的 JSON Schema 校验器**：[schema DSL 决策](../../implemented/architecture/2026-07-20-unified-json-value-schema-dsl.zh.md)已明确否决接纳更大的 schema 语言；这个校验器还会做 Ajv 不做的、针对 realm 内建原型的检查。
- **以 `structuredClone` 替换会话的 `snapshotJsonValue`/`isJsonValue`**：它是校验器加分离器，以「每个 getter 只读一次」和跨 realm 内建对象检查强制执行无损 JSON 边界；`structuredClone` 接受 Map/Date/-0，什么都不强制。有意保持零依赖、针对被模型篡改的 realm 做过加固的 `code-runtime-worker` 镜像实现同理。
- **以 `fast-deep-equal` 替换会话接口面的 `isDeepEqualJson`**、**以 `safe-stable-stringify` 承担 repeat-tool-reminder 的规范化**：两项替换在机械层面都可行，但每一项都是拿约 17–20 行带注释、有测试的代码，去换一个核心包的第一个外部运行时依赖——在这个体量上是净亏损。
- **以 zod/valibot 承担持久事件的严格解码器**（goal fold、tool-ralph、session）：它们是位于持久化边界、键集精确匹配、失败即明确报错、带事件专属报错信息的解码器；在仓库标准 schemastery 之外再放一个 schema 库是政策变更，不是删除。
- **以 `gpt-tokenizer`/tiktoken 替换 token-meter**：[回放 token 计量决策](../../archived/architecture/2026-07-15-replay-token-meter-service.md)已明确否决分词器后端；GPT 的 BPE 对 DeepSeek 模型来说也是错误的分词器，而且这个包约 350 行是回放折叠簿记，任何分词器都覆盖不了。
- **以 `partial-json` 处理流式工具调用参数**：无可替换——按已记录的约定，参数端到端保持为原始 JSON 字符串；`JSON.parse` 只在完整载荷上运行。

**文件系统、子进程与终端：**

- **以 `write-file-atomic` 承担 fs-local/storage-json 的原子写**：这些包缺少私有 0700 暂存目录、Win32 DACL 复制/`ReplaceFileW`、AbortSignal 支持和父目录 fsync——每一项都正是手写实现的意义所在。koffi Win32 绑定本身由 [Windows 持久发布决策](../../implemented/architecture/2026-07-05-windows-jsonl-durable-publish.zh.md)提供依据。
- **以 `fzstd`/原生 zstd 包承担 JSONL 帧扫描**：`node:zlib` 内置的 zstd 已经负责压缩（[zstd 决策](../../implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.zh.md)，其中明确否决了外部原生依赖）；剩下的 `scanZstdFrames` 为撕裂尾部修复*不做解压*地定位 RFC 8878 帧边界，没有任何包公开这项能力。
- **以 `picomatch`/`tinyglobby`/`ignore` 承担 fs 搜索**：根本不存在 glob 引擎——依照 [bash 承载的发现工具决策](../../archived/feature/2026-07-09-bash-backed-grep-glob-discovery.md)，两个发现类工具都通过 shell 调用 ripgrep。
- **以 `istextorbinary`/`chardet` 承担文本检测**：手写实现是约 15 行的 NUL 采样加 fatal 模式的 `TextDecoder`；启发式包体量更大，还会改变模型能读到哪些文件（模型可见的 `FS_NOT_TEXT` 漂移）。
- **以 `shell-quote` 承担 POSIX 单引号包裹**：两个各 1 行、测试详尽的引号辅助函数，对上一个处于维护模式、有 CVE 历史、转义输出还不一样的包——安全边界不是省一行代码的地方。
- **以 `strip-ansi` 承担 pty 净化**：pty 净化器是一台流式状态机，带跨分片的断裂序列续接和 OSC `133;D` 提示符标记提取（shell 就绪信号）；无状态的剥离器只能替掉约 20 行内层代码，全部状态机构件原样保留。`stripVTControlCharacters` 还被实证会泄漏未终止的 OSC 载荷，会话标题归一化器必须剥除它们（反欺骗）。
- **以 `pidtree`/`ps-tree` 承担 pty 进程巡检器**：它们只给裸 PID 树；这段代码需要对抗 PID 复用的启动时间身份校验，加上 `/proc` stdin 等待检测，没有包做这些。
- **以 `execa` 承担 subagent-subprocess 的 dispose（资源释放）阶梯**：`forceKillAfterDelay` 覆盖 SIGTERM→SIGKILL，但覆盖不了先发 stdin EOF 的协作层级，也覆盖不了「无退出沿即 reject」约定；在这里采用它意味着重写各 spawn 调用点、同时阶梯照旧保留。（测试基础设施的 spawn 管线是另一回事——见[已归档的 execa 测试基础设施决策](../../archived/testing/2026-07-26-execa-for-test-subprocess-plumbing.md)。）
- **以 `tree-kill` 承担 acp-snapshot 拆除与 lsp 进程终止**：那些代码行做的是排空顺序与错误传播，不是进程树遍历；lsp/bash 已经使用分离的进程组加 taskkill。
- **在 TUI 测试驱动器上到处使用 node-pty**：已归档的 [Windows TUI 决策](../../archived/feature/2026-07-20-windows-tui-support.md)明确否决了在每个宿主上都使用 node-pty；它当时已经是 Windows 那一条腿。

**服务器与 HTTP：**

- **以 `msw` 替换 llm-mock-server**：这个服务器的存在意义就是在线路上制造故障——socket 销毁、SSE（Server-Sent Events）中途断连、停滞、监听前拒绝——服务对象是真实的 HTTP 适配器和子进程；进程内拦截一样都表达不了。设计归 [llm-mock-server README](../../../../packages/test-support/llm-mock-server/README.zh.md) 所有。
- **以 `hono`/`sirv` 承担 host/webserver**：核心是基于 disposer 的动态路由注册表（「注册即效果」约定、HMR 反注册）加 index HTML 变换挂点；hono 的路由器只增不减，静态中间件也无法伺服变换后的 index。总共约 244 行，确实很小。
- **以 `@mozilla/readability`/`iconv-lite` 承担 web-fetch-http**：该提供方返回原始 HTML；字符集处理已经是内置的 `TextDecoder`；MIME 解析约 11 行；重定向跟随是同源安全策略。

**SQLite 与存储：**

- **以 `better-sqlite3` 承担三个 SQLite 后端**：三者全部使用内置 `node:sqlite`，且是双重有意为之——它是 [Node 引擎下限](../../implemented/process/2026-07-06-node-engine-floor.zh.md)的把关依据，也能在单文件可执行体内工作，原生 addon 反而会让打包复杂化。不存在任何手写的迁移或 busy 重试循环。

**仓库工具链：**

- **以 `wireit` 替换 `run-gates.ts`**：它能表达 `needs:` 图，但 allowFailure 观测支路和按模式设置的并发上限没有等价物，对一个正确性门禁运行器来说缓存必须防御性禁用，而且每一处 CI 工作流调用都要重构。[并行门禁决策](../../implemented/process/2026-07-06-parallel-pre-push-gates.zh.md)把自研调度器认作代价；保留是站得住的。
- **以 `@arethetypeswrong/cli` 替换 `verify-node-next-types`**：attw 按包运行（100+ 次调用对一次快速的全工作区编译），而且不检查仓库特有的显式 `.ts` 说明符不变式，因此扫描的那一半无论如何都得保留。记录为已考虑；保留脚本。
- **以 `syncpack`/`manypkg` 替换 `check-workspace-constraints.ts`**：它们只覆盖约 20 行的版本范围对齐；承重的 200+ 行（计算生成的 `files` 列表、cordis peer=dev 配对、层级形状）是仓库政策，没有通用引擎能表达。
- **以 `remark-validate-links` 替换 `verify-md-links.ts`**：该门禁搭载仓库共享的 mdast 工具链；采用 remark-cli 等于为删掉一个小文件而增加第二套 markdown 技术栈。
- **以 `prebuildify`/`node-gyp-build` 承担 landlock 启动器打包**：不适用——那些工具通过 dlopen 加载 `.node` addon；这个启动器交付的是独立 exec 的静态二进制，而按平台划分的 `optionalDependencies` 恰恰*就是*二进制分发的生态惯例。
- **以 `@landstrip/landstrip` 替换 Landlock 启动器本身**：未通过安全不变式检验——启动器是一个约 300 行、可完整评审的 C 文件，其二进制逐字节锁定到原生 CI 构建，且早已从一个 Rust 依赖迁移出来；单一维护者的 LGPL Rust 二进制集合有更大的审计面，其发布更难与已审阅源码对应。[Windows ACL 决策](../../implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)为已交付的 Windows 层级记录了同一否决。
- **以 `hatch-nodejs-version` 承担 Python 发布版本号**：代码行数大致持平（一个自定义 metadata 钩子换掉那个正则），却反转了「dev 哨兵值绝不决定发布版本」这条记录在案的决策，还把一个单一维护者的构建插件放进发布供应链。
- **YAML 归一（`js-yaml` 与 `yaml`）**：仓库同时携带两个解析器，`!!js` 标签在 js-yaml 上定义了四次（vendor 收录的 include、app-boot、apps/cli、`scripts/verify-cordis-config.ts`），在 `yaml` 上定义了两次（sdk-telemetry 的 `ScalarTag`、sdk-helper 的可保留注释的 Document 编辑）。方向是被迫的——js-yaml 无法取代 `yaml`（sdk-helper 需要 Document API）——但迁移 js-yaml 各调用点也退休不了这个库（vendor 收录的 include 锁定了它），还会让两个解析器共管一种必须完全一致的方言，违背[个人配置决策](../../archived/feature/2026-07-20-dsh-cli-personal-config.md)刻意的「仅加载副本」对等性。可删除的：约 20–25 行重复标签定义和两条 `@types/js-yaml` 条目。归一的时机是未来某次 include 同步，不是现在。

## 曾考虑的替代方案

- **什么都不记录，让 PR 正文承载这些裁定。** 不予采纳：PR 正文不属于受维护的记录，而普查的全部意义就在于下一次审计从这些裁定出发，而不是重新推导。
- **每一项各写一份 rejected note。** 不予采纳：为共享同一套证据标准、同一种命运的裁定制造约 30 个文件的仪式感；只有当某一项带着新证据被重新提出时，逐项 Agent Note 才有必要。
- **把每条裁定并入拥有该 seam 的 implemented note。** 部分已做——凡是持有方 Agent Note 已经否决过该替代方案的（重试、token 计量、schema DSL、zstd、沙箱、node-pty），本 note 一律援引而不重复。其余各项没有持有方 note，这正是它们记录于此的原因。
