# Agent Note: 发布依赖门面与有限 peer 中继

Status: implemented

[English](2026-08-26-published-dependency-faces.md) | 中文

## 问题

一个包可能同时包含浏览器 bundle、Host 入口、共享 TypeScript 声明和 Cordis 注入元数据。把这些关系全部编码成必需 npm peer 会使已发布 CLI 的安装代价过高：npm 会自动安装 peer，并沿深层、反复汇合的 peer 路径重复执行放置检查。修改版本范围或把 peer 标成 optional 都不会消除这类遍历。

Client 构建输入由发布 profile 选择，而 Host value import 由导入它的包通过 Node 加载；两者需要不同的 npm 区段。把规则应用到每个 Host 包虽然也能缩小依赖图，却会制造一个没有对应安装收益的大范围迁移。

## 决策

### 包选择

[`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) 统一负责依赖区段策略。它始终覆盖 `packages/client/` 下的包，以及声明 `dsh.client` 的每个非实验包。在该目录内，`dsh.client` 标记需要扫描 Host 入口的 Client/Host 包；没有该声明的包是仅供 Client 编译的静态输入。在目录外，`dsh.client` 选择相同的 Client/Host 扫描。仅有 `"./client"` export 只是 API，不参与 npm 依赖策略选包。

[`package-dependency-policy.ts`](../../../../scripts/package-dependency-policy.ts) 提供显式 Client 门面 include 与 exclude 列表。include 用于没有 `dsh.client` 的例外包，exclude 用于移除 `packages/client/` 之外自动发现的双面包。验证器拒绝未知、失效、冗余、重复、相互重叠和无法生效的配置项。include 列表为空；exclude 列表包含 `@deepseek-ai/dsh-api-session-controller` 和 `@deepseek-ai/dsh-api-workspace-controller`。把 Session Controller 加回会多迁移九条 Host 边，而五次候选复测的 resolver 中位数仅改善 0.15 秒。

Host-only 包通过另一份显式列表加入同一策略。该列表包含 `@deepseek-ai/dsh-llm` 和 `@deepseek-ai/dsh-session`；源码 import 不会自动扩大列表。

### 依赖区段

每个受管包都把 `@deepseek-ai/cordis` 保持在范围一致的 `peerDependencies` 和 `devDependencies` 中。Cordis 是由应用控制身份的共享插件运行时。

Host 入口闭包中的运行期 value import 所到达的 workspace 包，只有在其完整运行时入口列入 `duplicateSafePackages`，或每个运行期导出都列入 `safeHostDependencyExports` 时才只属于 `dependencies`。包级列表包含 `@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-util-crypto` 与 `@deepseek-ai/dsh-util-values`：它们的值无状态、按结构识别，或通过带版本且可互操作的描述符存储。导出表负责处理其他导出无法提供同等保证的混合包中的已审查值。

constructor 身份或模块状态必须共享的导出列入 `peerRequiredHostExports`；一旦使用这类导出，整条包依赖边就保留在范围一致的 `peerDependencies` 与 `devDependencies` 中。每个导出表的 key 都是精确 module specifier，每个 value 都是经审查的导出集合。验证器从 Host 入口沿运行期本地 import 扫描，记录具名与默认 import 和 re-export，并拒绝既没有包级分类、也没有导出级分类的导出；除非完整的精确入口已按包分类，否则 namespace、dynamic 和 side-effect import 仍无法限定范围。

Client bundle 使用的 workspace import、纯类型 import、模块扩充、`dsh.client.inject` 和仅有元数据的现存 peer 只属于 `devDependencies`。Host 运行时 import（包括额外 Node 入口）遵循 Host 分类。[浏览器第三方构建输入](2026-09-08-browser-third-party-build-inputs.zh.md)规定普通第三方声明，部分取代本决策对它们原区段的保留。Workspace 引用使用 `workspace:^`。

部分开发期关系只存在于 `dsh.client.inject` 或 TypeScript project reference 中。策略的 `configurationOnlyDevDependencies` 表只列出这些已评审的依赖边，并将它们保留在 `devDependencies` 中。

验证器读取源码 manifest 和源码文件，因此可以在没有已构建 `lib/` 的干净工作树上运行。每个被选中的 Host face 都必须存在 `src/index.ts`。未分类的 Host 运行期导出属于策略违规，会阻止 `--fix` 的全部写入；维护者必须审查该导出，并选择分类该导出、修改源码关系或修改选包范围。源码安全检查通过后，`--fix` 只执行分类所确定的区段与范围变更，并删除失效的 peer 元数据。

### 维护流程

不带 `--fix` 运行验证器，会以只读方式检查选包范围、导出分类、依赖区段、workspace range 与 peer metadata。未分类的运行期 import 会按每个导出分别报告可点击的 `path:line:column` 诊断。

```sh
pnpm run verify-package-dependencies
```

生成 manifest 前，在 [`package-dependency-policy.ts`](../../../../scripts/package-dependency-policy.ts) 中分类每个新增 Host 运行期导出。`duplicateSafePackages` 允许一个精确根入口的全部运行期导出使用普通 dependency；`safeHostDependencyExports` 只允许列出的导出；`peerRequiredHostExports` 让整个提供包依赖边保留在范围一致的 peer 与开发区段。一个导出只能获得一种分类。移除包级的 identity 或状态要求后，按包分类其根入口；只改变混合包中的一个导出时，则更新精确导出表。只有当一条依赖边的所有 import 都不再使用 peer-required 导出时，它才会成为普通 dependency。

用一条命令生成受管 manifest 和所有直接派生产物。存在策略违规时，`--fix` 不写任何文件；成功后，它会刷新 `pnpm-lock.yaml`、重新生成中英文 module graph 及其配对记录，并打印普通 dependency 与 peer-required 依赖边。

```sh
pnpm run verify-package-dependencies -- --fix
git diff -- packages pnpm-lock.yaml docs/module-graph.md docs/module-graph.zh.md docs/module-graph.i18n.yaml
```

通过仅 metadata 的本地 registry 测量工作树依赖图与 Git ref。每轮都会创建全新 consumer 与 npm cache，用明确的 peer、hoisting 和 registry 设置替换继承的 npm 配置，执行 `npm install --package-lock-only`，拒绝下载包归档，并保持仓库不变。`--runs` 控制重复次数，`--timeout-ms` 会在期限到达后终止 npm 进程树，可选 `--max-ms` 会在最慢一轮超过阈值时让命令失败。

```sh
pnpm run benchmark:npm-resolution -- --runs=5 --timeout-ms=300000
pnpm run benchmark:npm-resolution -- --ref=origin/master --runs=5 --timeout-ms=300000
```

通过两个互不兼容的 DSH 合成版本验证包落位。验证器把每份当前 DSH manifest 分别复制为 `0.1.0` 和 `0.2.0`，只要求 npm 生成 package lock，并拒绝跨版本 DSH 解析、非预期 DSH 路径、两套版本清单不一致、多个 Cordis 实例以及包归档请求。本地索引只包含当前平台已安装的 metadata，因此只报告而不拒绝 npm 已接受的不可用可选包探测。

```sh
pnpm run verify-npm-install-layout
```

计算下一项 Host 包时，命令会在内存中应用当前策略、测量 baseline、逐个尝试可达且未配置的包，并串行复测粗筛中最快的候选。正数 `gainSeconds` 等于 `baseline median - candidate median`；`--candidates` 限定名册，`--jobs` 控制粗筛并发度，两个阶段都不写 manifest。选中的候选仍需先完成导出分类，才能加入 `hostPackages`。

```sh
pnpm run benchmark:npm-resolution:next -- --runs=1 --finalist-runs=5 --finalists=5 --jobs=8 --timeout-ms=120000
```

### 性能验证

[`verify-npm-install-layout`](../../../../scripts/verify-npm-install-layout.ts) 是 `Release (dsh)` workflow 在每个 pull request 和 master push 上运行的确定性包路径与版本检查；它不限制 resolver 耗时。[`benchmark-npm-resolution`](../../../../scripts/benchmark-npm-resolution.ts) 与 [`benchmark-next-package-dependency`](../../../../scripts/benchmark-next-package-dependency.ts) 保持为手动工具，因为 resolver 耗时会随机器负载和 metadata 完成顺序变化。它们通过全新 consumer 和仅 metadata 的运行，把 npm 依赖树计算与 registry 延迟、包归档下载分离，因此相对结果可以定位 peer 中继，但不构成发布时性能承诺。

生成后的策略目前在 13 个包中留下 27 条位于 `dependencies` 的受管 Host 运行时边。两条边仍位于 `peerDependencies`：`dsh-api-remotes → dsh-scope` 使用 `carrierKeyOf`，`dsh-session → dsh-scope` 使用 `scopeOf` 与 `scopeTarget`。

## 考虑过的替代方案

**把内部关系继续保留为 peer。** npm 必须沿汇合的祖先路径放置并验证每个必需 peer；即使内部版本全部兼容，也会重新产生已报告的安装耗时问题。

**用 `"./client"` export 作为 Client 门面名册。** 包可能发布 Client 类型或浏览器 API，却不贡献动态装载 row。选中这类包会把迁移扩大到 Goal、Session Title 和 Todo 等无关 Host 包。`dsh.client` 标识动态 row，而 `packages/client/` 目录独立覆盖静态 Client 输入。

**拍平全部 Host 包。** 这会移除更多 peer 工作，却把迁移扩大到单包 benchmark 收益可忽略的包。显式 Host 列表会保留其余 peer 约束，直到测量结果证明应增加新成员。

**把所有 Client 相关声明都改为仅开发依赖。** 双面包的 Host value import 仍是实际的 Node 加载；从发布依赖图中删掉它们，会让包依赖 profile 的偶然提升。

**在 CI 中强制墙钟阈值。** Resolver 耗时会随机器负载和 metadata 完成顺序变化。确定性的 manifest 分类进入 CI，耗时测量保留为维护者 benchmark。

## 结果

发布依赖图按产物归属而不是源码目录耦合分类。Client bundle 与发布 profile 提供浏览器运行时身份，Host 模块安装自己加载的可重复实体，而 Cordis 和显式标为 peer-required 的 Host 导出继续共享包实例。

把公开纯类型关系放进 `devDependencies`，意味着独立 TypeScript 消费者在使用该声明时必须自行安装被引用的类型包。发布 profile 会安装完整的受支持包族；若要支持独立组装的 TypeScript 消费者，需要另一套策略。

显式 override、Host 列表、包分类与导出分类都是需要评审的决策。当 `instanceof` 使用的 class constructor、私有 symbol 和模块本地 registry 跨包传递 identity 或不可访问状态时，它们要求 peer。稳定的结构标记或带版本的 prototype 描述符可以让特定值互操作，但仅仅属于 value import 并不能做到这一点。修改分类会改变安装图，因此需要运行聚焦 verifier 测试、双版本布局检查并重新执行 next-package benchmark。仅 metadata benchmark 是诊断证据，不是发布时安装耗时承诺。
