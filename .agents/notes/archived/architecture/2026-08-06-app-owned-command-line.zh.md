# Agent Note: 应用通过 `ctx.cmdlineArgs` 持有自己的命令行

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-app-owned-command-line.md) | 中文

## 问题

profile 落地之后，组合可以安装，命令行却不能。`apps/cli` 仍然声明着 Web flag 家族（`--host`、`--port`、`--dev`、`--workspace-root`、`--trusted-host`）和一次性任务位置参数，再为自己硬编码的行 id（`webserver`、`api-gateway`、`connection`、`web-runtime`）派生 patch。像 [turtle-ui](https://github.com/deepseek-harness/turtle-ui) 这样的树外应用能贡献行，却无处接受一个 flag：`dsh --profile tui --resume <session>` 没有地方可供解析，而 `dsh --profile web --help` 打印的是启动器的 help，而不是 web 应用的 help。

## 决策

启动器只解析属于自己的部分（`--profile`、`--patch`、配置 dump），并把**自己 flag 之后的一切**原样交给引导起来的配置树。切分按位置进行：启动器不认识的第一个 token 就是应用参数的起点（依靠 commander 的 `passThroughOptions` + `allowUnknownOption` + `helpOption(false)`）。裸的 `dsh -h` 没有可交付的应用，仍然打印启动器自己的 help。

新包 `@deepseek-ai/dsh-cmdline` 持有这次交接。启动器在任何条目挂载之前调用 `provideCmdline(ctx, host)`，提供 `ctx.cmdlineArgs`（其全部接口就是 `get(): readonly string[]`）与 `ctx.appExit`。任何普通应用插件都可以注入 `cmdlineArgs`，用自己的 commander program 调用 `parseCmdline(ctx, program)`，再在 program 自己的 action 中把解析出的取值作为应用自有服务提供出去。它的 Loader 行不携带启动器标记或特殊类型，启动器也不会检查组合中的所有者。多个插件可以读取同一份不可变快照；没有读取方的 profile 会忽略自己的应用参数。由提供方配置的行注入其服务，并在惰性配置表达式中直接读取它（`port: !!js ctx.webStartup.port ?? 3080`），因此 flag 胜过写在它旁边的值，也没有任何东西被写回任何一行。

boot 只挂载一次整套组合。Cordis 让每一行等待其注入激活；Loader 随后在激活前一刻，基于已注入就绪的插件上下文插值该行的 `!!js`。Include 会保留嵌套的行表达式，直到目标行到达这一时点。`--help` 会让提供方服务保持缺失，因此依赖行永不激活；活动 patch 重载会针对仍然在线的服务再次插值，所以已经服务中的端口不会被悄悄重置。

已交付的各应用把自己的 flag 搬进了组合包：`dsh-web-app` 持有 Web 家族，`dsh-headless` 持有任务位置参数，缺少任务时按用法错误拒绝。`apps/cli/src/web.ts` 已删除；`runProfile` 不再知道任何 flag 目标行 id。在树外，turtle-ui 以同样的方式获得了 `--resume <session>` / `--session <id>`，这才是这套设计的真正验证：一个已安装的插件加上了一个 flag，启动器毫无改动。

还有两条后果。Loader 会并发挂载兄弟行，因此一行可能已经激活，而另一行仍在挂载，或整次 boot 正在回滚；所以 Web 组合包只会在自身的 Loader 配置树结算后公布 URL。另外，Web 组合包的运行时插件也持有 harness 源码提示词段，因此 `dsh web` 与 `dsh --profile web` 无需 Web 专用启动器设置即可按完全相同的方式启动。

## 为什么由 Loader 持有顺序

三条框架事实塑造了这套机制：

- **profile 的各行位于根 include 的 `patches` 选项内部。** Include 声明了 `EntryGroup.key` 树载体标记（与 Group 相同），因此 Loader 让它的配置——条目与 patch 列表，包括 Include 自己的 `path`——保持字面值，而不是在 Include 上下文中递归求值嵌套的 `!!js` 节点；每个表达式都在其目标行的 fiber 中解析。
- **Cordis 只在所有声明的注入都已激活后才激活 fiber。** 每次激活前一刻，Cordis 会基于 fiber 自身上下文运行 `internal/config` waterfall；Cordis 快照注入服务之后，Loader 的监听器再插值原始配置。
- **提供方替换与 HMR 必须保持相同契约。** fiber 重新激活时会重跑 waterfall，HMR 会把原始配置带给替换 fiber，而待处理行可以接受选项变更，不会针对缺失服务提前求值表达式。

这样，依赖顺序仍由负责它的 Cordis 激活与 Loader 插值流程处理。各行保留自己的 `inject` 和配置，Loader 只挂载一次组合，启动器只提供 argv 与进程生命周期服务。

## 曾考虑的替代方案

- **把解析出的取值写进每一行**（逐行一次配置更新，外加交还给启动器的一层 patch，使重载无法撤销它）：它能工作，但这意味着 patch 在应用与启动器之间来回传递、同一件事有两套机制，以及一套其正确性依赖 Loader 重启内部细节的回收重建。维护者否决了这次往返；供各行读取的服务取代了这一切。
- **通过清空行的 `inject` 来放行**：孤立测试可行，在真实 web 树上失败，因为清空 `inject` 恰恰会丢失插件的静态注入。在插件真的去读它声明过的服务之前，这个失败是静默的。
- **由启动器管理两趟挂载**：它可以让提供方先于读取行激活，但会重复组合、把顺序变成启动器职责，还掩盖了 Loader 的缺陷——嵌套表达式在 include 上下文而不是目标行的注入上下文中求值。
- **由启动器在 boot 之前运行每个组合包的命令函数**（完全不经过 Cordis）：严格早于「先 boot 再 help」，但这会让应用启动成为配置树之外的第二套插件协议。使用注入 `cmdlineArgs` 的普通提供方只保留一套协议，并且仍可 dump、可 patch。
- **由启动器强制指定命令行所有者**：拒绝零个或多个读取方可以裁决 `-h` 等重叠项，但 `get()` 是不可变读取，普通组合也可能需要多个应用自有服务。因此插件共享该快照，并通过普通组合持有各自解析器的交互。
- **`instanceof CommanderError`**：树外插件会带来自己的一份 commander 副本，类身份因此不同，已经打印出来的 `--help` 会被重新抛成致命的加载失败。改为按结构识别 commander 的控制流错误。

## 后果

- 应用的 flag、help 文本和用法错误与它们所配置的行放在一起；给已安装的插件加一个 flag 不需要改动启动器。
- 启动器完全不识别任何应用行：telemetry 行仍是它唯一的组合探测（用于环境开关），SIGTERM 在所有 surface 上以 0 退出，每次启动都监视用户 patch 层，一次性 runner 像任何应用一样经 `ctx.appExit` 退出。
- `--help` 会让所有依赖提供方服务的行保持待处理并请求有边界的退出；无关行可能在拆除前并发激活。
- 应用自有服务没有静态声明的提供方：交付了消费行却缺少对应提供方的组合包会在结算时失败，报出指向该服务的待处理条目，而不是在加载时失败。
- 用户 patch 若整体替换某行的 `config`，会连同其中的表达式一起丢掉，该行上 flag 的优先级也随之消失。
- 启动器的 flag 必须写在应用参数之前；如果应用的第一个参数恰好等于 `web` 或 `plugin`，会选择对应的子命令；`-V`／`--version` 在该边界之前仍归启动器持有；而且启动器的解析器会消耗掉一个 `--`，因此要给应用传一个字面量 `--` 需要写成 `-- --`。
- `--dump-config` 从不运行应用命令行提供方，因此它在任何应用参数被解析之前打印组合，并拒绝携带应用参数的调用。
