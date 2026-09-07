# Agent Note: TSC 优先构建与编译器单一归属

Status: implemented

[English](2026-06-17-ts-build-config.md) | 中文

> 根项目拓扑由一个 solution 根文件统辖两个 aggregate program；见 [solution 根文件 Agent Note](../../archived/process/2026-07-22-tsconfig-solution-root-two-aggregates.md)。Host 生成 Remote 约定后再编译 Client 的当前命令顺序见 [API Remotes 构建 Agent Note](../../archived/process/2026-08-08-api-remotes-generated-contract-build.md)。本文确定的 tsc-first 职责保持不变。

## 问题

此前的 TypeScript 构建与类型检查配置存在以下问题：

- `build` 使用 `tsc` 将 `packages/<group>/<pkg>` 和 `vendor/*` 下的 `.ts` 转换为 `.d.ts` 文件，然后使用 `tsdown` 将 `.ts` 转换为打包后的 `.js` 文件。这导致两个工具各自执行 TypeScript 转换。
- `typecheck` 倾向于通过一个根目录的类型检查配置来校验包、vendor 源码、示例、测试和脚本。

构建与类型检查使用一致的 tsconfig 边界和 TypeScript 解析/转换行为。构建通过单一编译器和配置生成 `.js`、`.d.ts`、`.js.map` 和 `.d.ts.map`，使发布产物与类型校验保持一致。

具体约束：

- `tsdown` 使用 `oxc` 进行 TypeScript 转换，其行为与 `tsc` 不同。
    - `tsdown` 输出的打包 `.d.ts` 与 Cordis 内部的相对模块增强（module augmentation）结构冲突。
    - tsc 的输出受 `allowImportingTsExtensions` 影响：生成的 `.js` 文件不得导入 `.ts` 文件，且生成的 `.d.ts` 文件必须保留 NodeNext/Node16 接受的显式相对说明符。为此，包内相对导入在 TypeScript 源码中使用显式 `.ts` 说明符，由 `rewriteRelativeImportExtensions` 在输出的 JS 中将其重写为 `.js`。
    - `tsdown` 输出的打包 `.js` 与 `tsc -b` 逐文件输出的 `.js` 行为不同，例如装饰器转换行为。
- `vendor/*/src`、示例、测试和脚本无法全部以 plain-include 方式纳入一个根目录的严格程序。
    - 在根目录严格配置下直接对 `vendor/*/src` 做类型检查，会触发大量不属于本项目所有权范围的类型错误。
    - `packages/*/*` 对 `vendor` 的包依赖解析到 `vendor/*/lib`，以适应不同的 tsconfig 严格度。


## 决策

包内相对导入使用显式 `.ts` 说明符。

`pnpm run build` 依次执行 Host lib、Client lib 和 Web；每个 lib 阶段都保持 tsc 先发射、tsdown 后打包：

- Host tsc 对 `tsconfig.host.json` 执行 `tsc -b`，把逐模块 `.js`、`.d.ts`、`.js.map` 与 `.d.ts.map` 输出到 Host 图各包的 `lib/types`；Host tsdown 随后读取这些 JS，生成发布入口并运行 Host Typert。
- Client tsc 在 Host Typert 已生成 Remote Client 声明后对 `tsconfig.client.json` 执行 `tsc -b`；Client tsdown 再读取 Client 图发射的 JS，生成 Client 包的 Node loader 入口与 browser bundle。
- Web build 只在两个 lib 阶段完成后启动。

`tsdown` 不再负责 TypeScript 编译或声明文件输出。

`pnpm run typecheck` 先执行 Host lib 阶段，以生成 Client 类型检查所需的 Remote 声明，再对 `tsconfig.client.json` 执行 `tsc -b`。两个 aggregate 本身以 `noEmit` 方式检查各自的示例、测试与脚本；被引用的包项目和 vendor 项目保持与构建相同的发射行为。

复合项目将增量构建信息保存在各项目本地的 `lib/` 输出中。`pnpm run clean` 会根据根 TypeScript project-reference 图确定当前有效的输出目录，删除遗留的根目录构建信息，并删除已删除包留下且仅包含已知生成残留的 `packages/*/*` 目录。在删除现有目标前，该命令会解析目标父目录的真实路径；如果解析后的父目录位于仓库之外，则拒绝删除，防止使用符号链接的 project reference 将清理操作重定向到工作副本之外。对于仍有 `package.json` 的每个包，该命令都会保留 `node_modules`；如果不含 `package.json` 的目录中存在未知文件，则拒绝删除。构建不会自动调用 clean，因此常规构建会保留增量状态。

命令编排结构如下：

```sh
pnpm run build:
tsc -b tsconfig.host.json
tsdown --env.DSH_BUILD_FACE host
tsc -b tsconfig.client.json
tsdown --env.DSH_BUILD_FACE client
pnpm run build:web

pnpm run verify-node-next-types:
tsx scripts/verify-node-next-types.ts

pnpm run typecheck:
pnpm run build:lib:host
tsc -b tsconfig.client.json

pnpm run clean:
tsx scripts/clean.ts
```

源码模式 demo 通过各自声明的 TypeScript 启动器和根路径映射运行。`dsh` TUI 链使用 Node 原生转换及应用自有的路径 loader，Web demo 在进入同一条 CLI 源码链路前先构建所需产物，其他源码 demo 继续使用 tsx。

## 曾考虑的替代方案

- **继续使用 `tsdown`/oxc 作为 TypeScript 转换器**：oxc 的转换行为与 `tsc` 不同（装饰器转换有差异、打包 JS 与逐文件输出不同），且其打包 `.d.ts` 与 Cordis 内部的相对模块增强结构冲突。
- **用一个根目录严格程序覆盖包、vendor、示例、测试和脚本**：vendor 源码在根目录严格标志下会触发不属于本项目所有权范围的类型错误；带有逐项目严格度的 project references 才是可行的边界。
- **每次构建前都执行清理**：即使工作区布局没有变化，这也会丢弃 `tsc` 和打包器拥有的增量状态。
- **删除所有包级 `node_modules`**：有效的包依赖链接不会导致工作区发现失败，而删除这些链接会使构建清理变成重新安装依赖。

## 后果

构建职责更加清晰：

- `packages/<group>/<pkg>` 和 `vendor/*` 下的每个普通模块有一份本地 tsconfig，同时服务于构建、类型检查和直接运行源码的工具（如 `dsh` 源码 loader、`tsx` 和 `vitest`）。`api/remotes` 因生成约定顺序使用一个 solution 和两个互斥的 emitting project，是唯一例外。
- `build` 命令依次运行 Host 和 Client 的 Project Reference 图。每个阶段都由 `tsc -b` 负责可发布的逐模块 `.js` 和 `.d.ts` 输出，打包器仅负责发布 runtime bundle。
    - `lib/types/*.d.ts` 是发布用的声明输出；`.d.ts.map` 只作为本地编译产物保留。
    - `lib/types/*.d.ts` 使用显式 `.ts` 相对说明符，TypeScript 的 NodeNext/Node16 解析器会将其映射到同级的 `.d.ts` 文件。
    - `lib/types/*.js` 通常仅作为打包器输入。只有显式运行时 export 指向该输出树时，才会发布这些文件。
    - `lib/index.*` 是发布用的运行时输出，由打包器（当前为 `tsdown`）生成。
- `pnpm run verify-node-next-types` 扫描构建出的声明文件，检查是否存在缺少文件扩展名的相对说明符，然后以 `moduleResolution: "NodeNext"` 对构建出的 `types`/`exports` 接口进行临时外部 ESM 消费方的类型检查，确保声明说明符的回归在发布前被捕获。
- `typecheck` 命令使用 `tsconfig.json`。示例、测试和脚本由根 no-emit 项目检查，包和 vendor 模块保持与 `build` 相同的输出行为。包和 vendor 源码始终处于 project-reference 边界之后。
- 切换分支或更新工作副本后，如果其中删除了包，贡献者可在重新构建前运行 `pnpm run clean`，删除陈旧的包目录。不含 `package.json` 的包目录如果存在未知文件，必须手动判定其类别，不能直接删除。

Cordis 的 vendor 副本现在与上游多了一处类型结构差异。在上游同步时，该差异必须被重新应用或明确废弃。
