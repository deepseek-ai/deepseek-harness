# Agent Note: 以 solution 根文件统辖两个聚合 program

Status: implemented
Archived: 2026-09-04

[English](2026-07-22-tsconfig-solution-root-two-aggregates.md) | 中文

## 问题

GUI 拆分引入了第二个聚合 program（`tsconfig.client.json`，见[已归档的分层 RFC](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)），根 `tsconfig.json` 则继续兼任宿主侧聚合，`tsconfig.build.json` 还是第三份手工维护的全量 emit 图。三处账本并行，造成四个具体的不对称：

- 类型检查与构建的 references 列表逐渐脱节（`packages/goal/command-goal` 在类型检查图里，构建图里却没有）。
- lefthook 的 pre-push 钩子只运行 `tsc -b tsconfig.json`，客户端侧的类型破坏因此通过本地检查点，直到 CI 才暴露。
- tsserver 只发现名为 `tsconfig.json` 的配置，客户端测试文件不在任何可发现的配置链上，回落到推断项目（inferred project），既没有 paths，lib/jsx 也不对。
- 各 vitest 配置指向三个不同的解析来源（`tsconfig.vitest.json`、根配置，外加一处手写别名）。

## 决策

一个 solution 根文件，两个检查单元，一对共享 base，不再单设 build 或 vitest 配置：

| 文件 | 角色 | 是否构成 program？ |
|---|---|---|
| `tsconfig.json` | solution 根文件：`extends` base、`files: []`、两条 references；同时是全仓 `tsc -b tsconfig.json` 图、tsserver 入口，以及 get-tsconfig 消费方（tsx 运行 `scripts/` 与文档围栏代码块）就近命中的配置，其裸 workspace 导入经继承来的 `paths` 解析 | 否 |
| `tsconfig.base.json` | 共享 compilerOptions 与源码 `paths` 映射；兼任 vite-tsconfig-paths 的解析门面（不含 `include`，因此对每个导入方都生效） | 否 |
| `tsconfig.base.client.json` | 浏览器侧编译形态（`jsx: react-jsx`、DOM lib、`types: []`），由客户端聚合与每个 `packages/client/*` 包共享 | 否 |
| `tsconfig.host.json` | 原根聚合原样迁入：宿主各包、examples、测试、scripts、website；排除 `packages/client` | 是 |
| `tsconfig.client.json` | 客户端各包及其测试；通过 `extends` 继承 `tsconfig.base.client.json` | 是 |

整个方案立足的原则：**cordis `Context` 的声明合并冲突只存在于同一个 `ts.Program` 内部，从不发生在模块解析中。** solution 文件不构成 program，因此从一个根文件同时引用两个聚合不会让两侧的声明合并相撞；vite-tsconfig-paths 只读取 `paths` 与 `include`、丢弃全部类型信息，因此一个门面可以横跨两侧。唯一会爆炸的做法是把两侧压平进同一个 program，由此推出两条派生纪律：`tsconfig.base.json` 永远不得添加 `include`/`files`（否则会泄漏进每个继承它的包，并收窄门面范围）；每个全仓级 `ts.Program` 消费方（`scripts/ts-project.ts`、doc-typecheck 独立模式）都显式以 `tsconfig.host.json` 或 `tsconfig.client.json` 为种子，绝不使用根 solution。基于 program 的生成器与语义门禁有意只留在宿主侧；客户端侧只有在真实需求出现时才引入基于 program 的门禁。

根 `tsconfig.json` 仍是显式执行完整 Project Reference 图的 solution 入口，lefthook pre-push 通过 `tsc -b tsconfig.json --pretty false` 增量覆盖两侧。仓库的 `build` 与 `typecheck` 命令因 Client 依赖 Host tsdown 生成的 Remote 约定而按 Host、Client 顺序运行，具体编排由 [API Remotes 构建 Note](2026-08-08-api-remotes-generated-contract-build.zh.md)负责。`tsconfig.build.json` 与 `tsconfig.vitest.json` 已删除；所有 vitest 配置都把 vite-tsconfig-paths 指向 `tsconfig.base.json`。

solution 根文件刻意 `extends` base：`scripts/` 没有更近的 tsconfig，tsx（get-tsconfig）通过根文件解析其 workspace 导入。`extends` 把 `paths` 映射带回根文件，`files: []` 则让它始终不构成 program。scripts 与 website 的类型检查仍由 Host aggregate 纳入。

## 考虑过的替代方案

- **把 `tsconfig.build.json` 改名为 `tsconfig.host.json`**——不予采纳：构建图是包含全部客户端包的全量 emit 图，不是宿主图；`tsconfig.host.json` 这个名字对应的是原根聚合，而构建图本身已被 solution 吸收。
- **让 vitest 指向根 solution**——不予采纳：solution 既没有 `paths` 也没有 `include`，解析结果将取决于插件沿 references 走多远；且客户端聚合的 include 只收测试、不收 src，传递的 src→src 导入会失去映射，回落到 `exports`，加载出模块单例的第二份副本。
- **保留 `tsconfig.vitest.json` 作为专用门面**——仅保留为后备方案：若 vite-tsconfig-paths 处理不了无 include 的配置再启用；base 文件已经携带 paths 映射，而无 include 的配置处处生效，严格宽于该门面手工维护的 include 列表。

## 后果

- `docs/development.md#typescript-project-layout` 是权威描述；根 `AGENTS.md` 以约定形式收录上述两条纪律。
- [ts-build-config Agent Note](2026-06-17-ts-build-config.zh.md) 继续拥有 tsc 先行的构建流水线（tsc 负责输出，tsdown 负责打包，`.ts` 说明符配合 `rewriteRelativeImportExtensions`）；其原先「单一根类型检查项目」的形态由本文取代。
- 新增一个普通 package 只登记进恰好一个 aggregate 的 references（Host package 进 `tsconfig.host.json`，Client package 进 `tsconfig.client.json`）。`api/remotes` 因 Host 生成约定与 Client 消费约定的顺序关系成为唯一显式拆分例外；其两个具体 project 分别登记，包根 solution 不进入任一 aggregate。
- Host 与 Client 构建阶段必须串行：Host tsdown 生成约定后 Client tsc 才能开始。各阶段复用各 project 的增量状态，不通过并发重复处理同一张图。
