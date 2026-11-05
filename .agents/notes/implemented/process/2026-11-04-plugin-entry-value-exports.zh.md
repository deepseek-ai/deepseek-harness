# Agent Note: 插件入口不得新增值导出

Status: implemented

[English](2026-11-04-plugin-entry-value-exports.md) | 中文

## 问题

[包表面规则](../../../../docs/defensive-patterns/package-surface.zh.md)把插件入口限定为 Cordis Loader 加载的内容：函数插件的入口导出 `name`、`inject`、`Config`、`apply`，服务插件的入口默认导出它的插件类；除此之外，Host 入口只可再导出供其他包 `extends` 或 `throw` 的 Service Definition 类与错误类型。此前没有门禁检查这条规则，超出规则的值导出在许多插件入口上累积；例如 `dsh-mcp-client` 的入口新增了 `probeServer`、`ReconnectSchema` 以及另外四个由 `dsh-mcp-manager` 导入的值。

Cordis Loader 在插件条目激活时才导入它的入口，并且只读取插件形态提供的内容：函数插件模块命名空间里的 Loader 字段，或服务插件默认导出的类。入口上的其他值都是其他包可以静态导入的 API；这种导入会在导入方加载时执行该入口模块及其依赖，不经过该条目的激活，也不等待 `inject`。

## 决策

门禁 [verify-plugin-entry-exports](../../../../scripts/verify-plugin-entry-exports.ts) 对两种插件形态执行这条规则：

- **范围**：每个作为插件入口的 `packages/<group>/<package>/src/index.ts`。导出了名为 `apply` 的值的入口是函数插件；没有 `apply`、而默认导出 Loader 能构造的类的入口是服务插件。库、默认导出不是类的入口，以及默认导出抽象类的入口都不检查；抽象类定义的是供提供方继承的能力接缝，Loader 无法构造它。
- **compiler face**：门禁先用 Host compiler face、再用 Client face 读取每个入口，由第一个编译它的 face 判定。两个 face 都不编译的入口会让门禁失败；找不到任何函数插件入口或任何服务插件入口时也失败。
- **判定**：函数插件入口可以导出 `name`、`inject`、`Config`、`apply`，服务插件入口可以用任意名字导出它的默认类。两者都还可以导出类型，以及每个构造签名构造出的实例其基类型都能追溯到 Cordis `Service` 或全局 `Error` 的值。类声明、类表达式和 mixin 结果按同样的条件放行。其他值都会失败，包括经 `export *` 带出的值、目标无法解析的导出，以及模块无法解析的 `export *`（以 `*` 报告）。服务插件入口上的 `name`、`inject`、`Config` 和其他值一样会失败，因为 Loader 从类上读取它们。`apply` 旁边的默认导出无论是什么都会失败，即使是放行的类，因为 Loader 此时会加载默认导出，而不是模块命名空间。
- **值还是类型**：按入口在运行时导出的名字判定；因为 `verbatimModuleSyntax` 是关闭的，模块目标和本地绑定和 [verify-optional-dependency-imports](../../../../scripts/verify-optional-dependency-imports.ts) 一样基于绑定后的 Program 解析。仅类型的导出和声明不产生任何输出，再导出只在目标是运行时导出时才产生输出，`export *` 带出目标的全部运行时名字，但不包括 `default` 和本模块自己导出的名字。因此 `export type` 不会遮住 `export *` 以同名带出的值，而只能经 `export type *` 到达的名字，无论经过几层，都算类型。
- **存量导出**：[plugin-entry-existing-exports.ts](../../../../scripts/plugin-entry-existing-exports.ts) 按包列出门禁引入时各入口已有的值导出。每一行记录的是存量欠账，不是批准的例外。列出的导出可以通过。以下情况该行失败：包没有入口或入口不是插件入口；导出列表为空或有重复的名字；列出的导出已不再被入口报告。因此删除一个导出时要在同一改动中删掉它在清单里的行。任何文档或测试都不记录清单条目的数量；门禁只打印它匹配到的数量。
- **注册**：[run-gates](../../../../scripts/run-gates.ts) 的共享卫生门禁，因此在 CI static lane、master CI、本地 `hygiene` 和 `check-all` 聚合以及 Windows observational lane 中运行。

## 考虑过的替代方案

**在 CI 中把清单与 PR 的 base 比较。** CI 已经把 base 提交传给[冻结归档门禁](2026-07-26-frozen-agent-note-archive.zh.md)，因此门禁可以拒绝改动新增的每一行。但这种比较也会拒绝正当的改动：包改名会把它的行移到新的键下，回滚一次导出删除会恢复一行。新增条目仍由 review 决定，和仓库里其他放行清单一样。

**生成基线并用命令裁剪。** [unknown-cast 门禁](2026-09-19-no-unknown-casts.zh.md)维护一份生成的 JSON 基线和 `--prune` 命令。手工编辑的 TypeScript 清单在 diff 中每个包一条，便于阅读，门禁的校验会指出要删的行。

**只检查函数插件入口。** 规则的判定条件写的是函数插件的 `src/index.ts`，但规则第一段同时描述了两种入口形态，并且规定 Host 入口在 Loader 加载的内容之外只能导出 Service Definition 类与错误类型。其他包从服务插件入口导入的值同样绕过了插件条目；只检查函数插件的门禁，会让入口改成默认导出类就避开检查。

**检查指向包子路径的 Loader 条目。** Loader 条目可以指向包根以外的模块。找出这些模块需要读取所有 profile、bundle 和 preset 组合，本门禁不做这件事，因此仍由 review 负责。

**在同一改动中删除所有存量导出。** 删除清单里的导出需要改动几十个包的测试和使用方。有了清单，门禁可以立即拦住新增导出，各包再自行删除存量。

**按声明语法判断类。** 只放行继承 `Service` 或 `Error` 的 `class` 声明，会拒绝构造出同样实例的类表达式和 mixin 结果。门禁按导出构造出的实例判断。

## 后果

插件入口新增值导出时，CI 失败并给出文件、行号、包名和导出名，消息中写明规则和改法。存量导出在所属包删除前继续可用，每次删除都会让清单变短。

门禁先构建 Host Program，再构建 Client Program，并在构建第二个之前释放第一个，因此峰值内存接近 Host Program 本身，与 verify-optional-dependency-imports 相当。

指向子路径的 Loader 条目、默认导出不是类的入口、经 `./src/*` 的深导入，以及导入清单中导出的使用方都不在门禁范围内，仍由 review 负责。`/client` 入口遵循 [Client 包规则](../../../../packages/client/AGENTS.md)，Client 构建已经拒绝跨插件的值导入。清单和其他文件一样可以新增行，因此新增条目依赖 review。

## 测试

[verify-plugin-entry-exports.spec.ts](../../../../scripts/verify-plugin-entry-exports.spec.ts) 编译一个 fixture，它有自己的 Host、Client 配置和一个替身 Cordis `Service`。它锁定每种被报告和被放行的导出写法（包括经 `export type` 与多层 `export type *` 的运行时路径，以及只是与根类同名的基类）、入口导出 `apply` 的三种方式、只经仅类型路径到达的 `apply`、默认类继承 `Service` 或不继承任何类的服务插件入口、不是插件的入口（库、默认导出抽象类、默认导出函数）、只有 Client face 编译的入口、两个 face 都不编译的入口、每项清单校验、缺少任一插件形态的语料，以及没有名字的 manifest。[run-gates.spec.ts](../../../../scripts/run-gates.spec.ts) 锁定门禁的注册。在真实的函数插件或服务插件入口上新增一个值导出并删除一个已列出的导出，门禁会同时报告这两处。
