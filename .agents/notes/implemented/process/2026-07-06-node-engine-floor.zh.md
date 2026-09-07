# Agent Note: 将 Node LTS 引擎下限提升至 22.19

Status: implemented

[English](2026-07-06-node-engine-floor.md) | 中文

## 问题

根 `engines.node` 范围中的 Node 22 分支是对安装后工作区的约定，而不仅仅是 harness 源码直接调用的运行时 API 的约定。它不得低于工作区在该分支上安装的依赖包所声明的 `engines.node`；否则 `pnpm install --engine-strict` 会在一个已宣传的 LTS 版本上失败，而非严格模式下的安装结果则会在依赖所支持的运行时范围之外运行。

## 决策

将 `engines.node` 设为 `^22.19.0 || >=24.0.0`，并在 `['22.19', 24, 26]` 上运行 keyless CI。主要的 Node 24 任务负责整套类型检查和单元测试覆盖率任务；三个版本均运行 source-worker、Zstandard、source-launch 和 [jsdom 存储](../../archived/testing/2026-07-30-vitest-jsdom-webstorage-ownership.md) 专项冒烟测试，不重复这套类型检查和覆盖率任务。真实 API 的 e2e 工作流保持在 Node 24 上，因为它验证的是 API 集成而非运行时下限。

两个 Node 特性决定了源码运行时的门槛：

- **`node:sqlite`**：`packages/storage/storage-sqlite` 在顶层执行 `import { DatabaseSync } from 'node:sqlite'`，可选 Session-query provider 则在首次搜索时加载它。该模块在 **22.13**（LTS）和 **23.4**（Current）取消了 `--experimental-sqlite` 标志要求；在此之前，导入它会在加载时抛出异常。
- **原生 TypeScript 类型剥离**——构建模式的 `apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts` 冒烟测试使用纯 `node`（无 tsx）启动 test-support 的 `.ts` driver，并加载 `.ts` 测试适配器（`cli-mock-llm.ts`）。类型剥离从 **22.18**（LTS）和 **23.6**（Current）起成为默认行为；更早版本需要 `--experimental-strip-types`。

这些源码特性在 22.x 线上于 **22.18** 全部就绪，但已安装的 Pi 适配器依赖将宣传的 LTS 下限进一步提高。`@deepseek-ai/dsh-llm-pi-ai` 依赖 `@earendil-works/pi-ai@0.79.3`，后者的包声明 `engines.node >=22.19.0`，因此 LTS 下限为 **22.19**。24.x 分支保持 `>=24.0.0`。该不相交范围完全排除了 Node 23：Node 23.0–23.5 至少还有一个源码特性需要标志，而 23 线是非 LTS/已 EOL 的，宣传 `>=23.6` 会增加一条已终止的发布线和一条 CI 分支，而没有任何部署应当使用它。

`@types/node` 继续固定在 22.x 线（`^22.20.0`），以匹配 LTS 支持线：使用 Node 23+/24+/25+ 的 API 会在所有机器和类型检查门禁中导致 `tsc` 失败，而不是先编译通过，直到下限矩阵分支运行时才暴露错误。整个代码树针对 Node 22 类型 API 的类型检查全部通过，因此固定该版本不产生任何代价。

## 后果

- 宣传的 LTS 分支不再低于 Pi 适配器依赖的下限。
- CI 通过 Node 22.19 直接验证 Node 22 LTS 下限，将主要覆盖率任务保留在 `node: 24`，并用 Node 26 验证下一个偶数线；三个版本均运行聚焦的兼容性冒烟测试。
- 构建模式冒烟测试无需版本条件标志：在 22.19 上类型剥离已是默认行为，因此示例自有的 TypeScript driver 保持使用纯 `node fixture.ts` 路径。
- 未来若依赖或源码 API 提高运行时下限，必须在同一变更中同步调整 `engines.node`、兼容性矩阵和本 Agent Note。

## 曾考虑的替代方案

- **保持 `^22.18.0 || >=24.0.0`。** 否决：它宣传的 LTS 版本低于 Pi 适配器依赖的下限。`@earendil-works/pi-ai@0.79.3` 要求 `>=22.19.0`。
- **降级或固定 `@earendil-works/pi-ai` 以保留 22.18 的宣传范围。** 否决：当前 Pi 适配器依赖是预期工作区的一部分，且 22.19 仍在 Node 22 LTS 线内。
- **下限 `>=22.13`（`node:sqlite` 边界）加上在 22.13–22.17 的 built-bin 冒烟测试中使用 `--experimental-strip-types`。** 否决：它为一个狭窄范围增加了版本条件测试标志，并将实验性标志依赖包装为正式支持。Pi 适配器依赖已经要求更高的 LTS 下限。
- **使用无上限的 `>=22.19`。** 否决：它宣传支持 Node 23.0–23.5，而在这些版本上 `node:sqlite`（直到 23.4）或类型剥离（直到 23.6）仍需标志。
- **包含 Node 23.6+（`^22.19.0 || >=23.6.0`）。** 否决：23.6+ 确实能无标志运行两个源码特性，但 Node 23 已结束生命周期（EOL）；宣传一条已终止的发布线会增加一个范围项和一条 CI 分支，而没有任何部署应当使用该运行时。
- **矩阵 `[22, 24, 26]` 而非固定 `22.19`。** 否决：浮动的主版本号条目会随时间上漂，悄然不再验证所声明的 LTS 下限。
- **保持 `@types/node` 超前于运行时下限（`^25`）。** 否决：类型定义超前于运行时下限会让仅 Node 24/25 才有的 API 编译通过，仅在 22.x 上运行时才失败。将 `@types/node` 固定在 22.x 线上可将此类问题转化为所有环境下的编译错误。
