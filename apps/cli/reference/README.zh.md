# `dsh` CLI（命令行界面）行为参考

[English](README.md) | 中文

本参考定义 profile 启动、插件管理和配置 dump 等命令模式。argv 由 [`src/args.ts`](../src/args.ts) 统一解析一次，[`src/bin.ts`](../src/bin.ts) 只会动态导入选中的运行器。

<a id="profile-boot"></a>

## Profile 启动

`dsh <name>` 是 `dsh --profile <name>` 的简写，启动位于 `$DSH_HOME/profiles/<name>` 的 profile。简写中的名称必须紧跟 `dsh`；`plugin` 仍为插件管理命令，因此启动同名 profile 时须使用 `dsh --profile plugin`。生效配置树以空根节点为起点，依次叠加 profile manifest（元数据清单）的 `dsh.profile.bundles` 列表中指定的各组合包 patch、profile 自身的 `cordis.patch.yml`、home 级的 `$DSH_HOME/cordis.patch.yml`（这是各 profile 共享的机器本地偏好，因此优先于逐 profile 配置层），以及按 argv 顺序指定的各个 `--patch <path>` 覆盖层。对同一配置行，后应用的层优先。patch 会替换目标行的整个 `config` 值，而不是深度合并其中的键；patch 也可以插入新行。最终 YAML 组合决定是否由 `dsh-hmr` 监视配置；未启用 HMR 时，更改需要重启。配置解析、schema 校验、模块解析或插件启动失败时，系统会报告错误并以非零状态退出。收到 SIGINT 或 SIGTERM 时，挂载的根节点会先 dispose（资源释放）再退出。

组合包名称先从 dsh 安装目录解析，再从 profile 目录解析。因此，内置组合包（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-sdk-app`、`@deepseek-ai/dsh-sdk-minimal`、`@deepseek-ai/dsh-acp-app`）始终来自当前运行的 `dsh` 所属的安装；树外组合包来自 profile 中由 pnpm 管理的 `node_modules`。挂载配置行前，launcher 会按此顺序遍历安装与所选 bundle，并将生成的不可变 runtime resolution 安装到 Node 的解析器中。启动不会创建共享或 profile 自有的 fallback 链接。profile 已安装包保留原生优先级；profile 初始化和包管理器写入与运行时解析相互独立。

`web`、`headless`、`sdk`、`sdk-minimal` 和 `acp` profile 首次使用时会从随附模板自动初始化（`web`：base + web-app，实时应用 patch；`headless`：base + headless，只在启动时应用 patch；`sdk`：base + sdk-app，只在启动时应用 patch；`sdk-minimal`：独立组合包，只在启动时应用 patch；`acp`：base + acp-app，只在启动时应用 patch）。其他缺失的 profile 会显式报错，并提示运行 `dsh plugin --profile <name> add <package>`。

`dsh --profile <name> --from-default-profile <template>` 会在启动前，从上述五个随附模板之一初始化新的自定义目标。目标名称不能是随附 profile 名称，并且完整的目标 profile 目录必须不存在。launcher 会以独占方式领取该目录，因此残留文件和另一个并发创建者都会在不作修改的情况下被拒绝。它把模板当前的组合包列表复制进一份依赖为空、用户 patch 为空的新 manifest。它不会读取 `<template>` 指定的本地同名 profile，不会复制其依赖或 patch，也不会持久化继承字段；模板列表之后的变化不会改写新 profile。复制列表中指名的内置组合包仍从当前 dsh 安装目录解析。初始化成功不会增加 launcher 输出。

profile 已经存在时，`--from-default-profile` 会被拒绝，且不会修改或启动它；去掉该选项即可使用它。残留的目标目录同样会被原样保留，此时必须改用另一个 profile 名称。未知模板或随附目标名称会在创建目标之前失败；未知模板的诊断会列出有效模板。初始化在组合包解析和应用启动之前提交，因此后续失败仍会把新 profile 留在磁盘上，重试时需要去掉创建选项。三种配置 dump 模式都接受该选项，并在不启动应用的情况下初始化目标。

```sh
dsh rescue --from-default-profile web
dsh rescue
```

### 应用参数

启动器自身的 flag 必须写在最前面，并在遇到第一个无法识别的 token 时结束；从该 token 开始的所有内容都会通过 `ctx.cmdlineArgs` 原样交给已启动的 profile，注入该 profile 的任意应用插件都可以解析这些内容（[`dsh-cmdline`](../../../packages/boot/cmdline/README.zh.md)）。因此，`dsh rescue --from-default-profile web --no-open` 会先初始化，再把 `--no-open` 交给 Web；`dsh --profile web --port 8080` 会将 `--port` 交给 web 应用；`dsh --profile web --help` 只打印该应用的帮助信息，不启动应用；`dsh --help` 没有可供交付参数的 profile，因此会打印启动器自身的帮助信息。`-V`/`--version` 位于应用参数边界之前时，会打印启动器的版本。

每套组合只会挂载一次。普通插件注入 `cmdlineArgs`，解析所属应用的参数，并将解析结果作为服务提供。每个从 flag 取值的配置行都会注入该服务；Loader 会等到服务激活后，再对该行的配置求值（`port: !!js ctx.webStartup.port ?? 3080`），因此 flag 的优先级高于配置行中写明的值。要维持这一优先级，配置行必须保留该表达式；如果用户 patch 用字面量替换整个 `config`，也会随之移除运行时读取。帮助参数和被拒绝的参数都会请求退出：参数被拒绝时以非零状态退出，显示帮助时以 0 退出；依赖该提供方服务的配置行不会激活。启用 HMR 时，编辑 patch 文件会根据仍在运行的服务重新计算表达式，因此不会重置当前正在使用的端口。

启动器的 flag 必须写在应用参数之前，且启动器的解析器会消耗掉一个 `--`：必须以字面量 `--` 送达应用的参数需要写成 `-- --`。`plugin` 仅在紧跟 `dsh` 时选择插件管理命令；选定 profile 后，`plugin` 和 `web` 都是普通应用参数。应用参数开始之前，重复指定 `--profile` 会被拒绝，包括简写后再指定 `--profile` 的情况。`ctx.cmdlineArgs.get()` 是共享的不可变读取：多个插件可以解析同一份快照，没有读取方的 profile 则会忽略自己的应用参数。

随附的应用接受以下命令行参数：

| Profile | 参数 |
|---|---|
| `web` | `--host`、`--port`、可重复的 `--trusted-host`、`--no-open` |
| `headless` | 任务文本，作为位置参数 |
| `sdk` | 无选项；stdio 携带 JSON-RPC 协议 |
| `sdk-minimal` | 无选项；stdio 携带相同的 JSON-RPC 协议 |
| `acp` | 无选项；stdio 携带 ACP（Agent Client Protocol） |

一次性任务（`dsh --profile headless "run the tests"`）通过核心注册表创建一个全新的持久化 Agent（智能体），提交任务、等待完全停稳并对会话执行 flush，再从其持久化事件区间中推导最后一个非空 assistant 文本与最终 `turn/end` 原因。它在 `dsh: reasoning:` 标题下将非空的提供方推理（reasoning）增量流式写入 stderr，只在 stdout 打印最终文本，并在原因为 `completed` 时以 0 退出，否则以 1 退出；没有推理内容的成功响应会保持 stderr 为空。没有任务的调用是该应用的用法错误。随附 headless profile 不挂载浏览器 Connection、HTTP 服务器、Web 运行时或浏览器客户端，也不会打开监听端口。

可在不启动的情况下检查组合出的配置树：

```sh
dsh --profile web --dump-default-config
dsh --profile web --patch ./extra.yml --dump-config
```

`--dump-default-config` 只打印组合包各层；`--dump-config` 额外加上 profile 的 `cordis.patch.yml`、home 级的 `$DSH_HOME/cordis.patch.yml` 和 `--patch` overlay。两者都会打印注释，标明每行由哪个文件提供，以及哪些 overlay 修改过它；`!!js` 表达式保持未求值，插入行中的相对插件名以各自 patch 文件所在目录解析，找不到目标的 patch 会报告到 stderr。dump 操作会初始化缺失的 profile 文件。它不会运行应用的命令行参数提供方，因此展示的是解析任何应用参数之前的组合配置树；如果调用中包含应用参数，dump 会拒绝该调用。

<a id="config-schema-dump"></a>
### 配置 schema dump

`--dump-config-schema` 使用与 `--dump-config` 相同的组合包、profile、home 和 argv patch 层，支持可重复的 `--patch` 与 `--from-default-profile`。三种 dump flag 互斥，并拒绝应用参数和保留的 `desktop` profile。组合成功后，stdout 输出一份缩进排版的 JSON Schema 2020-12 文档。根 schema 描述 `--dump-config` 输出经解析后的 entry list；`$defs.patchList` 单独描述 profile/home/CLI overlay。验证该片段时应保留文档的 `$defs`。准备、patch 解析/组合或解析器设置失败时，以非零退出码结束，不输出 schema。收集或投影失败时保留部分输出并退出 1；诊断也会输出到 stderr。即使 stdout 中的 schema 有效且可用，`partial` 投影或省略非 JSON 注释也适用此退出码。schema dump 的未匹配目标警告不包含层标签；需要来源标签时，使用相同配置层运行 `--dump-config`。

插件 Config 的字段、默认值、描述及支持的约束从原生 Schemastery 声明投影。普通字段内联，共享 Config 和递归使用 `$ref`。JSON Schema 的默认值是注释，不执行填值。必填字段会考虑 Schemastery 的 nullable fallback 能否通过验证。联合类型使用 `anyOf`，而原生执行仍选择首个成功分支。`secret`、`credential-ref`、`ms` 等 role 元信息及 `volatile` 实时更新元信息保留在 `x-cordis` 注释中。非法 volatile 嵌套属于 schema 定义错误；字段输入类型不会变成引用对象类型。回调验证、不支持的正则语义及其他未投影约束会标记为 partial，而不是静默丢弃。非有限数边界和非 JSON 默认值/展示注释会被省略并附上限制说明，结构字段仍可用。对象常量保留普通 nullable 成员约束，但继承属性的比较会标记为 partial。无法表示的默认值、不支持的交集及无法求解的递归默认值依赖保留未知的省略行为，仍需原生验证。

使用 Cordis entry-list 方言解析 YAML：`!!js` 标量变为不执行的 `{ "__jsExpr": "..." }` 标记。普通 Config 值和 entry 的 `disabled` 接受这些标记，但不求值其结果。Group 列表和 Include 字段保持字面量。entry id 可省略；缺少非空 id 的非 insert patch 被接受为无操作，并由 Loader 警告。禁用项可以省略必需的 Config，除非 `group: true` 强制激活；disabled 表达式也使省略行为留待运行时决定。已提供的 Config 值仍接受验证。`disabled` 接受布尔值、null 和表达式标记；Loader 会把其他真值强制视为禁用，但此 schema 拒绝它们。未设置 `group: true` 的禁用 group 或 include 的子项不接受验证，因为 Loader 从不创建它们。禁用的 `group: true` 行之下的子项，以及插入到禁用 group 的 patch，都按启用状态验证，尽管 Loader 不会初始化祖先被禁用的子项。已知根树目标验证完整 Config 替换，而不是深层 partial 对象。不推断 Include 内部 id，也不推断前序 patch 新增或改变的顺序相关目标。未知插件名保持开放；同名插件解析出不同 schema 时，使用联合约束并报告歧义。

根 `x-cordis` 注释包含 `profile`、`complete`、`entries`、`diagnostics` 和 `patchSchema`。配置项按遍历顺序保留 `path`、可选 `id`、`name`、`status` 和 `configRef`；状态为 `schema`、`partial`、`absent`、`unsupported` 或 `error`。可选的 `tree: "group" | "include"` 标识原生承载插件：它们可能因未导出 Config 而具有 `status: "absent"`，但 `configRef` 指向 Loader 结构定义。被检查的非法条目会获得带位置的错误，不丢弃有效的相邻条目；没有字面量名称时省略 `name`。列表容器非法或 include patch 组合失败时，在承载条目上报告诊断；组合失败后该 include 的子项不可用，不会把未应用 patch 或过滤后的子项当作最终结果。未设置 `group: true` 的禁用承载条目可以省略 config，并记录为没有子项的树。投影限制会在共享该 Config 的每个条目上重复报告。Config 缺失表示字段未知，不表示禁止配置。group 子项的发现路径追加 `/config/<index>`，include 子项追加 `/include/<index>`；后者不是根 dump 中的 JSON Pointer。存在错误诊断、`partial`/`unsupported`/`error` 条目，或同一插件名对应多个 Config 定义时，`complete` 为 false。此参考覆盖所有声明，包括禁用项：它们的导入或 include 失败可能使可启动的 profile 也被标为不完整。运行时生成的 preset/客户端树及插件启动检查不属于此参考范围；反过来，`complete` 也不保证启动成功。

可能修改输入的前序 union 分支，以及可能改名或碰撞的字典键，需要放宽验证。Lazy 元数据传播可能影响当前 Config 之外的共享节点，因此该 Config 保留可获得的声明细节，同时增加不受限制的备选项，而不模拟原生修改。这些情况标记为 partial，仍需原生验证。

收集会导入可信模块，也可能调用 Config getter 和 lazy builder，但绝不应用插件、执行 transform 回调或求值配置表达式。导入可能在输出前后阻塞或保留进程句柄；自动调用方应设置外部超时。dump 不强制退出，也不持有导入期间资源的释放职责。导入或 builder 对 stdout 的常规写入转向 stderr；直接写文件描述符不被拦截。profile 准备保留 YAML dump 的初始化写入。输出只有 schema 声明，没有实际配置值；声明的默认值和插件原始错误仍可能含敏感数据，分享前应检查。收集器 API 参见 [app-boot](../../../packages/boot/app-boot/README.zh.md)。

输出是可重新生成的 pre-stable 参考，不是单独版本化的持久化目录。`$schema` 标识 JSON Schema 验证方言；`x-cordis` 随 dsh 版本演进。更改 dsh 或插件后应重新生成，并跟随 `$ref` 和 `configRef`，而非硬编码定义名、顺序或文本。不兼容的方言变更使用新的 `$schema`；注释变更不采用 Session 格式迁移。

<a id="startup-diagnostics"></a>
## 启动诊断

必需插件激活失败时，CLI 先输出失败插件及其原始堆栈，再列出等待中的插件和缺失服务。等待列表中的必需插件排在前面。末尾的 `Full diagnostics:` 行指向直接位于 `$DSH_HOME/logs/`（默认 `~/.dsh/logs/`）下的唯一 `startup-<timestamp>-<uuid>.log` 文件。CLI 完成报告和 stderr 写入后会明确以退出码 1 结束，即使插件仍有打开的句柄；不会覆盖以前的报告，也不会自动删除它们。

报告包含 DSH 和 Node 版本、平台、profile、根配置路径、每个未激活插件的模块与状态、原始错误，以及启动期间的警告和错误参数，包括尚无 Fiber 的导入错误。Node 检查输出保留嵌套原因、聚合成员、循环引用、不可枚举属性和 Symbol 属性，并关闭深度、字符串及数组长度限制。自定义检查函数被禁用，访问器只描述而不求值。收集器包含失败后的异步清理日志，并在启动结算后停止。它不会独立于已记录错误额外收集环境变量或配置内容。插件原始错误可能包含配置或凭据值；报告开头会提醒读者在分享前检查内容。报告不脱敏。

在 POSIX 上，新目录和文件分别请求 `0700` 和 `0600` 权限。CLI 仅在写入成功后输出文件路径。如果日志目录或文件无法写入，stderr 会包含写入错误及完整报告，退出码仍为 1。只有可选插件激活异常时，维持正常警告输出，不创建报告。

## 插件管理

`dsh plugin --profile <name> <args...>` 在 profile 缺失时先初始化它（有随附模板的用模板，其他名称只装 `@deepseek-ai/dsh-base`），然后以 profile 目录为工作目录，把 `<args...>` 转发给 `pnpm`：`add`、`remove`、`why`、`update` 及其他所有 pnpm 子命令都照常可用；pnpm 必须在 PATH 上。相对路径 spec（`.`、`../plugin` 及其 `file:`/`link:` 形式）会先锚定到调用目录，因此在插件 checkout 中执行 `add .` 安装的是该 checkout，而不是 profile。每次成功运行后，系统都会根据当前安装状态更新 `dsh.profile.bundles`：如果某项依赖解析到的包在 manifest 中声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，该依赖就会加入配置层栈；如果某项依赖在 `update` 后获得该声明，也会随即激活。没有组合包声明的依赖仍作为普通依赖保留，并显示一次性警告；已移除的依赖则从配置层栈中删除。

Codex 与 Claude Code subagent 提供方是两个彼此独立的可选组合包。可以只添加一个包、在同一命令中添加两个包，或独立移除任一包：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-claude-code
```

pnpm 操作成功后会改变磁盘上的 Profile manifest 与组合包列表；正在运行的 Profile 会保留本次启动时的组合包集合。添加、移除或更新组合包后须重启该 Profile。这个启动边界只适用于组合包成员变化，Profile 或 home 中普通 `cordis.patch.yml` 的编辑通过热重载生效。下一次启动时，每个已安装组合包只注册自己的休眠 Host 提供方；还须在复制出的 Preset 中单独启用对应工具行，新 Agent 才能看到该工具。[Codex provider README](../../../packages/subagent/subagent-codex/README.zh.md) 与 [Claude Code provider README](../../../packages/subagent/subagent-claude-code/README.zh.md) 负责可执行文件、身份验证、载荷与失败细节；[base 组合包参考](../../../packages/bundle/base/README.zh.md) 负责默认依赖闭包。

```sh
dsh plugin --profile tui add github:deepseek-harness/turtle-ui
dsh plugin --profile tui remove turtle-ui
dsh --profile tui
```

随源码发布的 Git 托管插件会在安装期间通过 `prepare` 脚本构建，而 pnpm ≥10 默认会阻止该脚本，直到使用方明确允许。首次运行 `add` 会失败，并显示 pnpm 的 `allowBuilds` 提示；dsh 还会提示应修改该 profile 的 `pnpm-workspace.yaml`。将输出的键复制到该文件后，重新运行命令即可。安装已经构建好的 tarball 或本地 checkout 时，无需加入 `allowBuilds`。

## Web Profile

`dsh web` 使用 profile 简写。启动器先解析自身的 flag，其余 flag 属于 web 应用，由组合包中的普通提供方解析。`--host` 和 `--port` 覆盖承载它们的那些行的组合取值，可重复的 `--trusted-host` 通过 `ctx.webRuntime.trustedHosts` 提供本次调用的 authority（部署表达式会拼接自己的 authority），`--no-open` 则只对本次调用关闭默认浏览器交接。客户端插件 HMR（热模块替换）接收器始终挂载，在 `pnpm run dev:web` 重建客户端 bundle 之前保持空闲；该命令先构建一次，再启动这同一个启动器并持续重建客户端 bundle，加 `--no-serve` 则只运行 watcher、配合别处启动的 `dsh web`。

```sh
dsh web
dsh web --no-open
dsh web --patch ./extra.cordis.yml
dsh web --dump-config
dsh web --help
```

生产 Web 运行器需要已构建的包和前端产物（`pnpm run build`）。默认服务地址是 `http://127.0.0.1:3080`；本机启动时，只在完整 Loader 配置树结算后才用默认浏览器打开该规范宿主机 URL。继承的 `SSH_CONNECTION` 或 `SSH_TTY` 非空时会跳过浏览器交接，因为本地转发地址由 SSH 客户端或编辑器持有；宿主机 URL 仍会打印。CLI 有意不支持 `--host 0.0.0.0`，并会以用法错误退出。本机交接前会打印英文提示 `dsh web: opening the default browser; pass --no-open to disable`；若操作系统交接失败，stderr 诊断会说明原因、给出 URL 供手动访问，服务器仍继续运行。`--trusted-host` 可添加 `/api` 浏览器信任围栏接受的具名 authority。

进程关闭时，插件树最多有 5 秒完成 dispose。首次收到 `SIGINT` 或 `SIGTERM` 时会开始优雅排空：`SIGTERM` 是监督进程发出的常规停止请求，在所有运行模式下都以 0 退出；`SIGINT` 则报告 130。第二次收到信号时会立即强制退出。如果一次性运行在正常结束时已经卡在 dispose 阶段，第一次按下 `Ctrl+C` 就会直接升级为强制退出，而不会被忽略。

基于 base 的模式都将运行命令时所在的目录作为默认 workspace 根目录，以 65,536 字节渲染预算加载适用的 `AGENTS.md` 或 `CLAUDE.md` 指令，并使用内存 SQLite 会话内容索引。独立的 `sdk-minimal` profile 把运行命令时所在的目录作为沙箱策略根目录，但刻意省略文件系统工具、指令发现与 SQLite。启用的 HMR 插件会监视 profile 与 home 两个 `cordis.patch.yml` 配置层的有效变更，并以事务方式重新应用；未启用 HMR 时只应用一次。一次性运行模式通过有界关闭流程退出，该流程会 dispose 所有实时监视器。

基于 base 的 profile 中，新会话默认使用 `workspace-write` 权限预设。Bash 和文件系统修改仅限于会话 workspace 与平台临时根目录；读取和网络访问不受限制，进程可见性则取决于所选沙箱后端——bwrap 在私有 PID 命名空间中运行命令并隐藏宿主进程，Landlock 与 Seatbelt 保持宿主进程可见性不变。`DSH_PERMISSION_MODE` 更改进程后备值。General settings 中存储的权限影响后续 Web 会话，不改变已打开的会话。独立的 `sdk-minimal` 配置树则固定为 `danger-full-access`，且不挂载 approval 或权限 settings 服务。

`DSH_TOOLS_MODE` 为进程选择 `native`、`ptc` 或 `both`；其他值会导致启动失败。随附的 `minimal` agent preset 会保留该部署的呈现方式，将完整系统提示词固定为 `You are a helpful software engineer assistant.`，并且仅组合按平台选择的持久 shell。创建 Web 会话时请选择极简模式；该 agent 不包含任何其他提示词段落或面向模型的插件，而共享的浏览器、workspace、持久化、沙箱与权限宿主保持不变。

## 共享部署行为

基础组合包挂载原生 DeepSeek 适配器、settings 与凭据提供方、稳定的 `web_search` 和 `web_fetch`、仅限公网的 HTTP fetch 提供方，默认开启的 DeepSeek 会话日志上传，以及面向所有用户的反馈门控 OTel 上传。提供方凭据依次从继承环境、`$DSH_HOME/.credentials.yaml`、调用目录的 `.env` 和 `$DSH_HOME/.env` 解析；受管文档从不物化进 `process.env`，而两个 `.env` 文件都是普通启动环境层。搜索使用 `DEEPSEEK_API_KEY` 并接受 `DEEPSEEK_SEARCH_BASE_URL`。已启用的抓取调用会在所有 sandbox 与审批模式下执行，无需逐次确认；提供方会在连接前拒绝非公开目的地址。Web app 会禁用 base 工具配置项，再通过 `cordis`、`ptc` 与 `standard` agent preset 暴露相同工具。

反馈记录在会话日志中，不会启动模型工作。[DeepSeek 会话日志贡献器](../../../packages/session/session-log-deepseek/README.zh.md)默认随后续 DeepSeek 请求发送尚未确认接收的完整日志后缀，包括经已配置网关发送的请求；将其 `enabled` 配置设为 `false` 可关闭上传。[OTel 会话上传](../../../packages/session/session-telemetry-otel/README.zh.md)适用于所有用户和提供方，包括 `deepseek-official`，无需请求头。基础配置默认使用 `FEEDBACK_ONLY`：新的自身文本反馈、消息评分、编辑与撤回会释放截至该事件的完整规范日志前缀，包含存储的上下文；后续记录等待下一次显式反馈。继承的父级反馈不构成 fork 的授权。请求、恢复、挂载和 HMR 不触发捕获。SDK 批处理可完成已授权上传，无需进一步交互或模型工作。`DSH_TELEMETRY_MODE=DISABLED` 禁止 OTel 投递；`FULL` 被拒绝，任何非空的 `DSH_TELEMETRY_DISABLED` 都会禁用其配置行。`DSH_TELEMETRY_OTLP_URL` 选择采集端。交接尽力而为，不代表采集端接受；不提供持久化 outbox 或重试保证。这些 OTel 设置不会开启或关闭 DeepSeek 贡献。两条路径都不改变模型输入，但导出可能包含消息文本、工具参数和结果，以及工作区路径。

通过 `dsh plugin --profile <name> add <package-or-git-spec>` 安装外部插件组合包。安装的包拥有其依赖，并贡献其声明的 `cordis.patch.yml` 层。CLI 还随附 `@deepseek-ai/dsh-mcp-client` 作为供 patch 层使用的依赖，但默认不启用 MCP 服务器，因为每条服务器命令都是 agent 沙箱之外的受信任可执行代码。

<a id="source-execution"></a>
## 源码执行

请在仓库根目录中，于全新 checkout 之后及产物需要更新时单独运行 `pnpm run build`，然后使用 `pnpm dsh <args...>`。`package.json` 中的脚本不会构建，而是通过 `node --import tsx/esm` 启动 `apps/cli/src/bin.ts`，并转发所有参数。Typert Host 产物缺失时，profile 启动会因不含构建指引的模块解析错误而失败。这些 Host 产物存在后，如果前端或 Client plugin 组合包缺失，启动会失败并提示运行 `pnpm run build`。启动器不会检查产物是否为最新，因此已有的陈旧组合包可能继续运行旧版浏览器代码，直至重新构建。该进程会继承启动环境，且 `runProfile` 会在任何 entry 挂载之前从该快照解析出站代理，因此 `HTTP_PROXY`／`HTTPS_PROXY`（以及写在 `.env` 层中的代理）无需任何额外开关即可生效。源码入口显式选择链接式 profile 解析，使 tsx workspace 导入与 profile 插件共享模块身份。安装形式会使用 runtime profile 解析直接启动构建后的 `apps/cli/lib/bin.js`，不会重新构建仓库。
