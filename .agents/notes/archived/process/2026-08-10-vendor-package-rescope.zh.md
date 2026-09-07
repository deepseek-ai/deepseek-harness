# Agent Note: 把 vendored Cordis 重命名进 @deepseek-ai scope

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-vendor-package-rescope.md) | 中文

## 问题

`vendor/` 下的九个包此前保留上游 npm 名（`cordis`、`cosmokit`、`schemastery`、`@cordisjs/plugin-*`）。这个前提在发布时不成立：每个 harness 包都把 `cordis` 声明成 peer dependency，装了 `@deepseek-ai/dsh-*` 的消费者必须能从 registry 解析到它，所以发布 harness 必然连带发布这一层框架。用上游名发布就是在 registry 上占用别人的名字；若该 registry 对 npmjs 做上游代理，本名条目还会遮蔽真正的上游包，把错误的框架装进无关项目。

## 决定

九个包统一改名进 `@deepseek-ai` scope。目录名、上游版本号、依赖 range 一律不动，所以 `vendor/README.md` 的清单仍然读作一份上游快照。面向使用者的映射表见 [docs/rescope.md](../../../../docs/rescope.zh.md)。

| 目录 | npm 名 | 上游名 |
|---|---|---|
| `cordis/` | `@deepseek-ai/cordis` | `cordis` |
| `cosmokit/` | `@deepseek-ai/cosmokit` | `cosmokit` |
| `schemastery/` | `@deepseek-ai/schemastery` | `schemastery` |
| `loader/` | `@deepseek-ai/cordis-plugin-loader` | `@cordisjs/plugin-loader` |
| `include/` | `@deepseek-ai/cordis-plugin-include` | `@cordisjs/plugin-include` |
| `group/` | `@deepseek-ai/cordis-plugin-group` | `@cordisjs/plugin-group` |
| `timer/` | `@deepseek-ai/cordis-plugin-timer` | `@cordisjs/plugin-timer` |
| `hmr/` | `@deepseek-ai/cordis-plugin-hmr` | `@cordisjs/plugin-hmr` |
| `logger-console/` | `@deepseek-ai/cordis-plugin-logger-console` | `@cordisjs/plugin-logger-console` |

改写只落在**带定界符的完整包名 token** 上：引号或反引号包裹的 specifier（可带 `/子路径`）、`package.json` 的 `name` 与依赖键、`cordis.yml` 的 `name:` 值、`tsconfig.base.json` 的 `paths` 键。因此以下同形串一律未改，它们不是包名：`cordis.yml` 及其家族文件名、Loader 的 `cordis:` 内建前缀（`cordis:include`、`cordis:group`，见 `vendor/loader/src/config/tree.ts`）、`cordis-config-entry` 这类 kind 串、`@deepseek-ai/dsh-tool-cordis`、Schemastery 上游的 `Symbol.for('schemastery')` 与 `vendor:` 元数据、`scripts/gen-module-graph.ts` 与 `gen-doc-graphs.ts` 里 `GROUP_ORDER` 的 `packages/<group>/` 目录名，以及 `vendor/*/README.md` 里的上游安装指引。

Token 规则看不见两类点位，它们按名字逐处改：一是属性访问 `manifest.peerDependencies?.cordis`——TypeScript 抓不到过期的 `Record<string, string>` 键；二是把名字当数据的常量（`check-workspace-constraints.ts` 的 vendored 集合、`verify-cordis-config.ts` 的 group/include 名、`cordis-walk.ts` 与 `gen-scoped-events.ts` 与 typert `analyzer.ts` 里识别 `declare module` 目标的字符串、`app-boot/tsdown.config.ts` 的 `alwaysBundle`）。

Markdown 按「读者拿它做什么」一分为二。围栏一律跟着改，不看 info string——围栏里是读者要照抄的代码或要挂载的配置，包括写着 Loader 插件名的 `yaml` 围栏和紧邻编译围栏的 `ts ignore-check` 围栏。散文只在 `docs/` 下跟着改：教程里引用某个名字的句子，教的是本仓已不解析的东西。`docs/` 之外的散文——`vendor/*/README.md`、各包 README、`.agents/notes/`——保留写作当时的名字：既因为它记录的是当时的事实，也因为同一个拼写可能指别的东西，比如 Python SDK 的 `cordis` 选项、我们没 vendor 的 `@cordisjs/plugin-http`，或某个 agent-preset 的 id。

## 影响

- 发布集里不再有任何上游名：`publish-npm-baseline.ts` 现在无条件要求每个待发包都是 `@deepseek-ai/*`，vendored 包不再豁免，改名一旦回退就会在打包前失败。
- `vendor/README.md` 的清单表新增「上游名」列，`gen-third-party-notices` 随之解析六列并把上游名渲进 `THIRD_PARTY_NOTICES.md`；MIT 归属指向 fork 的来源，而不是我们的 scope。
- `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 删去 `cordis` 与 `@cordisjs/plugin-loader` 两条：改名后这两个名字永远不从 registry 取。
- 上游 sync 照 `vendor/README.md` 的流程走，第 3 步多一项：对拷进来的源码重跑 `pnpm run rescope-vendor --apply`，脚本里的映射与清单表两列名字必须一致。
- **要回到官方上游包**时反着跑这份映射——`pnpm run rescope-vendor --apply --reverse`——再补回 `minimumReleaseAgeExclude` 两条、放开发布集对 `@deepseek-ai/*` 的断言。改写量约 1300 个文件，用脚本重放而不是手改。

改名这件事由 `scripts/rescope-vendor.ts` 承载：映射、带定界符的 token 规则、名字其实是目录而非包时的逐文件豁免、上面那批精确改写，以及一个断言「零残留、每条精确改写都落上、幂等」的 `--check` 模式——它由 `hygiene` 门在每次 CI 上执行。rebase 时重放它，而不是去解一个 1300 文件的冲突；上游动了任一被钉住的点位，脚本会响亮失败而不是静默漏改。

## 考虑过的替代方案

**保留上游名，把 `vendor/` 排除在发布集之外。** 否决：每个 harness 包都声明 `cordis` 为 peer dependency，装好的 `@deepseek-ai/dsh-*` 会解析不到框架。

**只在打包时改名。** 否决：发出去的名字与源码树不一致，所有模块 specifier 得在发布路径里现改，本地也没有任何一次运行能复现发布出去的东西。

**目录名与版本号一并改。** 否决：目录名不是发布标识，改它会连带项目引用、tsdown glob 与文档路径，收益为零；版本号并入 `0.0.1` 后不再满足保留下来的 `^4.0.0-rc.7` range，pnpm 会转去 registry 找副本，`verify-vendored-links` 直接红。

**`docs/` 之外的散文与历史 Agent Note 一起改。** 否决：它们记录的是写作当时的事实，而且那里的裸 `cordis` 同样可能是 SDK 选项名或某个 preset id，未必是包；面向读者的映射由 `docs/rescope.md` 承载。
