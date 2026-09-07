# Agent Note: 拉平交付的工具清单

Status: implemented

[English](2026-07-31-even-out-shipped-tool-rosters.md) | 中文

## 问题

两个交付的 `dsh` surface 提供着不同的工具，而没有任何记录说明为什么。会话检查点、工具结果裁剪、goal 工具和 Ralph 在 `tui.cordis.yml`；`tool-todo` 以及后来的 web 搜索在 `web.cordis.yml`。两个 surface 都没有会话搜索、字符串替换编辑器和重复工具守卫，尽管这三者都已成包存在，且没有一个是 surface 专属的。

结果是一处没人做过决定的用户可见差异：同一个模型、同一个请求，在终端上能定目标而在浏览器里不能，在浏览器里能搜网页而在终端上不能。

## 决策

那些并非 surface 专属的行移入 [`base.cordis.yml`](../../../../packages/bundle/base/cordis.patch.yml)，另有三行加入：`tool-session-query`、`tool-str-replace-editor` 和 `repeat-tool-reminder`。Web 搜索也一并移入；其[部署决策](2026-07-31-web-default-search.zh.md)负责安全边界，共享 base 则负责与 surface 无关的挂载。两个 surface 组装同一份清单，其中 `glob` 和 `grep` 是固定成员，因为 `dsh-tool-fs-search` 直接 spawn [打包的 ripgrep 二进制](../../archived/architecture/2026-08-01-packaged-ripgrep-search.md)。之后有两项决策收窄这份清单：[session-search 决策](../../archived/feature/2026-08-02-session-search-not-shipped-default.md)让 `tool-session-query` 保持需显式启用，[单一编辑器决策](../../archived/simplification/2026-08-10-default-presets-single-editor.md)让通用 preset 不提供 `tool-str-replace-editor`，但在 `minimal` 中保留它。

有两行仍是 surface 专属。`tmux-context` 只在 TUI，因为浏览器 surface 没有终端复用器可描述。`session-reference` 只在 TUI，因为它以 launcher 的进程本地路径驱动共享的 session-query 索引，而浏览器侧边栏会在自己的首次搜索里重建该索引。

**本次工具清单决策当时只做加法。** 落地时两个 surface 均未移除任何工具行，目录对比只发现了新增，别无其他。后续的 session-search 与单一编辑器决策分别负责对应的默认清单例外。共享执行器、沙箱组合与访问默认值独立归属[workspace-write 默认值决策](../../archived/feature/2026-07-31-workspace-write-surface-default.md)。

### 什么保持不挂，以及为什么

有两项能力基于其自身包所记录的证据保持在外,列在这里是为了让「我们忘了」和「我们决定不要」保持可区分。

**`dsh-tool-cordis`** 让模型写一段 JavaScript 并挂成临时插件。它的 README 写明了这个界限:「The sandbox is containment for honest code, not a security boundary — host-realm helpers on the sandbox global are reachable, so mount code can reach Node」([Known limitations](../../../../packages/extensions/tool-cordis/README.zh.md))。`node:vm` 的 realm 就在 harness 进程内,而 `dsh-sandbox-local` 只约束它 spawn 出去的 argv,因此在 Web surface 上,沙箱与批准接缝是被绕过而非被执行。

**LSP 三件套**留在外面是运维原因而非安全原因:`command` 在插件加载时从 `PATH` 解析,因此缺少语言服务器会让整次启动失败,而不只是失去一个工具。等到「缺失」退化为「跳过注册」之后,它就可以挂了。

### MCP 是依赖,不是配置行

`@deepseek-ai/dsh-mcp-client` 成为本 CLI（命令行界面）的运行时依赖,但在任何交付配置里都没有对应的行。该插件每个实例只挂载一台服务器,且 `command` 是必填,因此一个默认值必须点名一台第三方服务器,并在每次启动时把它作为子进程 spawn——不经 `ctx.shell`,因而也在 Web surface 所组合的沙箱策略之外。

真正能让 MCP 成为默认的那一层,恰恰是本仓库尚未拥有的:一个读取用户服务器清单、按条目逐台挂载客户端的桥接,形态与 [`dsh-hooks-claude-code`](../../../../packages/hooks/hooks-claude-code/README.zh.md) 读取 Claude Code 的 `hooks.json` 完全相同。交付这个依赖意味着已安装的 `dsh` 能从 `$DSH_HOME/config.yaml` 挂载服务器;CLI README 里给了那段 YAML。

## 测试

`apps/cli/tests/shipped-composition.e2e.ts` 曾在伪终端中通过真实 Loader 启动交付树，并从会话日志持久化的 `request/header` 中读出工具名，因此断言的是模型实际收到的目录。它传入的 `--config` overlay `composition-keyless-tail.cordis.yml` 只用于测试隔离：一个无网络适配器，以及落在工作区内的会话产物。

该尾部还曾插入 `composition-settled.ts`，用于在终端字节流上宣告 Loader 激活已 settle。TUI 在自己的 fiber 一启动就渲染，因此在 banner 处敲下的提示词可能在工具行与持久化仍在激活时就抵达循环，从而组装出不完整的目录；把冒烟的首个提示词 gate 在该标记上，正是断言得以确定的原因。

同一份冒烟还根据同一份产物固定 TUI 的执行姿态。那些沙箱 schema 与初始权限断言归[workspace-write 默认值决策](../../archived/feature/2026-07-31-workspace-write-surface-default.md)所有，独立于本工具清单决策。

[`apps/web/tests/shipped-composition.e2e.ts`](../../../../apps/web/tests/shipped-composition.e2e.ts) 在构建产物 lane 中覆盖 Web surface,断言它的工具目录、它的访问默认值未被触碰,以及 `workspace-write` 的可写根包含临时目录——一个会让沙箱测试说谎的陷阱,当工作区落在 `/tmp` 下时([`roots.ts`](../../../../packages/sandbox/sandbox/src/roots.ts))。

`glob` 与 `grep` 被作为固定成员断言，而不是一对宿主依赖：`dsh-tool-fs-search` spawn 打包的 ripgrep 二进制并无条件注册两个工具，因此这一对始终在场。

除入库测试外,两个 surface 都以 plain Node 从构建产物 `apps/cli/lib/bin.js` 出发、用真实密钥驱动过。每一个已挂载的工具都执行成功,包括 `ralph` 与 `web_search`;模型从未触达 `cordis_*` 或 `mcp_*`,被要求做 LSP 跳转时退化到 `grep`,被要求开持久终端时用了后台 `bash` 任务。

## 曾考虑的替代方案

**把共享的行复制进两份 overlay,而不是提升到 base。** 基于「一处归属」原则否决:新增行里有三行会存在两份,而这些副本没有任何理由发生分歧,下一次改工具清单还得记着改两处。

**在同一次改动里给 TUI 加沙箱。** 不予采纳，因为这是一个不属于工具清单改动的独立决定：TUI 挂的是不受限执行器，替换它们会改变一个既有 surface 做什么，而非它提供什么。这个决定需要自己的证据——尤其因为 TUI 没有 `approval/request` 的应答方，升权请求在那里会 fail-closed，而不是弹出提示。

**开启 PTC mode。** 它的信任立场按设计与 bash 同级,工具调用要过与 bash 相同的 `tools/pre-execute` 闸门,所以它与上面那些模型写码工具不是同一个判断。在这里仍被否决:`both` 会改变两个 surface 上每一个模型可见请求,而 `ptc` 是把线路替换而非加一个——两者都是呈现方式的决定,不是工具清单的决定。

**默认挂一台 MCP 服务器。**否决，因为交付默认值必须点名一台，而任何选择都会在每个用户的机器上、在沙箱之外 spawn 一个第三方子进程。改为交付依赖。

## 后果

同一个模型在两个 surface 上拿到同样的工具,那处没有记录理由的差异消失了。测试会精确断言二十个无条件提供的名称，并把 `glob` 与 `grep` 作为固定成员钉在两侧，因此日后只改一个 surface 都会让检查失败而不是悄悄发出去；[session-search-not-shipped-default 决策](../../archived/feature/2026-08-02-session-search-not-shipped-default.md)正是这样一次后来的改动，两个测试也随之移动。

`apps/cli` 增加了五个 workspace 依赖:四个是交付树当时挂载的,外加 `dsh-mcp-client`——它并不被挂载,存在的意义是让已安装的 `dsh` 能挂。四个保留了下来——[session-search-not-shipped-default 决策](../../archived/feature/2026-08-02-session-search-not-shipped-default.md)把 `@deepseek-ai/dsh-tool-session-query` 连同它的行一起移除了。

执行策略独立于工具清单。[共享 workspace-write 决策](../../archived/feature/2026-07-31-workspace-write-surface-default.md)拥有两个 surface 的沙箱执行器与默认权限；更改该策略不会增加或移除工具。
