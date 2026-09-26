# Agent Note：Desktop 主进程在工作区 tsdown 阶段之后再打 bundle

Status: implemented

[English](2026-09-22-desktop-main-bundle-after-workspace-tsdown.md) | 中文

## 问题

从全新 worktree 打出的 macOS Desktop 安装包启动即崩：`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-home-paths' imported from app.asar/lib/main.js`。打包日志给出了原因：rolldown 报告了 `[UNRESOLVED_IMPORT] Could not resolve '@deepseek-ai/dsh-home-paths' … treating it as an external dependency`，`@deepseek-ai/dsh-app-boot` 与 `@deepseek-ai/dsh-deepseek-account` 也是同样情况。这三个包是 `apps/desktop` 的工作区 devDependencies，主进程 bundle 必须把它们内联，因为 electron-builder 只把清单中的 `dependencies` 复制进 `app.asar/node_modules`。

根 tsdown 配置并发构建所有匹配到的 workspace 成员（tsdown 0.22 对解析出的配置做 `Promise.all`，没有任何依赖排序），而 `apps/desktop` 是其中一员。它的 bundle 通过这三个包的 `exports` 解析到 `lib/index.js`，而其他并发构建此时还没有写出这些文件。在此前构建过的检出目录里，陈旧的 `lib/` 产物存在，bundle 会把它们内联，因此缺陷只在干净树上出现；两份配置里的 `clean: false` 一直掩盖着它。坏的 bundle 也更小（189 KB 而不是 315 KB），并且打包流程通过了所有已有检查，因为运行时载荷 smoke 检验的是 dsh 运行时，不是 Electron 主进程。

## 决策

`apps/desktop` 退出根 tsdown 的 `workspace` 列表。根 `build:lib:host` 脚本先跑 Host tsdown 阶段，再执行 `pnpm --filter @deepseek-ai/dsh-desktop run bundle`，让主进程 bundle 解析的是已经存在的工作区 `lib/` 产物。该包自己的 `build` 脚本为本地使用保留同样的先 `tsc -b` 再 `bundle` 的顺序。单独运行 Desktop 配置得到的产物与此前 workspace 模式下的产物逐字节一致：该配置本来就是自足的，根配置的插件没有为它贡献任何内容。

Desktop 配置同时断言这次崩溃所违反的不变量。[`desktop-bundle-imports`](../../../../apps/desktop/scripts/desktop-bundle-imports.mjs) 是挂在每个 Desktop bundle 上的 rolldown 插件，其 `moduleParsed` 钩子在某个模块以静态 import、动态 `import()` 或 `require()` 导入了打包应用无法解析的裸说明符时让构建失败：主进程 bundle 可以导入 `electron`、Node 内置模块与清单的 `dependencies`；沙箱 preload 只能导入 `electron`、`events`、`timers` 与 `url`，即 Electron 沙箱 `require` polyfill 能解析的模块。该钩子读取每个模块的导入记录，其中外部导入保留裸说明符、被打包的导入带有绝对 id；chunk 元数据（`imports`/`dynamicImports`）不包含外部的 `import()` 与 `require()` 目标，无法用于这项检查。这项检查陈述的是真正的要求而非症状，因此它同样拒绝被移出 `dependencies` 的工作区包或损坏的 `exports` 条目，且被拒绝的 bundle 不写出任何产物。

## 备选方案

**把这三个包声明为运行时 `dependencies`，让 electron-builder 装进 asar。** `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-api-gateway` 今天就是这样进入 asar 的，这也消除了顺序问题。但 `dsh-app-boot` 会把一棵很大的依赖树带进 `app.asar/node_modules`，与 packed dsh 运行时内已有的副本重复，并扩大运行时文件策略必须筛查的载荷。

**通过 `inputOptions.onLog` 或 `failOnWarn` 让 rolldown 的 `UNRESOLVED_IMPORT` warning 直接失败。** 它只覆盖未解析这一种情况，覆盖不了被误声明为 devDependency 的依赖：产物存在时它会被解析并内联，不存在时才留成外部导入。打包导入检查用一条规则同时覆盖两者。

**按依赖图给 workspace 构建排序。** tsdown 不提供这种排序，而其他每个成员要么不从工作区内联任何内容，要么把已声明的 `dependencies` 留成外部导入，都不需要排序。为唯一需要它的包多加一步，比通用调度器更小。

## 后果

干净的检出目录（包括 CI 与全新 worktree）产出的 Desktop 主进程 bundle 与长期使用的检出目录一致。缺失或误声明的运行时导入现在会让 `pnpm run build` 和每条打包命令在签名与公证耗时之前失败，并报出导入方模块与违规说明符。Host 构建多出一个串行步骤，在开发机上约一秒。`docs/development.md` 在根构建顺序中列出了 desktop bundle 步骤，`scripts/wine-windows-gates.sh` 与之保持一致，导入规则由 [Desktop README](../../../../apps/desktop/README.zh.md#bundled-workspace-dependencies) 负责。
