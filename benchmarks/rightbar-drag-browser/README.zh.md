# 右侧栏拖动浏览器基准

[English](README.md) | 中文

[rightbar-drag.bench.ts](rightbar-drag.bench.ts) 中的必需 Chromium 用例在一个已加载全部更早分页的 120 轮合成会话旁拖动右侧栏的宽度拖拽条，并统计拖动期间 Chromium 重新计算样式的元素数。随产品发布的 Web 测试脚手架提供隔离的 home、持久化和回环监听；Chromium 加载已构建的 Web 产物。

## 运行

`pnpm run test:bench` 先构建库、worker 和 Web 产物，再运行串行基准清单。产物已构建时，可通过 `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/rightbar-drag-browser` 只运行本目录。导出了 `NODE_USE_ENV_PROXY` 的 shell 需要先取消它，这是[测试代理设置](../../scripts/test-proxy-environment.ts)的要求。

## 测量

两个全新的浏览器进程和脚手架环境各自在 1680×1000 视口中把拖拽条向外拖 40 个真实鼠标步（每步 8px），再拖回；该视口下正文列始终窄于 680px 的正文宽度下限，每次拖动都断言这一列宽，因此解析后的正文宽度不变。每次拖动都由 Chromium timeline trace 覆盖，直到松开后的两个动画帧。预算是每个方向上，所有样式重算统计的元素数之和除以页面元素数的中位数，不得超过 1：整次拖动重算的元素少于一个页面的量。该计数无量纲，不随 CPU 速度缩放。

在 Conversation 宽度轴把缩放输入留在主体元素上之前，每一帧都会重算整段记录：200 轮的本地样本重算了页面元素数的 51 倍和 66 倍。之后同样的拖动只重算 0.09 倍和 0.12 倍，120 轮负载为 0.14 倍和 0.18 倍；该计数与历史长度无关。帧间隔、样式与布局毫秒数和最终列宽只作为诊断输出：布局仍会按每个新列宽重排正文，本用例不为它设预算。

夹具包含中英混排的正文、列表、12 个代码块、8 个表格、推理内容和 24 个工具结果。内容不来自任何模型、工具、外部网络、录制会话或私有 Harness home。[决策记录](../../.agents/notes/implemented/testing/2026-11-20-rightbar-drag-restyle-budget.zh.md)负责说明负载选择、校准、备选方案和排除项。
