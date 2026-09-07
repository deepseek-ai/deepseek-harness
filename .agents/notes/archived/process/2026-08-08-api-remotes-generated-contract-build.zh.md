# Agent Note: API Remotes 生成约定的有序构建

Status: implemented
Archived: 2026-09-04

[English](2026-08-08-api-remotes-generated-contract-build.md) | 中文

## 问题

Host 的 `@Remote` 方法需要先由 Typert 生成 `/remote` 声明和运行时贡献，Client 的 `api-remotes/src/client/index.ts` 才能通过类型检查并打包这些贡献。若根构建先把 Host 与 Client 两张 Project Reference 图一起交给 tsc，Client 会在生成产物存在之前编译；若增加独立 contracts 预处理，又会让 generator 脱离正常 Host 图重复编译，并允许陈旧产物掩盖错误依赖。

该顺序依赖不能改变仓库的普通 package 规则。正常 package 只属于一个 TypeScript face：Host package 登记在 `tsconfig.host.json`，Client package 登记在 `tsconfig.client.json`。一个 Client plugin 同时具有 Node loader 入口与 browser 入口，只是打包产物形态，不是拆分 TypeScript project 的理由。

## 决策

根构建先完成 Host tsc 和 Host tsdown，由 Host tsdown 运行 Typert 并生成 Remote Client 约定；随后完成 Client tsc、Client tsdown 和 Web 构建：

~~~text
tsc -b tsconfig.host.json
tsdown --env.DSH_BUILD_FACE host
tsc -b tsconfig.client.json
tsdown --env.DSH_BUILD_FACE client
Vite Web build
~~~

`build:lib:host` 负责前两步，`build:lib:client` 负责中间两步，`build:web` 最后运行。`typecheck` 也必须先执行完整 Host lib 阶段，因为 Client tsc 需要 Host tsdown 生成的声明；它不需要运行 Client tsdown 或 Web build。

每个 tsc 阶段都是唯一的 TypeScript 编译器路径，负责向 `lib/types` 发射 JavaScript、声明和增量状态。tsdown 只读取这些 JavaScript 并生成发布 bundle，不读取源码，也不生成声明。

## 唯一的 package 特例

`api/remotes` 是唯一同时拥有 Host 与 Client composite project 的 package。Host project 包含 Agent/Session lookup 策略、Host 插件入口和 invariant；Client project 只包含需要等待生成约定的 `src/client/index.ts`：

~~~text
packages/api/remotes/
├─ tsconfig.json
├─ tsconfig.host.json
├─ tsconfig.client.json
└─ src/
   ├─ index.ts
   ├─ agent-lookup.ts
   ├─ invariant.ts
   └─ client/
      └─ index.ts
~~~

包根 `tsconfig.json` 是只引用两个具体 project 的 solution，不进入任何 aggregate 或直接消费方的依赖图。根 Host aggregate 引用 `api/remotes/tsconfig.host.json`，根 Client aggregate 与直接 Client 消费方引用 `api/remotes/tsconfig.client.json`。`session-log-export` 使用相同的 solution 与 leaf 结构，让 Node archive 实现不进入浏览器 controller。workspace constraints 门禁遍历可达的 Project Reference 图；凡已声明 face 的 project 引用了拆分包的 solution 根或另一侧 leaf，门禁都会拒绝，而只有 `tsconfig.json` 的目标仍可由任一 face 引用。

两个 project 使用互不重叠的 `files` 和不同的 `.tsbuildinfo`，因此可以共享 `lib/types` 而不重复发射任何源码。若未来需要两侧共用一份实现，应把实现移入中立 package，不能把同一源码同时交给两个 emitting project。

这个例外由生成约定的真实先后关系决定，不是可供普通 package 选择的模板。新增 package 仍只能登记进一个 aggregate；只有修改本决策并证明存在另一条不可消除的生成依赖，才能增加例外。

## Typert 与 tsdown

Host tsdown 在普通根配置中启用 `typertPlugin({ mode: 'workspace', faces: ['host'] })`。generator 只以 `tsconfig.host.json` 为 program 种子，生成 `typert.host.*` 以及 Host 约定投影出的 `typert.remote-client.*`；Client tsdown 不启动 Typert，也不分析 Client aggregate。

TypeScript compiler face 与 Typert 运行时产物 face 是两层概念。普通 `dshClient` package 即使只有一个 compiler project，也可以按公开 subpath 同时贡献 Host 与 Client 运行时模型；aggregate 显式引用 `tsconfig.host.json` 或 `tsconfig.client.json` 时，analyzer 才把该 project 限定到对应 face。因此 `api-remotes` 的 Host 分析不会顺带注册其 Client 入口，普通双入口 package 的 Host 模型也不会丢失。

Host 与 Client 两次 tsdown 都接收 `vendor/*`、`packages/*/*` 和 `apps/cli` 这组完整 workspace。根配置不扫描 `lib/types/client/index.js`，不维护 package 分类表，也不使用 tsdown filter；包内配置根据 `DSH_BUILD_FACE` 返回本阶段入口。

普通 Client plugin 在 Host pass 返回空配置，在 Client pass 同时生成 Node loader 入口与 browser bundle。`api-remotes` 的 `clientBundle(..., { hostPhase: true })` 是唯一阶段例外：Host pass 生成其 Host 入口，Client pass 只生成 browser bundle。未指定 `DSH_BUILD_FACE` 的 package-local tsdown 仍同时返回该 package 的正常入口，供本地单包开发使用。

## 考虑过的替代方案

**保留独立 contracts 预处理。** 这会在正常 Host Project Reference 图之外额外编译 generator，并让残留生成物掩盖 Client 过早进入 Host 图的问题。

**一次执行根 `tsc -b tsconfig.json` 后再运行 tsdown。** Client tsc 在 Host tsdown 之前发生，无法从干净工作树获得 `/remote` 声明。

**拆分所有包含 `src/client/index.ts` 的 package。** Node 与 browser 双入口是普通 Client plugin 的打包约定，不形成编译顺序依赖；普遍拆分只会增加 references 和增量状态的维护成本。

**扫描 Client 编译产物或维护两份 workspace 清单。** 产物扫描会让 package 是否参与构建取决于残留文件，手工清单和 package 名过滤则会随目录调整产生漂移。完整 workspace 加包内 face 选择已经提供确定行为。

**在 Client pass 再运行 Typert。** Remote Client 是 Host 约定的投影，没有独立 Client 反射源；第二个 Typert program 只会重复工作并增加两侧声明混入同一分析的风险。

## 后果

干净构建成为顺序正确性的权威验证：没有任何既存 `/remote` 产物时，Host tsc 必须先成功，Host tsdown 必须生成约定，随后 Client tsc、Client tsdown 与 Web build 必须成功。任何阶段都不得把产物写进 `src`。

[TypeScript 构建配置 Note](2026-06-17-ts-build-config.zh.md)确定的 tsc-first 职责保持不变，但其单次全图 tsc 后再打包的命令形态由本文的有序阶段取代。[双 aggregate solution Note](2026-07-22-tsconfig-solution-root-two-aggregates.zh.md)确定的普通 package 单 aggregate 规则保持不变，本文只为 `api/remotes` 建立一个显式例外。

Client 的独立构建不再是干净工作树上的自足入口；仓库命令、CI 和发布流程必须先运行 Host lib 阶段。普通 package 的开发者无需理解或复制该例外，仍按所属运行环境选择一个 aggregate。
