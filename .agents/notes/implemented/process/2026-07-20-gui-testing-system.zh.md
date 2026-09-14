# Agent Note: GUI 测试体系——三层结构

Status: implemented

> 路径更新（2026-08-27，Remote 迁移）：本文三层理念与黄金路径方法仍为现行；对象层 spec 分布于 `packages/api/session-controller/tests/` 和 `packages/test-support/client-runtime/tests/`，Remote 与承载 spec 分布于 `packages/api/gateway/tests/` 和 `packages/client/connection/tests/`。组件 spec 是各 `packages/client/*/tests/` 下的插件级 jsdom 套件。组件 spec 形态遵循 [slot 体系标准](../architecture/2026-07-22-slot-type-chain-implementation.zh.md)：props 直喂——store 份额来自 `createXXXStore().create()`（真引擎，获认可的无额外机制路径），框架钩子用普通桩；无渲染机制、不挂载提供方。slot 归属和注册表语义归 2 层地界（`ui-renderer` + `ui-slots` 套件），不归组件 spec。

[English](2026-07-20-gui-testing-system.md) | 中文

> 分工线：本篇只讲 GUI（`packages/{client,host}/*` + `apps/web`）特有的测试结构；全仓测试政策（分层原则、with-key 政策、真实实现优先、REAL-composition）见 [docs/testing.md](../../../../docs/testing.zh.md)，不在此复述。

## Problem

GUI 栈需要考虑多种应用形态，同应用形态内的不同运行环境（Node host、数据协议层、浏览器对象层、React/DOM），单一车道的测试给不了有效信号。需要对各环节都进行有效测试，并具备全链路测试的基础能力。

## Decision

沿架构天然的测试钩子切分为三层，自底向上：

| 层 | 被测物 | 关键手段 | 文件落点 |
|---|---|---|---|
| 1 协议同构层 | 生成的 Typert Remote 描述符 + `ApiGateway` + Connection RPC 承载（参数/结果/错误/流/取消） | **同构点全链**：gateway host/client 套件在进程内验证描述符 codec 与 Remote 分派；Connection host 套件不经浏览器即可运行相同的 `/api` 承载帧与信任检查 | `packages/api/gateway/tests/`、`packages/client/connection/tests/` |
| 2 对象层编排 | `Session`/`SessionManager`/`ConnectionController`（状态机与时序：缝合/去重/翻页/乐观清稿/pendingBuffers/重连/退避） | **「事件序列进→快照出」黄金路径**：可编程假体 + deferred 控时序 + fake timers 控退避 | `packages/client/{runtime,connection}/tests/` |
| 3 组装呈现层 | 构建产物 × 真实 client loader 与插件组合 | 归应用所有的语义快照在 jsdom 下用测试持有的 `RemoteMock` 启动构建后 Client 图；Playwright 用例分别验证真实浏览器与 Host 载体，并通过 `dsh-llm-replay` 回放已录制的模型会话（[整机客户端测试档](../testing/2026-09-06-client-assembly-test-line.zh.md)、[web e2e 车道](../testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)） | `apps/web/tests/*.expected.e2e.ts`、`apps/web/tests/*.e2e.ts`、`apps/web/tests/*.snapshot.ts` |

层间纪律：**各层各测各的，上层不重测下层**：应用语义快照只固定组装后插件边界上的用户可见投影，Playwright 冒烟测试负责验证浏览器与承载层是否存活；wire 语义归 1 层，数据语义归 2 层。纯函数层（lineage/partial/notifier/transcript-adapter）随 2 层同包 tests/ 零假体直测。

- **host 与 client 源码**均纳入全仓 per-file 100% 覆盖率门禁，仅排除 `vitest.config.ts` 中带注释的少量浏览器级例外；组件套件通过逐文件 jsdom pragma 和 Testing Library 运行，不会改变 Node 套件。
- **归应用所有的语义快照**读取已构建的 client bundle，通过真实 loader 执行它们，并驱动确定性的 RemoteMock 场景。它们负责固定侧边栏标签、面包屑和 `document.title` 等稳定可见状态，而不固定 CSS 像素或下层状态机细节。

## 车道地图

| 场景 | 命令 | 内容 | 何时跑 |
|---|---|---|---|
| 基础 | `pnpm run test:gui` | 1+2 层 vitest（`packages/client packages/host`），秒级、无浏览器、无 server | 改 GUI 任意源码后随手跑 |
| 语义快照 | `DSH_EXAMPLE_MODE=lib pnpm run test:snapshot` | 无需密钥的组装应用语义，以及仓库按传输形态划分的预期输出 | 用户可见的 GUI 变更后；交付前 |
| 浏览器端到端 | `pnpm run test:web` | 先重建前端 dist，再运行 built-client RemoteMock 用例与真实 Host 浏览器场景，其中包括无密钥的录制会话回放（`DSH_SNAPSHOT=record`/`refresh` 重录 fixture／重写预期输出） | 改构建面/boot/承载后；交付前 |
| 浏览器预期输出门禁 | `DSH_SNAPSHOT=replay pnpm run test:web:built` | 复用 CI 构建的产物，并在不写入的情况下比较每份已提交的浏览器预期输出 | 每个 Linux 拉取请求 |
| 门禁 | `pnpm run test:coverage` | 全仓门禁（host 与 client GUI 包均纳入，仅排除带注释的浏览器级例外） | PR（Pull Request）窗口 |

**浏览器脚本与 vitest 的分工**：Playwright 负责浏览器/承载层黑盒回归和较长的连续用户操作流程；普通 vitest 负责引用稳定性、时序和 wire 结构等数据层语义；快照 vitest 通过构建后的组合负责稳定的应用层语义输出。这些车道彼此互补，而不重复断言。

## 防回归纪律

- **修一个 bug 钉一条断言**：浏览器可见的 bug 钉进所属浏览器 spec（冒烟测试或 e2e 场景）；数据层 bug 钉进对应 spec（先例：res-close 误判钉在 webserver 桥 suite——纯 Node 秒级复现，不再需要 12s 浏览器哨兵作唯一防线）。
- **RemoteMock 全绿不算完，真 wire 也要过**：已解码的进程内载体会刻意绕过 HTTP/WebSocket 链及其网络时序。改动触及 connection、bridge、handler 或流式 transport 时必须运行浏览器车道（`pnpm run test:web`），由其中的无密钥 e2e 场景驱动真实载体；带密钥的真实 Host 冒烟仍是真模型侧的补充。
- 落盘代码即答案的对表工作流：行为改动落盘打红既有用例时，当场对表校准（改测试还是改代码以 RFC/约定为裁），不留悬红。

## Consequences

各车道各测各层：改动任意 GUI 源码后都能获得秒级 `test:gui` 反馈，wire/对象层语义在 Node 环境中进行毫秒级断言，基于构建后组合的快照固定确定性的用户可见投影，浏览器负责接线与承载层验收。层间纪律仍由评审负责，而 Linux CI 通过机器门禁确保浏览器预期输出的新鲜度。每个新的应用快照都必须避开不稳定的布局或时钟输出。

## Alternatives considered

| 放弃项 | 一句话理由 |
|---|---|
| 单一 e2e（全走浏览器） | 浏览器起步秒级×N 倍慢+时序不可控；wire/对象层不变量在 node env 可毫秒级全断言 |
| verify 脚本迁 vitest | 有序脚本共享浏览器会话，拆 case 要么形式化（sequential+共享 page）要么重走前置×N；PASS/FAIL 流式输出正是 agent（智能体）定位接口 |
| 为测试保留生产 Client fixture | 它把交付代码耦合到场景数据和 query 选择的 transport；RemoteMock 与真实 Host 测试分别直接持有两个所需层级 |
| GUI 包独立 vitest config（曾设计 vitest.gui.config.ts） | 包级 tests/ 本就被根 include 扫到，`vitest run packages/client packages/host` 路径过滤即窄循环——零新 config |
| 钩子/组件层暂缓单测 | jsdom 仍是覆盖率主线，因为它能快速验证逐文件组件行为；必需的浏览器回放门禁在组装层与之互补，而非取代它（[CI 门禁决策](../testing/2026-07-30-web-browser-snapshot-ci-gate.zh.md)） |
