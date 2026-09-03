# `dsh` CLI（命令行界面）行为参考

[English](README.md) | 中文

本参考定义 profile 启动、web 别名、插件管理和配置 dump 等命令模式。argv 由 [`src/args.ts`](../src/args.ts) 统一解析一次，[`src/bin.ts`](../src/bin.ts) 只会动态导入选中的运行器。

## Profile 启动

`dsh --profile <name>` 启动位于 `$DSH_HOME/profiles/<name>` 的 profile。生效配置树以空根节点为起点，依次叠加 profile manifest（元数据清单）的 `dsh.profile.bundles` 列表中指定的各组合包 patch、profile 自身的 `cordis.patch.yml`、home 级的 `$DSH_HOME/cordis.patch.yml`（这是各 profile 共享的机器本地偏好，因此优先于逐 profile 配置层），以及按 argv 顺序指定的各个 `--patch <path>` 覆盖层。对同一配置行，后应用的层优先。patch 会替换目标行的整个 `config` 值，而不是深度合并其中的键；patch 也可以插入新行。`dsh.profile.patchReload` 可选择 `live` patch 文件监视或 `startup` 单次加载；自定义 profile 省略该值时默认使用 `live`。配置解析、schema 校验、模块解析或插件启动失败时，系统会报告错误并以非零状态退出。收到 SIGINT 或 SIGTERM 时，挂载的根节点会先 dispose（资源释放）再退出。

组合包名称先从 dsh 安装目录解析，再从 profile 目录解析。因此，内置组合包（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-sdk-app`、`@deepseek-ai/dsh-sdk-minimal`、`@deepseek-ai/dsh-acp-app`）始终来自当前运行的 `dsh` 所属的安装；树外组合包则来自 profile 中由 pnpm 管理的 `node_modules`。patch 行中的裸插件 `name` 会从 profile 目录开始，按照 Node 的模块解析规则逐级向父目录查找，直至由 dsh 维护的安装后备目录 `$DSH_HOME/profiles/node_modules`。普通 Node 安装会为依赖闭包中的每个包放置并修复一个符号链接。pkg 可执行程序则放置真实 ESM 代理，镜像显式 exports 并重新导出虚拟包 URL，因为操作系统符号链接无法进入 pkg 的 `/snapshot` 文件系统。每次启动还会把仅由所选外部 bundle 携带的包经 dsh 自有目录链接到当前 profile 的 `node_modules`；已有 pnpm 条目优先，且每个 profile 独立拥有自己的链接。

`web`、`headless`、`sdk`、`sdk-minimal` 和 `acp` profile 首次使用时会从随附模板自动初始化（`web`：base + web-app，实时应用 patch；`headless`：base + headless，只在启动时应用 patch；`sdk`：base + sdk-app，只在启动时应用 patch；`sdk-minimal`：独立组合包，只在启动时应用 patch；`acp`：base + acp-app，只在启动时应用 patch）。其他缺失的 profile 会显式报错，并提示运行 `dsh plugin --profile <name> add <package>`。

### 应用参数

启动器自身的 flag 必须写在最前面，并在遇到第一个无法识别的 token 时结束；从该 token 开始的所有内容都会通过 `ctx.cmdlineArgs` 原样交给已启动的 profile，注入该 profile 的任意应用插件都可以解析这些内容（[`dsh-cmdline`](../../../packages/boot/cmdline/README.zh.md)）。因此，`dsh --profile web --port 8080` 会将 `--port` 交给 web 应用；`dsh --profile web --help` 只打印该应用的帮助信息，不启动应用；`dsh --help` 没有可供交付参数的 profile，因此会打印启动器自身的帮助信息。`-V`/`--version` 位于应用参数边界之前时，会打印启动器的版本。

每套组合只会挂载一次。普通插件注入 `cmdlineArgs`，解析所属应用的参数，并将解析结果作为服务提供。每个从 flag 取值的配置行都会注入该服务；Loader 会等到服务激活后，再对该行的配置求值（`port: !!js ctx.webStartup.port ?? 3080`），因此 flag 的优先级高于配置行中写明的值。要维持这一优先级，配置行必须保留该表达式；如果用户 patch 用字面量替换整个 `config`，也会随之移除运行时读取。帮助参数和被拒绝的参数都会请求退出：参数被拒绝时以非零状态退出，显示帮助时以 0 退出；依赖该提供方服务的配置行不会激活。在 `patchReload: live` profile 中，编辑 patch 文件会根据仍在运行的服务重新计算表达式，因此不会重置当前正在使用的端口。

启动器的 flag 必须写在应用参数之前，且启动器的解析器会消耗掉一个 `--`：必须以字面量 `--` 送达应用的参数需要写成 `-- --`。如果应用的第一个参数恰好等于 `web` 或 `plugin`，会选择对应的子命令。`ctx.cmdlineArgs.get()` 是共享的不可变读取：多个插件可以解析同一份快照，没有读取方的 profile 则会忽略自己的应用参数。

随附的应用接受以下命令行参数：

| Profile | 参数 |
|---|---|
| `web` | `--host`、`--port`、可重复的 `--trusted-host`、`--no-open` |
| `headless` | 任务文本，作为位置参数 |
| `sdk` | 无选项；stdio 携带 JSON-RPC 协议 |
| `sdk-minimal` | 无选项；stdio 携带相同的 JSON-RPC 协议 |
| `acp` | 无选项；stdio 携带 Agent Client Protocol |

一次性任务（`dsh --profile headless "run the tests"`）通过核心注册表创建一个全新的持久化 Agent（智能体），提交任务、等待完全停稳并对会话执行 flush，再从其持久化事件区间中推导最后一个非空 assistant 文本与最终 `turn/end` 原因。它在 `dsh: reasoning:` 标题下将非空的提供方推理分片流式写入 stderr，只在 stdout 打印最终文本，并在原因为 `completed` 时以 0 退出，否则以 1 退出；没有推理内容的成功响应会保持 stderr 为空。没有任务的调用是该应用的用法错误。随附 headless profile 不挂载浏览器 Connection、HTTP 服务器、Web 运行时或浏览器客户端，也不会打开监听端口。

可在不启动的情况下检查组合出的配置树：

```sh
dsh --profile web --dump-default-config
dsh --profile web --patch ./extra.yml --dump-config
```

`--dump-default-config` 只打印组合包各层；`--dump-config` 额外加上 profile 的 `cordis.patch.yml`、home 级的 `$DSH_HOME/cordis.patch.yml` 和 `--patch` overlay。两者都会打印注释，标明每行由哪个文件提供，以及哪些 overlay 修改过它；`!!js` 表达式保持未求值，插入行中的相对插件名以各自 patch 文件所在目录解析，找不到目标的 patch 会报告到 stderr。dump 操作会初始化缺失的 profile 文件，但不会准备 `$DSH_HOME/profiles/node_modules` 下的运行时模块 fallback。它不会运行应用的命令行参数提供方，因此展示的是解析任何应用参数之前的组合配置树；如果调用中包含应用参数，dump 会拒绝该调用。

## 插件管理

`dsh plugin --profile <name> <args...>` 在 profile 缺失时先初始化它（有随附模板的用模板，其他名称只装 `@deepseek-ai/dsh-base`），然后以 profile 目录为工作目录，把 `<args...>` 转发给 `pnpm`：`add`、`remove`、`why`、`update` 及其他所有 pnpm 子命令都照常可用；pnpm 必须在 PATH 上。相对路径 spec（`.`、`../plugin` 及其 `file:`/`link:` 形式）会先锚定到调用目录，因此在插件 checkout 中执行 `add .` 安装的是该 checkout，而不是 profile。每次成功运行后，系统都会根据当前安装状态更新 `dsh.profile.bundles`：如果某项依赖解析到的包在 manifest 中声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，该依赖就会加入配置层栈；如果某项依赖在 `update` 后获得该声明，也会随即激活。没有组合包声明的依赖仍作为普通依赖保留，并显示一次性警告；已移除的依赖则从配置层栈中删除。

Codex 与 Claude Code subagent provider 是两个彼此独立的可选 Bundle。可以只添加一个包、在同一命令中添加两个包，或独立移除任一包：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-claude-code
```

pnpm 操作成功后只会改变磁盘上的 Profile manifest 与 Bundle 列表；正在运行的 Profile 会保留本次启动时的 Bundle 集合。添加、移除或更新 Bundle 后须重启该 Profile。这个启动边界只适用于 Bundle 成员变化，Profile 或 home 中普通 `cordis.patch.yml` 的编辑通过热重载生效。下一次启动时，每个已安装 Bundle 只注册自己的休眠 Host provider；还须在复制出的 Preset 中单独启用对应工具行，新 Agent 才能看到该工具。[Codex provider README](../../../packages/subagent/subagent-codex/README.zh.md)与 [Claude Code provider README](../../../packages/subagent/subagent-claude-code/README.zh.md)负责可执行文件、身份验证、载荷与失败细节；[base Bundle 参考](../../../packages/bundle/base/README.zh.md)负责默认依赖闭包。

```sh
dsh plugin --profile tui add github:deepseek-harness/turtle-ui
dsh plugin --profile tui remove turtle-ui
dsh --profile tui
```

随源码发布的 Git 托管插件会在安装期间通过 `prepare` 脚本构建，而 pnpm ≥10 默认会阻止该脚本，直到使用方明确允许。首次运行 `add` 会失败，并显示 pnpm 的 `allowBuilds` 提示；dsh 还会提示应修改该 profile 的 `pnpm-workspace.yaml`。将输出的键复制到该文件后，重新运行命令即可。安装已经构建好的 tarball 或本地 checkout 时，无需加入 `allowBuilds`。

## Web 别名

`dsh web` 是 `--profile web` 的硬编码别名；写在它之后的 flag 属于 web 应用，由组合包中的普通提供方解析。`--host` 和 `--port` 覆盖承载它们的那些行的组合取值，可重复的 `--trusted-host` 通过 `ctx.webRuntime.trustedHosts` 提供本次调用的 authority（部署表达式会拼接自己的 authority），`--no-open` 则只对本次调用关闭默认浏览器交接。客户端插件 HMR（热模块替换）接收器始终挂载，在单独运行的 `pnpm run dev:web` watcher 重建客户端 bundle 之前保持空闲。

```sh
dsh web
dsh web --no-open
dsh web --patch ./extra.cordis.yml
dsh web --dump-config
dsh web --help
```

生产 Web 运行器需要已构建的包和前端产物（`pnpm run build`）。默认服务地址是 `http://127.0.0.1:3080`；本机启动时，只在完整 Loader 配置树结算后才用默认浏览器打开该规范宿主机 URL。继承的 `SSH_CONNECTION` 或 `SSH_TTY` 非空时会跳过浏览器交接，因为本地转发地址由 SSH 客户端或编辑器持有；宿主机 URL 仍会打印。CLI 有意不支持 `--host 0.0.0.0`，并会以用法错误退出。本机交接前会打印英文提示 `dsh web: opening the default browser; pass --no-open to disable`；若操作系统交接失败，stderr 诊断会说明原因、给出 URL 供手动访问，服务器仍继续运行。`--trusted-host` 可添加 `/api` 浏览器信任围栏接受的具名 authority。

进程关闭时，插件树最多有 5 秒完成 dispose。首次收到 `SIGINT` 或 `SIGTERM` 时会开始优雅排空：`SIGTERM` 是监督进程发出的常规停止请求，在所有运行模式下都以 0 退出；`SIGINT` 则报告 130。第二次收到信号时会立即强制退出。如果一次性运行在正常结束时已经卡在 dispose 阶段，第一次按下 `Ctrl+C` 就会直接升级为强制退出，而不会被忽略。

基于 base 的模式都将运行命令时所在的目录作为默认 workspace 根目录，以 65,536 字节渲染预算加载适用的 `AGENTS.md` 或 `CLAUDE.md` 指令，并使用内存 SQLite 会话内容索引。独立的 `sdk-minimal` profile 把运行命令时所在的目录作为本地文件系统与沙箱策略根目录，但刻意省略指令发现与 SQLite。`patchReload: live` profile 会监视 profile 与 home 两个 `cordis.patch.yml` 配置层的有效变更，并以事务方式重新应用；`startup` profile 则只应用一次。一次性运行模式通过有界关闭流程退出，该流程会 dispose（资源释放）所有实时监视器。

基于 base 的 profile 中，新会话默认使用 `workspace-write` 权限预设。Bash 和文件系统修改仅限于会话 workspace 与平台临时根目录；读取和网络访问不受限制，进程可见性则取决于所选沙箱后端——bwrap 在私有 PID 命名空间中运行命令并隐藏宿主进程，Landlock 与 Seatbelt 保持宿主进程可见性不变。`DSH_PERMISSION_MODE` 更改进程后备值。General settings 中存储的权限影响后续 Web 会话，不改变已打开的会话。独立的 `sdk-minimal` 配置树则固定为 `danger-full-access`，且不挂载 approval 或权限 settings 服务。

`DSH_TOOLS_MODE` 为进程选择 `native`、`ptc` 或 `both`；其他值会导致启动失败。随附的 `minimal` agent preset 会保留该部署的呈现方式，将完整系统提示词固定为 `You are a helpful software engineer assistant.`，并且仅组合持久 `bash` 和 `str_replace_editor`。创建 Web 会话时请选择极简模式；该 agent 不包含任何其他提示词段落或面向模型的插件，而共享的浏览器、workspace、持久化、沙箱与权限宿主保持不变。

## 共享部署行为

基础组合包挂载原生 DeepSeek 适配器、settings 与凭据提供方、稳定的 `web_search` 和 `web_fetch`、仅限公网的 HTTP fetch 提供方，以及按反馈门控的会话遥测。提供方凭据依次从继承环境、`$DSH_HOME/.credentials.yaml`、调用目录的 `.env` 和 `$DSH_HOME/.env` 解析；受管文档从不物化进 `process.env`，而两个 `.env` 文件都是普通启动环境层。搜索使用 `DEEPSEEK_API_KEY` 并接受 `DEEPSEEK_SEARCH_BASE_URL`。已启用的抓取调用会在所有 sandbox 与审批模式下执行，无需逐次确认；提供方会在连接前拒绝非公开目的地址。Web app 会禁用 base 工具配置项，再通过 `cordis`、`ptc` 与 `standard` agent preset 暴露相同工具。

会话遥测默认按反馈门控共享：在用户记录 `/feedback` 之前不上传任何数据，每条已记录的反馈通过该事件上传尚未共享的会话记录；恢复的会话只共享当前生命周期。`DSH_TELEMETRY_MODE=FULL` 改为将每条已投影会话事件作为 OTLP/HTTP 日志流式发送，`DSH_TELEMETRY_MODE=DISABLED` 让全部数据留在本地，任何非空的 `DSH_TELEMETRY_DISABLED` 仍是具有最终效力的遥测强制关闭开关。`DSH_TELEMETRY_OTLP_URL` 选择其他 collector。随附基础配置没有遥测脱敏规则，因此释放的导出可能包含消息文本、工具参数和结果，以及 workspace 路径；相关部署决策见[反馈门控默认值 Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-feedback-gated-telemetry-default.zh.md)。

通过 `dsh plugin --profile <name> add <package-or-git-spec>` 安装外部插件组合包。安装的包拥有其依赖，并贡献其声明的 `cordis.patch.yml` 层。CLI 还随附 `@deepseek-ai/dsh-mcp-client` 作为供 patch 层使用的依赖，但默认不启用 MCP 服务器，因为每条服务器命令都是 agent（智能体）沙箱之外的受信任可执行代码。

<a id="source-execution"></a>
## 源码执行

请在仓库根目录中，于全新 checkout 之后及产物需要更新时单独运行 `pnpm run build`，然后使用 `pnpm dsh <args...>`。`package.json` 中的脚本不会构建，而是通过 `node --import tsx/esm` 启动 `apps/cli/src/bin.ts`，并转发所有参数。Typert Host 产物缺失时，profile 启动会因不含构建指引的模块解析错误而失败。这些 Host 产物存在后，如果前端或 Client plugin 组合包缺失，启动会失败并提示运行 `pnpm run build`。启动器不会检查产物是否为最新，因此已有的陈旧组合包可能继续运行旧版浏览器代码，直至重新构建。该进程会继承启动环境，且 `runProfile` 会在任何 entry 挂载之前从该快照解析出站代理，因此 `HTTP_PROXY`／`HTTPS_PROXY`（以及写在 `.env` 层中的代理）无需任何额外开关即可生效。安装形式会直接启动构建后的 `apps/cli/lib/bin.js`，不会重新构建仓库。
