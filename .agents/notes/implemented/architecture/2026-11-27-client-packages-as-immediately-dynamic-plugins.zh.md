# Agent Note: three Client packages as `immediately` dynamic plugins

Status: implemented

[English](2026-11-27-client-packages-as-immediately-dynamic-plugins.md) | 中文

> [Client 外壳分层 Agent Note](2026-08-15-client-shells-and-dynamic-packages.zh.md) 负责所有 Client 包的构建形态、共享模块请求和依赖声明。本 Agent Note 负责：`ui-slots`、`ui-primitives`、`ui-dockkit` 为什么是 `immediately` 动态插件包，而 `client-store` 仍静态链接；它们包根上的兼容调整；用哪种写法引用它们；以及对仓库外代码的兼容承诺。

## Problem

`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives` 和 `@deepseek-ai/dsh-client-ui-dockkit` 向大多数 Client bundle 提供同步的值，例如 slot 注册表类型、共享控件和 dock 布局引擎。Web 外壳曾静态链接它们，于是外壳 bundle 连同 KaTeX、Shiki 和 Markdown 解析器一起携带它们，并由外壳在模块表中预置它们的模块身份。

动态插件包是一个 Loader row，Host Loader 会在 Node 中 import 每个 row 的包根，而这几个包的样式表 import 在 Node 中无法加载。已发布包的 `exports` 可以把包根的类型和运行时指向不同的文件。在仓库里，每个名字只有一条 tsconfig `paths`，它同时服务 tsc、Vitest 和 tsx 源码启动，做不到这一点。

## Decision

### `immediately` 动态插件包

三个包都声明带 `platform: 'web'` 与 `immediately: true` 的 `dsh.client`，与 `ui-renderer`、`client-connection` 等其他 `immediately` 包相同，[`packages/bundle/web-app/cordis.patch.yml`](../../../../packages/bundle/web-app/cordis.patch.yml) 按纯包名列出它们的 row。`src/client/index.ts` 构建出 `./client` 导出 `lib/client.js`，其 `apply` 不登记任何东西。`immediately` 层在其他插件实例化之前登记这些 factory，因此任何 bundle 都可以 require 它们的导出，每个动态 bundle 也不必声明就会把这三个名字留给模块表（[共享模块表](../../../../packages/client/web/README.zh.md#the-shared-module-table)）。

它们与其他 `immediately` 包只有两点不同。它们的包根带有下文的兼容调整。它们的 `/client` 入口仍导出供其他 bundle require 的实体值，例如组件、类和函数；这是会逐步缩减的历史例外，不是新增实体导出的先例（[导出规则](../../../../packages/client/AGENTS.md#export-discipline-client-plugin-packages)）。

### `client-store` 是静态链接的库

`@deepseek-ai/dsh-client-store` 是 `staticLinked` 库，由 Web 外壳连同 Zustand 和 Immer 一起打包，并预置进模块表；仓库代码按包根 import 它，它也不 import 任何 DSH 包。`ui-slots` 和 `ui-primitives` 按包根 import 它，它们的动态 bundle 像对待其他基座模块一样把它留给模块表。如果需要 store service，那将是一个新包，而不是对这个包的转换。

### 包根：带 `./client` 类型的 Host 入口

包根的运行时是手写的 `src/index.js`，只导出空 `apply`，构建出 Host 入口 `lib/index.js`；这几个包没有 `src/index.ts`。和所有 Client 包一样，`tsconfig.base.json` 把每个包根映射到 `src` 目录，所以 tsx 把它解析到 `src/index.js`，Host Loader 从不求值 `src/client/index.ts`。这几个包没有 Host API，因此发布后的根 `types` 复用 `./client` 的声明 `lib/types/client/index.d.ts`，[`check-workspace-constraints`](../../../../scripts/check-workspace-constraints.ts) 接受与本包 `./client` types 相同的根 types。需要 Host 源码的门禁把 `./src/index.js` 解析到对应的源码模块。

### `X` 与 `X/client` 指向同一个模块

模块表在没有精确登记 `<specifier>/client` 时，会把它解析到 `<specifier>` 那一行（[`stripClientSuffix`](../../../../packages/client/modules/src/client/manifest.ts)），所以 `require('<包名>')` 与 `require('<包名>/client')` 返回同一个导出对象。动态构建预设通过 [`tsdown.client.ts`](../../../../packages/client/tsdown.client.ts) 中的 `coversRequest` 采用同一规则：当 `<specifier>` 是基线、预加载或 `dsh.client.external` 请求时，import `<specifier>/client` 的 bundle 会生成模块表 `require`，而不是内联一份私有副本。

### 仓库通过 `/client` 引用这些包

仓库代码从 `<包名>/client` import 值和类型，也扩展 `<包名>/client`；[`verify-client-packages`](../../../../scripts/verify-client-packages.ts) 拒绝对这样一类工作区包的任何包根引用：包的根 `types` 等于它自己的 `./client` types，这个集合从 manifest 中读出。仓库里的包根解析到 Host 入口：Vite 和 Rolldown 会找到 `src/index.js`，所以从包根 import 值会读到 `undefined`；编译器在那里也找不到声明。要让仓库里的包根带上声明，就得另写一个文件，而 TypeScript 只有在先处理 `/client` 扩展时，才会把同一接口的包根扩展与 `/client` 扩展合并。全部改用 `/client` 后，每个扩展都直接落在声明接口的那个模块上。`/client` 路径在所有工具中都解析到 `src/client/index.ts`，所以 Vitest 各 lane 不需要别名，benchmark worker 也从源码打包声明了 `dsh.client` 的工作区包的 `/client` 子路径（[`benchmarks/tsdown.config.ts`](../../../../benchmarks/tsdown.config.ts)）。

`/client` 也是对所有使用方推荐的写法。

### 兼容承诺

已发布包的根与 `./client` 是同一个声明文件，所以仓库外的代码可以使用任一写法，也可以混用。对按包根编写的代码，DSH 用测试守住两条承诺：

| 承诺 | 由谁保证 |
| --- | --- |
| TypeScript 使用方可以从包根导入类型、写 `declare module '<包名>'`，并在同一文件或不同文件中按任意顺序混用两种写法；在 NodeNext 与 Bundler 解析下，每个使用方读到的都是同一个合并后的接口 | `pnpm run hygiene` 中的 [`verify-client-package-consumer-types`](../../../../scripts/verify-client-package-consumer-types.ts)，它针对构建出的 `lib/types` 编译[外部消费者 fixture](../../../../scripts/fixtures/client-package-consumer/)；其负对照要求混用程序在转发型包根上编译失败 |
| 已构建插件的 `require('<包名>')` 与 `require('<包名>/client')` 返回相同的导出 | [`loader.client.spec.ts`](../../../../packages/client/modules/tests/loader.client.spec.ts)，以及使用手写预构建 fixture 插件的浏览器测试 [`client-package-specifiers.e2e.ts`](../../../../apps/web/tests/client-package-specifiers.e2e.ts) |

无论 import 哪种写法，动态 bundle 都生成模块表 `require`，且不内联这三个包中的任何模块（[`client-bundle-purity.spec.ts`](../../../../scripts/client-bundle-purity.spec.ts)）。不支持在 Node 中从包根取得值，不支持 `__$dsh_client_module_manifest` 导出，也不保证这些包导出的 API 稳定。

## Alternatives considered

**修改 `apps/cli/src/bin.ts` 或增加源码启动的 resolve hook。** 这样源码启动对这三个名字的解析会与 tsc 和 Vitest 不同，每个启动器和工具都得重复这条规则。

**修改 Loader 或 client-modules 的解析逻辑。** 模块表已经能应答包 row 及其 `/client` 子路径；为三个包加分支，会让它们成为一种特殊的 row。

**row 不用纯包名命名。** 其他 row 都用包名；给这几个 row 改名只会把特例挪进每个组合。

**重复 tsconfig paths，让一些工具把包根映射到 `/client`、另一些映射到 Host 入口。** 同一张 `paths` 表服务 tsc、Vitest 和 tsx，每个名字再加一套映射，就得给每个工具单独配置。

**自定义 export condition。** tsc、Vite、Rolldown、tsx 和 Node 都得各自启用这个 condition，没启用的使用方会读到错误的文件。

**在门禁和工具里检查 `.ts` 与 `.js` 文件是否存在。** 门禁的结果会取决于某个检出恰好有哪个文件；门禁改为直接写 `./src/index.js`。

**单独的「platform library」类别或变量。** 这三个包与其他包一样是 `immediately` 动态插件包；再加一个类别，会让文档和门禁多出第三种包。

**保留从包根 import 值，并在 Vitest 和 benchmark 中把包根别名到 `/client`。** 大约五百个文件会保留一种只有在有别名时才能工作的写法，每个新的测试 lane 或工具都需要这个别名。

**手写一个 re-export `./client/index.ts` 的 `src/index.d.ts`。** 包根会成为另一个声明文件：混用写法的扩展只在一种处理顺序下合并；做扩展的程序若不同时加载包根，会报 TS2664；解析已配置 row 的门禁也得接受 `src/` 下的声明文件。

**仓库内扩展包根，并拒绝 `/client` 扩展。** 它需要上面那个转发声明文件，而且把仓库固定在不推荐的写法上。

**把 `client-store` 也一并转换。** `client-store` 是不 import 任何 DSH 包的叶子库；它继续静态链接，如果需要 store service，将是一个有自己生命周期的新包，而不是对这个包的转换。

## Consequences

- Web 外壳不再打包这三个包、KaTeX、Shiki 或 Markdown 解析器，仍打包 `client-store`、Zustand 和 Immer；替换 Web 客户端的组合必须列出这三个 row（[升级指南](../../../../docs/upgrade-guide/v0.2.3-alpha.2/client-packages-dynamic-plugins/guide.zh.md)）。
- 仓库代码与外部代码共用一种推荐写法，按包根编写的代码仍能编译和加载。
- 在 Node 中包根只给出 Host 入口，所以运行这些包的浏览器侧代码的测试和工具要 import `/client`。
- 解析已配置 row 名的门禁，例如 [`verify-cordis-config`](../../../../scripts/verify-cordis-config.ts)，会落到 `src/` 下的 Host 入口 `src/index.js`。
- TypeScript 承诺之所以成立，是因为已发布包的根与 `./client` 共用一个声明文件；消费者检查的负对照表明，如果根 types 换成一个转发到 `./client` 的独立文件，混用写法的扩展就会分裂。
- 新的共享运行时代码经 Cordis service、slot 或浏览器安全的工具包提供，不放进这三个包的实体导出。
