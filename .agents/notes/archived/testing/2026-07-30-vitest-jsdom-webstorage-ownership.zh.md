# Agent Note: 在 Vitest 中将浏览器存储交由 jsdom 管理

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-vitest-jsdom-webstorage-ownership.md) | 中文

## 问题

受支持的 Node 版本范围包含会预留进程级 `globalThis.localStorage` 的版本。未设置 `--localstorage-file` 时，Node 26 将该属性暴露为 `undefined`；Vitest 检测到这个预留键后，不会用 jsdom 的隔离 `Storage` 对象覆盖该属性。因此，组件测试套件尚未验证产品行为便会失败，而主要的 Node 24 覆盖率通道仍能通过，因为该运行时默认不会预留此键。

## 决策

当运行时声明支持 `--webstorage` 标志时，Vitest worker 会禁用 Node 的进程级 Web Storage。配置通过每个测试项目的 `execArgv` 传入 `--no-webstorage`；未声明该标志的运行时则不传入此参数。因此，Node 环境测试套件不加载浏览器环境，而通过 `@vitest-environment jsdom` 选择 jsdom 的文件会获得 jsdom 隔离的 `localStorage`。

Node 兼容性汇总任务会在每条声明支持的兼容版本线上运行专用的 jsdom 冒烟测试。该测试同时断言 worker 参数按条件传入且存储可用，因此未来 Node 或 Vitest 的变化不会让主要的 Node 24 测试套件成为唯一检测信号。

## 曾考虑的替代方案

- **在包脚本或 CI 中设置 `NODE_OPTIONS=--no-webstorage`。** 否决：这会将测试运行器策略传播到子进程，也无法覆盖直接调用 `pnpm exec vitest` 的情况。
- **向 Node 传入 `--localstorage-file`。** 否决：单个进程级持久化存储与每个 jsdom 环境分别创建的浏览器存储具有不同的归属和隔离语义。
- **在初始化代码中修改 `globalThis.localStorage`，或为每个组件测试增加保护逻辑。** 否决：初始化逻辑会依赖 Vitest 私有的 jsdom 映射细节，而逐测试添加的保护逻辑会掩盖浏览器环境损坏，并在多个测试套件中重复该策略。
- **将测试固定在 Node 24。** 否决：包的引擎范围声明支持更新的偶数 Node 版本线，而兼容性矩阵正是为了暴露这些版本的运行时变化。

## 后果

同一条 `pnpm test` 命令在有无内置 Web Storage 的 Node 版本上均可运行。测试 worker 被有意禁止使用 Node 的进程级 Web Storage；未来若产品需要该 API，必须使用独立且显式的测试配置，而不能削弱 jsdom 隔离。兼容性通道只增加一个专项 Vitest 进程，无需在每个 Node 版本上重复整套单元测试。
