# Agent Note: verify-cordis-config 对配置中插件的源码面解析实施门禁

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-cordis-config-source-plane-resolution-gate.md) | 中文

## 问题

`apps/cli/config/tui.cordis.yml` 新增了 `@deepseek-ai/dsh-tui/prompt` 配置项，却没有对应的 tsconfig `paths` 映射。通用的 `@deepseek-ai/dsh-*` 通配符会把 `tui/prompt` 整体代入其 `<group>/*/src` 候选路径，而这些路径全都不存在，因此 [tsx 源码启动](../architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md) 会回退到包的 `exports`，解析出产物面文件 `lib/prompt.js`。任何带有已构建 `lib/` 的环境（开发者目录树运行 `pnpm build` 后）都能正常启动，而 e2e 工作流以 `lib` 模式（`DSH_EXAMPLE_MODE=lib`，构建产物 bin 在普通 Node 下运行）执行无密钥 TUI PTY 冒烟测试，因此 CI 根本不会经过源码启动向量——与此同时，所有干净检出环境中的 `pnpm dsh` 都会在启动时失败，并报错 `plugin(s) failed to load: @deepseek-ai/dsh-tui/prompt`。当时没有门禁检查源码面，因此该故障未被发现便进入发布版本，仅在新的 worktree 中暴露。

## 决策

`scripts/verify-cordis-config.ts`（`validateSourcePlaneResolution`）要求配置中凡是引用本地 workspace 包的模块说明符（包括 harness 包与纳入 vendor 的 Cordis）都必须通过 `tsconfig.base.json` 的 `paths` 外观层（facade）解析到 `.ts`/`.tsx` 源文件；解析以仓库根目录为起点，调用 `ts.resolveModuleName` 完成。解析失败或命中 `.d.ts`（即经 `exports` 回退到构建出的 `lib/types`）都会使 `verify-cordis-config` 失败，并列出配置文件与模块说明符。缺失的 `@deepseek-ai/dsh-tui/prompt` 映射已添加在其他显式子路径条目旁；删除该映射即可复现门禁失败。

## 备选方案

**依赖无密钥 TUI PTY 冒烟测试。** 在默认源码模式下，该测试通过源码向量启动真实目录树，确实能捕获这个故障，但仅限干净目录树。CI 的 e2e 工作流只以 `lib` 模式运行它（构建产物 bin 通过真实的包 `exports` 解析），因此没有任何 CI 环节执行源码向量，而带有陈旧 `lib/` 的开发者目录树在本地也仍被掩盖。为 CI 增加一个源码模式冒烟测试，每次也只能证明一种组合；静态门禁则覆盖所有随产品发布的配置与示例配置。

**将 `dsh-source-launch-smoke` 兼容性测试扩展为完整启动。** node-compat 冒烟测试只断言 TTY 拒绝，而该拒绝发生在插件加载之前。每条矩阵版本线都执行一次完整的无密钥启动，会以更高成本重复 PTY 冒烟测试，而且同样只能验证一种组合，无法覆盖所有随产品发布的配置与示例配置。

**使用类似 `@deepseek-ai/dsh-*/prompt` 的通配符映射。** 这能修复当前子路径，却不能杜绝这一类问题；下一个单文件子路径导出（`/surface`、`/message` 等）仍会以同样方式复发。静态门禁覆盖当前及未来配置中引用的所有模块说明符。

## 结果

- 配置中的 workspace 模块说明符若只能通过构建后的 `lib/` 解析，现在会导致 `verify-cordis-config` 门禁失败（在 `hygiene` 和 CI 中执行），而不再成为只在干净目录树中出现的启动崩溃。
- cordis.yml 中引用新的单文件子路径导出时，必须同步为 `tsconfig.base.json` 添加显式 `paths` 条目；门禁消息会明确提示这一要求。
- 门禁只使用 `tsconfig.base.json` 的选项执行解析；如果某个模块说明符需要仅客户端可用的编译器选项才能解析，门禁就会失败。这符合该外观层作为 tsx 与 vitest 唯一解析入口的定位。
