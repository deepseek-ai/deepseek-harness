# Agent Note: Profile 插件共享安装自带的宿主运行时实例

Status: implemented

[English](2026-09-18-profile-plugin-host-runtime-instances.md) | 中文

## Problem

profile 从 npm 装进来的 out-of-tree 插件，沿祖先 `node_modules` 链解析裸模块名，而 profile 自己那一层位于运行时解析（runtime resolution）的拦截层之上（[解析顺序](2026-09-19-profile-resolution-lookup-order.zh.md)）。于是它会为经 `dependencies` 边到达的每个包各留一份自己的副本，而加载它的 Host 用的是安装里那一份。多数包可以容忍这种重复；`@deepseek-ai/dsh-scope` 不能：它用一个模块级 `Symbol('dsh.scope')` 给作用域上下文打标记，并把作用域父链和事件载体键保存在模块级表里，而每个读标记的注册表——工具注册、提示词 section、MCP 资源、作用域事件——都按同一性比较它。profile 那份副本的 `createScope` 写下的标记，安装那份的 `scopeOf` 读不到，于是本该属于某个 Agent 的注册落进了进程全局层。

Issue #4573 就是这个问题在生产里的形态。当本包经 `dependencies` 到达这两个运行时时，挂载 Playwright MCP 浏览器提供方的 profile 多装了一份 `dsh-scope`：第一个 Agent 的 MCP 工具注册到全局层，第二个 Agent 的工具同步撞名，`failOnStartupError: true` 把这次撞名放大成 Agent 创建失败。把 profile 的包版本对齐到 Host 并不能改变结果，因为无论哪个版本，副本都是第二份模块实例。

## Decision

Out-of-tree 插件包，凡是跨实例同一性要紧的宿主运行时，一律写成匹配的 `peerDependencies` 与 `devDependencies`，绝不写进 `dependencies`。Profile 的 pnpm 配置是 `nodeLinker: hoisted` 加 `autoInstallPeers: false`，这类 peer 不会装进 profile；导入走到 `$DSH_HOME/profiles/node_modules` 时，由运行时解析（runtime resolution）的拦截层提供安装里的那一份实例（[解析顺序](2026-09-19-profile-resolution-lookup-order.zh.md)）。

`@deepseek-ai/dsh-scope` 的同一性既在读取者 `scopeOf`、`carrierKeyOf`、`scopeTarget` 上，也在写入者 `createScope` 上：标记由写入者铸造，再由读取者比较。`@deepseek-ai/dsh-mcp-client` 同属这一类，因为它在线的 `serverName` 保留表是模块级的，第二份副本会为同一命名空间保留第二张表。因此 `@deepseek-ai/dsh-experimental-browser-use-runtime` 把两者声明为 peer（并补匹配的 dev 条目），只把不携带实例内状态的 `@deepseek-ai/schemastery` 留在运行时依赖里。

`tests/shared-host-runtimes.spec.ts` 钉住这个包的分区。`tests/host-runtime-duplication.spec.ts` 复现这条规则拦下的问题：两份包各多一份副本时，每个 Agent 的 MCP 工具都落进全局层，第二个 Agent 的创建被拒；而实际发布的单实例布局下全局层为空，两个 Agent 各拿到自己的客户端。

[Published dependency faces](../process/2026-08-26-published-dependency-faces.zh.md) 拥有 `verify-package-dependencies`：它的 `peerRequiredHostExports` 表分类了 `dsh-scope` 的读取者，它的包选择覆盖 Client 面的包与一份显式 Host 名单。该 gate 不选择 `packages/experimental/` 下的任何包，也没有分类 `createScope`；gate 覆盖不到的 out-of-tree 插件包，由本记录拥有这条规则。

## Alternatives considered

**把 MCP 客户端挂到 `agent.ctx`，而不是本包自造的作用域。** 它不成立，是因为 profile 那份副本的 `scopeOf` 同样读不到安装为 `agent.ctx` 写下的标记，`serverName` 保留会退化成进程全局所有者，第二个 Agent 在那一步就失败——即 `0.1.6-alpha.1` 上看到的错误形态。消除重复副本才是两种形态共同的修复。

**把 `dsh-scope` 的标记改成 `Symbol.for`，让两份副本互相认得。** 这只修好标记查找。作用域父链与事件载体键仍各留一份，一份副本的链式遍历与载体准入看不见另一份记录的关系——可见错误更小，成因更难定位，而且 profile 本不需要的那份重复依然存在。

**把 profile 的包版本对齐到 Host。** 版本相同，两个目录依旧加载出两份模块实例，问题照旧。

## Consequences

- 修复要生效，需要升级并重装 profile 里的插件依赖。在此之前，已装好的 profile 一直带着那份副本，Host 侧无法补救。
- 这条规则让插件依赖「安装确实带了这个 peer」。两个包都是 `@deepseek-ai/dsh` 安装的依赖，运行时解析能提供它们；若某插件不在安装闭包内，它会直接加载失败，而不是带着第二份副本启动。
- `docs/module-graph.md` 把这些边画进 peer 区，图与分区表达的是同一条所有权边界。
- 另有三个实验提供方（`browser-use-stagehand-native`、`computer-use-cua-driver-mcp`、`computer-use-cua-driver-native`）把 `@deepseek-ai/dsh-mcp-client` 写成依赖。它们不按 Agent 挂 MCP 客户端，因此自身不会触发本决策要防的故障。若一个 profile 把其中之一与本包一起安装，hoisted 会把那份依赖平铺到 profile 自己的 `node_modules`，位置高于拦截层，于是本包的 peer 解析到那份副本：两份 `dsh-mcp-client` 各存一张 `serverName` 保留表，一份上保留的名字在另一份上不再被检测。作用域标记的分裂不会回来，因为它们都没有把 `@deepseek-ai/dsh-scope` 写成依赖。Issue #4628 记录把这三处声明改为 peer 并各自验证的后续工作。
- `verify-package-dependencies` 仍不选择 `packages/experimental/` 下的包，所以本包的分区只由 `tests/shared-host-runtimes.spec.ts` 钉住。扩大该 gate 的选择范围，就是本记录留下的覆盖缺口。
