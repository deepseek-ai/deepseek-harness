# Agent Note: Client 业务代码使用构建期公开环境变量

Status: implemented
Archived: 2026-09-04

[English](2026-08-18-client-build-environment.md) | 中文

## Problem

浏览器业务包需要按部署构建选择静态行为，但 Web client 有两条互不包含的产物路径：Vite 构建静态壳，共享 tsdown preset 构建运行时加载的动态插件。只在一条路径替换环境变量会使相同业务表达式因所在包类型不同而产生不同结果。

浏览器没有 Node `process`，而把构建进程的完整环境对象放入产物会泄露与前端无关的值。运行时配置也不能准确表达构建变体，因为产物发布后不应再改变这类选择。

## Decision

`DSH_CLIENT_*` 是可公开给浏览器业务代码的构建期命名空间。业务代码可用静态点访问 `process.env.DSH_CLIENT_NAME` 选择行为；值只取自构建进程环境，不读取 Vite `.env*` 文件。设置的值在构建时内联为字符串，未设置的值为 `undefined`。

Vite 配置与动态 client bundle 的共享 tsdown preset 使用同一 define 生成器。生成器只为 `DSH_CLIENT_*` 创建精确替换，并把其余 `process.env` 读取收敛到空对象；浏览器不获得全局 `process`、动态键读取或环境枚举能力。

`DSH_CLIENT_*` 的名称本身表示公开性。凭据、路径和其他仅供 Host 或 CI 使用的值不得使用该前缀。

根构建包装脚本向两个 bundler 提供同一份精确的公开环境。每次完整构建都以 `DSH_CLIENT_VERSION` 携带根包版本，并以 `DSH_CLIENT_COMMIT_HASH` 携带源码 Git HEAD 的七位前缀；没有仓库元数据的构建环境可显式提供 commit。默认本地构建还会在构建前读取 Git 状态；存在任何暂存、未暂存、未跟踪或子模块变化时设置 `DSH_CLIENT_GIT_DIRTY=true`。没有变化的 worktree 和没有 Git 元数据的源码不携带 dirty 字段。这些由仓库持有的字段会替换继承值，除此之外，`pnpm run build` 继续继承调用方剩余的 `DSH_CLIENT_*` 值。

`pnpm run build:official` 不依赖特定 shell 的环境变量语法，直接选择仓库的官方产物 profile。它的精确环境携带版本和 commit，设置 `DSH_CLIENT_BUILD_PROFILE=official` 供部署专属业务注册使用，并省略本地 dirty 元数据。完整构建成功后会写入精确的公开环境，以及覆盖 Vite 输出和所有动态 client bundle 的摘要；局部构建命令不会替换该记录。`pnpm run dev:web` 则会在启动时读取一次默认本地环境，并在本次会话中把该环境传给所有 watcher stage。它不会校验完整构建记录，因为 watcher stage 会重写记录覆盖的全部产物。

## Alternatives considered

**只在 Vite 中替换。** 动态插件的 `lib/client.js` 作为独立脚本由浏览器加载，不进入 Vite 模块图，表达式会残留到无 `process` 的浏览器。

**公开全部 `DSH_*`。** 仓库中的 Host、测试和 CI 变量使用该前缀，其中可能包含凭据或本地路径；更窄的 `DSH_CLIENT_*` 让公开意图可审计。

**在浏览器提供完整 `process.env` 对象。** 这会允许枚举构建环境并把 Node 兼容垫片变成运行时 API；静态精确替换足以承载构建选择。

**统一改用 `import.meta.env`。** 动态插件输出为独立 CJS factory，不能保留 `import.meta`；业务代码仍会因产物路径不同而使用两套接口。

**让 watcher 复用上次完整构建记录。** watcher stage 会重写记录覆盖的全部 client 产物，因此正常开发期间产物摘要就会变为陈旧。官方构建记录还会让经过编辑的本地源码继续携带官方 profile 和标题。启动时读取一次可以让所有 stage 共用同一份本地元数据快照，同时避免 watcher 重启依赖记录的产物摘要。

**每次 watcher 重建都重新读取 Git 状态。** Vite 和 tsdown 在长驻 watcher 启动时固定 define 替换。仓库状态变化时重启构建流水线，会使一次增量源码修改重建无关产物；启动时只读取一次可以保持各 stage 一致，同时避免因后续状态变化而重新构建。

## Consequences

Vite 静态壳和共享 tsdown 动态 bundle 对同一 `DSH_CLIENT_*` 构建进程变量产生相同字符串值。未设置的静态点访问得到 `undefined`，非 `DSH_CLIENT_*` 值不会通过该机制进入浏览器产物，业务代码也无法枚举构建进程环境。每次完整构建都携带可公开展示的包版本和短源码 revision；dirty 的默认构建还会标明其源码存在未提交变化。CI 构建门禁选择官方 profile，而不把其中的公开值暴露给源码测试或无关 workflow 步骤。npm 打包与 built Web 测试会校验记录中的环境及当前产物摘要，因此默认构建后请求官方打包、局部重建或修改输出都会在消费产物前失败。watch build 会保留启动时的快照，直到 `pnpm run dev:web` 重启。

任何被业务代码引用的 `DSH_CLIENT_*` 值都会成为公开产物内容，命名错误可能泄露信息。构建选择在产物生成时固定；需要部署后变化的设置必须使用拥有校验、传输和文档的运行时配置机制。
