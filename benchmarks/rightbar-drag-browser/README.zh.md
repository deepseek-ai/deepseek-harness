# 右侧栏拖动浏览器基准

[English](README.md) | 中文

[rightbar-drag.bench.ts](rightbar-drag.bench.ts) 中的必需 Chromium 用例在一个已加载全部更早分页的 120 轮合成会话旁拖动右侧栏的宽度拖拽条，并统计拖动期间重算样式的元素数和布局次数。随产品发布的 Web 测试脚手架提供隔离的 home、持久化和回环监听；Chromium 加载已构建的 Web 产物。

## 运行

`pnpm run test:bench` 先构建库、worker 和 Web 产物，再运行串行基准清单。产物已构建时，可通过 `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/rightbar-drag-browser` 只运行本目录。导出了 `NODE_USE_ENV_PROXY` 的 shell 需要先取消它，这是[测试代理设置](../../scripts/test-proxy-environment.ts)的要求。

## 测量

两个全新的浏览器进程和脚手架环境各自在 1680×1000 视口中用 40 个真实鼠标步（每步 8px）加宽右侧栏，再拖回。Chromium 的时间线追踪覆盖每次拖动，直到松开后的两个动画帧。追踪前后测得的正文列宽都必须低于 680px 的正文宽度下限：加宽侧栏必须使正文列变窄，缩窄侧栏必须使正文列变宽。

- **样式重算：** 各次样式重算报告的元素数之和除以页面元素数。每个方向的上中位数不得超过 1（即一整个页面的元素数）。
- **布局：** 每次拖动必须产生至少一个 `Layout` 事件。`layoutCount` 统计所有布局；`scriptNestedLayoutCount` 只统计起止时间均落在同一进程、同一线程的脚本事件内的布局，每次布局只计一次，动画帧回调也算脚本事件。每次拖动此项不得超过 20（鼠标步数的一半）。嵌套关系是判断同步布局的间接指标，并不说明每次嵌套布局都多余；脚本以外的浏览器重排不占用该预算。

帧间隔、样式重算耗时和布局耗时仅作诊断。两项预算都不随 CPU 速度缩放。

夹具包含中英混排的正文、列表、12 个代码块、8 个表格、推理内容和 24 个工具结果。内容不来自任何模型、工具、外部网络、录制会话或私有 Harness home。[决策记录](../../.agents/notes/implemented/testing/2026-11-20-rightbar-drag-restyle-budget.zh.md)负责说明负载选择、校准、备选方案和排除项。
