# Agent Note: 单文件可执行的 SDK 运行时分发（single-exe）

Status: implemented

[English](2026-07-10-single-file-executable-sdk-runtime-distribution.md) | 中文

## 问题

DeepSeek Harness 需要为 Python 库专门提供一种无需安装 Node、可直接在目标平台运行的 SDK 分发形态：一个单文件可执行程序（下称 exe），通过 stdio 提供 JSON-RPC 对外服务接口（`HarnessSdkJsonRpcServer`，Python SDK 的对端），且实际启动的插件与配置完全由 exe 外部输入的 `cordis.yml` 决定。

- 与 Python SDK 通信的 JSON-RPC 协议已经过验证
- 需要提供一种让 `cordis.yml` 加载所有插件（ES 模块）的标准方式
- 分发物要自带 Node 运行时，并支持本地源码链接的调试模式

## 决策

### 打包路线：@yao-pkg/pkg 的 `--sea` 模式

exe 使用 [@yao-pkg/pkg](https://github.com/yao-pkg/pkg)（vercel/pkg 归档后的活跃维护 fork）的 **`--sea`（enhanced SEA）模式**打包。相比 Node 原生 SEA，pkg 在其上增加 `/snapshot` 虚拟文件系统（VFS）与运行时模块钩子，将 ESM 入口原样交给 Node 默认的 ESM loader，不依赖任何 ESM→CJS 转译。
> 实测（macos-arm64、node24 构建目标、pkg 6.21.0）：VFS 内裸包名 ESM 动态 `import()`（含顶层 `await`）、CJS 互操作、`node:sqlite`、集合外包名明确报错、VFS 外磁盘 ESM `import()` 全部通过，`import.meta.url` 原样为 `file:///snapshot/...`。

`--sea` 要求构建目标 ≥ node22，exe 统一以 node24 为构建目标；每次 pkg 调用只打包一个构建目标，多平台各调用一次。

`@yao-pkg/pkg` 是精确钉版的根 `devDependency`，经 `pnpm exec pkg` 调用，并以 [`patches/@yao-pkg__pkg@6.21.0.patch`](../../../../patches/@yao-pkg__pkg@6.21.0.patch) 移除 SEA bootstrap 中的 `patchChildProcess` 调用。未打补丁时，pkg 会把 spawn 的 `node` 命令——包括 `-c`/`/c` 标志后的命令串，恰是 Bash 工具的 `bash -c` 形态——改写为 exe 自身，并向每个子进程环境注入 `PKG_EXECPATH`，模型下发的 `node --version` 会静默启动 dsh CLI；Node 自身的 SEA 层没有这种改写，且 SEA 二进制永远启动内嵌应用、无法充当纯 Node。移除该调用后，子进程像普通进程一样经 PATH 解析 `node`（无 Node 的机器如实报 command not found），子进程环境不再出现 `PKG_EXECPATH`，以 `process.execPath` 绝对路径 spawn 的重入不受影响，worker 线程本来就未应用该钩子，`process.pkg` 侧车选择也不受影响。

术语提醒：pkg 的 `/snapshot` VFS 与本仓库测试体系的「快照」（ACP（Agent Client Protocol）回放预期输出、`$DSH_SNAPSHOT`）无关，本文用「VFS」指前者。

### 对外服务接口是 dsh 应用中的插件

确定性服务接口由打包后的 `dsh` 应用选择为插件：

- [`packages/sdk/server`](../../../../packages/sdk/server/README.zh.md)（`@deepseek-ai/dsh-sdk-jsonrpc-server`）：纯协议插件；执行 `apply` 时，在进程 stdio 上挂载 `HarnessSdkJsonRpcServer` 与按行分隔的 JSON-RPC 传输层，资源释放走 `ctx.effect()`。是否提供服务由 `cordis.yml` 决定；未挂载该插件的配置会启动一个不提供此服务的合法进程。协议级退出归插件所有（应答并确保 `shutdown` 响应发送完毕后，对根运行时执行 dispose（资源释放），让待处理的持久化操作完成，再调用 `exit(0)`；HMR（热模块替换）式卸载只停止服务，不退出进程）。
- [`apps/cli`](../../../../apps/cli/README.zh.md)（`@deepseek-ai/dsh`）：打包后的应用入口；其 `sdk` profile 挂载 `dsh-sdk-jsonrpc-server`，CLI 负责环境分层、profile 组合、stdin／signal 关闭与进程退出。

Python 客户端提供显式 Harness home，并选择 `sdk` profile 与有序 patch 文件。缺失 home、profile、bundle 或 server 配置项都会明确失败；不存在外部完整配置回退。[Python profile 运行时决策](2026-08-23-python-sdk-dsh-profile-runtime.zh.md)负责该应用接口。

### 插件解析：VFS 装载真实包树，闭包 manifest（元数据清单）就是部署根目录

exe 的 VFS 内是**构建产物形态的真实包树**（各包的 `lib/` + 真实 `node_modules`）。打包专用 JSON-RPC 入口会向 app-boot 的根 Include 提供自身已安装 harness 的基准位置：相对插件说明符从外部配置目录解析，裸包名则从 VFS 解析，因此位于另一个 Node 项目内的配置无法遮蔽已打包的插件集合。普通开发 bin 仍由配置项目提供裸包。打包入口中的裸包名从该入口在 VFS 内的位置沿 `node_modules` 向上解析，自然落在 VFS 内。封闭集不需要白名单代码——VFS 中安装了什么，集合中就有什么；`import()` 集合外的名称会失败。

部署根目录是 [`python/sdk-runtime/package.json`](../../../../python/sdk-runtime/package.json)（`dsh-python-runtime-closure`，pnpm 工作区成员、零代码纯依赖 manifest），也是「exe 安装哪些插件」与「Python 运行时分发什么」的统一真源。向 exe 添加插件，就是在 manifest 中增加一行依赖后重新打包。[`scripts/verify-runtime-closure.ts`](../../../../scripts/verify-runtime-closure.ts) 读取每个已发布的 `packages/preset/agent-presets/presets/*/agent.cordis.yml`，针对 `python/sdk-runtime/platforms.json` 中的每个目标解析比较 `process.platform` 的 `disabled` 条件，并要求该目标启用的每个工作区插件都通过显式的 `workspace:` 依赖列在运行时根目录。它还遍历该 manifest 覆盖的全部工作区包，要求每个非可选的工作区对等依赖（peer dependency）都显式列出，并报告“preset 或引用包 → 缺失依赖”的完整链路；无法识别的平台条件会保持启用，避免因不支持的表达式遗漏插件。`pnpm run hygiene`、CI 静态检查与 single-exe 构建都会在打包前运行该门禁。部署还会依据各包的 `files` 字段打包，因此 tsdown 拆出的共享分片必须被 `files` 覆盖。

部署根目录显式包含 `@deepseek-ai/dsh-mcp-client`，将其作为自定义配置可用的插件，即使随附 preset 均未挂载该插件。外部配置因此可以连接由用户提供的 stdio 与 Streamable HTTP MCP server 并注册其工具；分发物不包含这些 server，也不将桥接范围扩展到 MCP Resources 和 Prompts。可执行程序与已安装 wheel 包的冒烟测试会启动临时 stdio server，发现其工具，并完成一次由模型请求的调用。

### 构建流水线与产物

[`scripts/build-exe-for-python-sdk.ts`](../../../../scripts/build-exe-for-python-sdk.ts)：运行时闭包校验 → `pnpm run build` →（清空后）`pnpm --filter dsh-python-runtime-closure deploy --legacy --prod --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true` **直接写入** `python/sdk-runtime/src/deepseek_harness_runtime/runtime/node/` → 恢复 legacy deploy 遗漏的直接工作区包，并拒绝剩余的 manifest 缺口 → 将暂存依赖中的符号链接替换为目标文件内容，删除包管理器的 `.bin` 链接，并在仍有任何符号链接时失败 → 注入 pkg 配置，其中 bin 为 `node_modules/@deepseek-ai/dsh/lib/bin.js`，assets 覆盖动态读取的 profile、bundle、前端、preset、原生库与配置文件 → 暂存目标平台的 `node-pty` addon → 每个构建目标调用一次 `pkg --sea` → 将 `deepseek-harness-sdk-runtime-<platform>-<arch>` 写入 `dist-exe/` 并拷回运行时目录。Linux CI 会在匹配的 manylinux 2.28 容器中重新构建 `pty.node`，因为 legacy deploy 会遗漏这一安装副作用。每个目标都会把对应的原生 `@vscode/ripgrep` 二进制复制到可执行文件旁，作为必需的 `-rg` 伴随文件；pkg 运行时通过 `process.pkg` 选择该伴随文件，普通 Node 执行则直接使用 `@vscode/ripgrep`。macOS 使用对应目标的预构建产物，并额外生成所需的 `-spawn-helper`。四个部署标志都有实测依据：未启用 `inject-workspace-packages` 时必须使用 `--legacy`；`hoisted` 为 pkg 提供稳定的单实例布局，再由显式物化步骤消除符号链接；关闭对等依赖自动安装可防止未声明的对等依赖扩大闭包；`link-workspace-packages` 选择直接工作区依赖。[`pnpm-workspace.yaml`](../../../../pnpm-workspace.yaml) 将传递的 `@deepseek-ai/cosmokit` 与 `@deepseek-ai/schemastery` semver 请求覆盖到固定的 vendor 源码，使 legacy deploy 不会从注册表解析这些未发布名称。

CI 使用 [`.github/workflows/build-exe-for-python-sdk.yml`](../../../../.github/workflows/build-exe-for-python-sdk.yml)：[安装后 wheel Python 运行时拉取请求验证](../testing/2026-08-23-installed-python-wheel-black-box-ci.zh.md)与[公开发布工作流](../process/2026-08-11-python-publication-workflow.zh.md)都会调用它构建全部五个目标；`workflow_dispatch` 仍可选择部分目标。linux-x64、linux-arm64（`ubuntu-24.04-arm`）、macos-arm64、macos-x64（`macos-15-intel`）与 win-x64（`windows-2025`）分别进行原生构建，并在适用平台缓存 `~/.pkg-cache`；macOS 的 ad-hoc 签名由 pkg 处理。每个平台都把发布形态的 SDK wheel 包与运行时 wheel 包安装到 checkout 外的干净 venv，证明包与可执行文件来源，再通过公开 SDK 与直接 NDJSON JSON-RPC 运行完整 keyless 场景。可信拉取请求还会在每个目标上运行真实 DeepSeek 双轮工具冒烟测试；fork 与 Dependabot head 不会获得密钥。Linux 会检查可执行文件和原生 addon 各自的 GLIBC 依赖，并额外运行 manylinux 2.28 冒烟测试；macOS 则检查 runtime、ripgrep 与 PTY helper 的架构，并验证三个载荷的部署目标都符合 wheel 包标签。完整构建五个目标时保留 6 个产物，每个产物只含一个发布文件：平台无关的 SDK wheel 包与 5 个原生运行时 wheel 包；手动选择部分目标时保留 SDK wheel 与所选运行时 wheel。裸 exe 与源码包只作为测试中间输入。[`.gitlab-ci.yml`](../../../../.gitlab-ci.yml) 只接受版本与根目录 `package.json` 匹配的 `python-v<repository-version>` 标签流水线，构建一个 SDK wheel 包和 5 个原生运行时 wheel 包，再由单个串行任务校验并将这 6 个文件发布到项目的 PyPI 注册表。[Windows x64 运行时决策](2026-08-23-python-sdk-windows-x64-runtime.zh.md)负责 Windows 目标及对 Windows arm64 的明确排除。

### Python SDK 分发：双载体，exe 用于生产，`node` 用于开发

Python SDK 位于 [`python/`](../../../../python/README.zh.md)：`python/sdk` 是客户端，`python/sdk-runtime` 是运行时载体包。运行时包的数据目录包含构建注入的平台可执行文件及其必需的 `-rg` 伴随文件和可选的 macOS helper，以及供仓库开发使用的构建注入 `runtime/node/` 闭包树。`resolve_bundled_launch_args()` 默认选择可执行文件；显式设置 `DSH_RUNTIME_MODE=node` 会在系统 Node 22.19 或更高版本上运行 `runtime/node/node_modules/@deepseek-ai/dsh/lib/bin.js`。node 载体从不进入 wheel 分发，两种载体都不使用检入的完整 `cordis.yml`。

[`scripts/build-python-release.py`](../../../../scripts/build-python-release.py) 从仓库根目录的 `package.json` 读取权威的 `X.Y.Z` 或预发布版本，把预发布版本转换为 PEP 440 写法，并以该 wheel 包版本暂存两个包，让 `deepseek-harness-sdk` 精确依赖匹配版本的 `deepseek-harness-runtime-bin`。可选的 `python-v<repository-version>` 发布标签只是一项一致性断言，与仓库版本不同时会被拒绝；源码 `pyproject.toml` 中的开发占位版本从不决定发布版本。暂存过程还会把仓库许可证放入两个 wheel 包，并把第三方声明放入内置运行时 wheel 包。SDK 是 `py3-none-any` wheel 包；每个只提供 wheel 包的运行时包都包含一个 exe 及其架构匹配的 ripgrep 伴随文件，macOS wheel 包还包含与其架构匹配的 spawn helper。运行时 wheel 包使用 `py3-none-manylinux_2_28_x86_64`、`py3-none-manylinux_2_28_aarch64`、`py3-none-macosx_14_0_arm64`、`py3-none-macosx_14_0_x86_64` 或 `py3-none-win_amd64`；Hatch 钩子拒绝 sdist、通用标签、混合平台载荷、伴随文件缺失或多余，以及不支持的平台。两个 macOS 标签都会特意声明保守的 14.0 安装下限：打包后的 Node 24 可执行文件声明 macOS 13.5，x64 PTY helper 声明 10.7，但发布验证只按照 14.0 wheel 声明证明完整载荷，不会把各组件实测的最低版本承诺为受支持宿主。两个 macOS wheel 包仍按架构分别发布，不发布 universal2 wheel 包。

Python 客户端使用所选 profile（默认 `sdk`）、有序 patch 文件和显式 Harness home 启动打包后的 `dsh` 命令。Profile 负责 JSON-RPC 服务和应用组合；缺失 home、profile、bundle、patch 或 server 配置项都会失败，不存在外部完整配置回退。

### 命名血统

`dsh-python-runtime-closure` 是私有部署 manifest，`deepseek-harness-sdk-runtime-<platform>-<arch>` 是可执行文件族。协议字段 `serverInfo.name` 是 `deepseek-harness-sdk-runtime`；Python 分发包名是 `deepseek-harness-sdk` / `deepseek-harness-runtime-bin`，导入模块名是 `deepseek_harness` / `deepseek_harness_runtime`。

## 工作线程插件

exe 内支持 `dsh-workflow-worker-thread` 与 `dsh-code-runtime-worker-thread`。两个后端构建后的宿主都通过 `fileURLToPath()` 转换相邻 `lib/worker.cjs` 的 URL，再将所得文件系统字符串传给 `Worker`；pkg 的 Worker 钩子可以用这种形式解析 VFS 内文件。该钩子会把 VFS 内的工作线程文件作为 CommonJS 编译，所以工作线程入口采用 CommonJS。工作流引擎在未构建的源码执行中仍保留 `data:` URL 引导程序，只有构建后的相邻入口使用文件系统字符串。自定义配置的可执行文件冒烟测试会加载两个后端，实际调用 `run_code` 与不启动 agent（智能体）的 `workflow`，并要求两个工作线程都从 pkg 的 VFS 内返回 `42`。

## 测试

验证面分三层。机制层：`--sea` 链路的实测结论内嵌在「决策」各节（VFS 内 ESM 动态 `import()`、单一 Cordis 实例、明确报错的配置链路、`node:sqlite`、macOS ad-hoc 签名可运行）。SDK 层：完整的无密钥 pytest 套件以 mock 运行时对端覆盖客户端协议、子进程清理、绝对 `cwd` 传递、双载体启动与载体解析；根 CI 在 Python 3.10 上运行全部用例。端到端层：每个平台构建都会把两个 wheel 包安装进 checkout 外的干净 venv，证明版本相同以及已安装模块／可执行文件的位置，再通过默认 SDK 路径、自定义配置、仓库内置的独立 minimal 组合和直接二进制协议，对 mock 端点完成轮次，并校验最终文本与 JSONL。minimal 运行会断言其精确系统提示词与双工具目录，跨调用保留 Bash 状态，并调用编辑器。自定义配置还会通过打包进 VFS 的真实工作线程文件执行 `run_code` 和不启动 agent 的 `workflow`。文件系统搜索场景要求模型通过目标平台的 `-rg` 伴随文件调用 `glob` 与 `grep`。spawn-node 场景驱动平台 shell 工具执行以 `node` 开头的命令，要求工具结果给出机器自身的 Node 版本且子进程环境中无 `PKG_EXECPATH`，把打包运行时钉死在「pkg 升级重录 child_process 补丁也不得回归」的行为上。MCP 场景会启动临时外部 stdio server，刻意延迟首次 `tools/list` 响应，随后立即启动第一个 SDK 提示词；该提示词必须看到并调用已发现的工具，从而证明 `initialize` 是真正以 Loader 插件树完全稳定为准的就绪边界，而不是依赖定时 sleep。同一项安装后运行还会经 Python SDK 比较一组检入的 exe 专用快照：无密钥脚本化模型挂载一个会注册工具的 Cordis 插件，从 `run_code` 调用该工具，运行一个直接 spawn 的 subagent 和一个会通过 spawn 启动第二个 subagent 的工作流，随后卸载该插件。该 fixture（测试前置数据）会显式禁用组合包中未使用的 Bash 和本地 skill（技能）发现，使其工具集不依赖仓库外部状态；比较时会规范化 SDK 结果与通知流，以及父会话和两个子会话 JSONL 日志中不透明的消息、agent、工作流运行与会话 ID。可信拉取请求会增加真实提供方双轮文件写入／读取，并要求外部字节、工具调用、已完成原因与持久化日志一致。该 harness 与 ACP 的 `pnpm run test:snapshot` 保持独立，因为二者的协议和构建产物不同。


手工驱动注意：`bin` 将 stdin EOF 视为「客户端已离开」并立即 dispose，生命周期较短的管道会中止进行中的轮次——管道驱动必须保持 stdin 打开，直到轮次结束。

## 曾考虑的替代方案

**裸用 Node 原生 SEA。** 注入的主脚本必须是 CJS 单文件，blob 内没有文件系统与模块解析，因此动态 `import()` 无法解析裸包名；只能把插件静态编译进主脚本并手工注册。这会绕过标准模块解析并硬编码插件集合，与「配置决定一切」相悖。最终路线实际是「官方 SEA 基础 + pkg 的 VFS/模块钩子层」；否决的是裸用方式，而不是 SEA 本身。

**pkg 标准模式。** PoC 证明该模式不可行，而非权衡后放弃：它通过 esbuild 将 ESM 转为 CJS + V8 字节码，但运行时 VM 编译没有接入动态 `import()` 回调，任何 `import()` 都会抛出 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`，`--options experimental-require-module` 也无效；此外，它依赖社区补丁版 Node 二进制（macos-arm64 没有预编译版本，现场从源码编译约需 10 分钟）。该模式不适用于本仓库架构。

**每包 ESM→CJS 预打包进 VFS。** 保持真实解析语义、只降级模块格式的折中；`--sea` 直接通过实测，这层构建复杂度无需引入。

**让 jsonrpc-agent 承担完整闭包依赖。** 应用入口将声明 53 个以上自身并不 `import()` 的依赖，使「打包 manifest」伪装成真实依赖关系，还会迫使 `constraints` 为其增加 `cordis-in-dependencies` 与 `files` 通配符两个例外。将闭包 manifest 放在 Python 侧的 manifest 包后，`constraints` 不需要任何例外，`bin` 也能保持与 acp-agent 同构的正常包形状。

**开放插件集（从磁盘加载用户插件）。** 交付的集合是封闭的；PoC 同时证实，可以通过 `ctx.baseUrl` 相对路径通道从 VFS 外的磁盘 `import()` ESM。该能力列为后续演进，届时还需解决外部插件与 exe 内 Cordis 实例的共享问题。

## 后果

**买到的**：目标平台零依赖的单文件分发；插件语义与源码运行严格一致（同一棵真实包树，无转译、无注册表）；对外服务接口、插件集与配置全部收敛到 `cordis.yml` 和一份依赖 manifest 这两个真源；exe 与 `node` 双载体使用同一棵树和相同语义，开发验证无需等待打包；官方 Node 二进制消除了补丁版二进制的供应链顾虑。

**付出的**：产物约 174MB，且源码原样进入 blob（没有字节码混淆；闭源分发诉求需要另行评估）；pkg 的 VFS/模块钩子层仍由社区维护（`@yao-pkg/pkg` 为精确钉版、带 pnpm 补丁的根 devDependency，升级需重录补丁，属显式改动）；`--sea` 每个构建目标调用一次（与 CI 每个平台一个任务相匹配，本地多平台构建串行执行）。
