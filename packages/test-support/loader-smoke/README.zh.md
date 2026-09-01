---
description: "面向无密钥示例冒烟测试的共享子进程与直接 agent harness，供测试作者启动真实 Loader 组合。"
kind: "package-library"
---

# @deepseek-ai/dsh-loader-smoke

[English](README.md) | 中文

## 概述

`dsh-loader-smoke` 在隔离的临时目录中通过 Cordis Loader 运行真实的应用可执行文件及其 `cordis.yml`，捕获 stdout 与 stderr，使冒烟测试检验真实的组合路径——插件加载、服务接线与 agent loop（智能体循环）——而非手工搭建的测试上下文。`runFixtureTurn` 让一项任务通过组合中的唯一根 agent（智能体），并返回最终 assistant 文本与累计 token 用量。本包还为包内子进程 harness 提供共享的模式感知启动解析器（`src` 模式经 tsx，零构建开发路径；`lib` 模式经普通 Node 运行已构建产物，供 CI 使用）。它是支持层测试基础设施，而非产品 API。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包以已安装消费方的方式启动应用 fixture，并让测试观察结果：选择源模式或构建模式，从隔离 cwd 用其配置启动可执行文件，然后要么等待干净退出，要么让一项任务通过根 agent。

### 启动应用 fixture

`runLoaderSmoke` 接受可执行文件与配置路径、可选的完整可执行文件参数、环境覆盖、标准输入、运行前准备与清理前检查。它负责隔离工作目录、DSH 主目录、诊断、截止时间、终止、EOF 与清理；进程以零状态退出后返回两个流，失败时则拒绝并附带两个流：

```text
const result = await runLoaderSmoke({
  label: 'acp-agent',
  tempDirPrefix: 'acp-smoke-',
  binScript: '/abs/path/to/src/bin.ts',
  configPath: '/abs/path/to/cordis.yml',
  tsconfigPath: '/abs/path/to/tsconfig.json',
})
```

当场景固定一个设计好的失败面——例如一次性轮次以错误结果结束——时设置 `expectedExitCode`；以任何其他方式退出（包括成功退出）都会使冒烟测试失败。

### 测试交付 profile

Profile 集成 driver 使用仅限仓库内部的 `tests/fixtures/production-profile.ts` helper。它通过 `loadProfile` 加载指定的已交付 profile 及其组合包 patch，修复 profile 的模块回退，然后把组合包 patch 与测试 `*.patch.yml` 文件依次交给 `boot` 挂载的根 `cordis:include`。这些 patch 应只包含测试提供方或模型、隔离持久化路径及被测对象专用变更。只需要 agent loop 而不测试 profile 集成的包级单元测试改为在本地挂载 `dsh-agent-loop-testkit`。

### 驱动 fixture 轮次

`runFixtureTurn(ctx, options)` 让一项任务通过恰好一个已配置的根 agent：它等待任务进入持久收件箱，把规范事件转发给你的观察器，刷写会话，并返回最终 assistant 文本与累计用量。示例本地的 driver 继续负责配置、渲染与断言。

### 源模式或构建模式

`resolveExampleLaunch` 选择示例可执行文件从哪个产物启动。`src` 模式在 tsx 下运行可执行文件并设置 `TSX_TSCONFIG_PATH`，使工作区导入通过 tsconfig `paths` 映射解析——这是零构建开发路径。`lib` 模式在普通 Node 下运行构建后的 `lib/` 可执行文件，使裸包插件通过真实包 `exports` 解析，与已安装消费方的解析方式完全一致。模式来自显式值或 `DSH_EXAMPLE_MODE`（CI 设置 `lib`，开发时保持未设置）；其他任何值都会明确报错。

### 可能出什么问题

- **进程永不退出**——冒烟测试强制执行截止时间，并在失败信息中报告捕获的流；生成自身进程树的有故障 fixture（测试前置数据）可能比冒烟测试存活更久，需要外部清理。
- **构建模式需要事先构建**——选择 `DSH_EXAMPLE_MODE=lib` 前先运行 `pnpm run build`；拥有该配置的包 manifest 还必须声明配置中点名的每个包。
- **捕获输出受 execa 默认 100 MB `maxBuffer` 约束**——失控子进程在该上限处被终止，而不是在冒烟测试自选的预算处。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 harness 的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计

harness 建立在一个分离之上：冒烟测试在隔离世界中的子进程里运行，测试进程只观察与断言。`runLoaderSmoke` 创建临时 cwd、在那里准备世界状态、以隔离的 DSH 主目录（临时 cwd 下的 `DSH_HOME`、`DSH_AGENTS_HOME`）spawn 解析出的可执行文件、立即关闭 stdin，并在截止时间内等待干净退出，然后在每种结果下都执行检查与清理。`runFixtureTurn` 停留在进程内：它查找组合中的唯一根 agent，跟踪任务从持久收件箱接收到整个 agent 完全停稳，汇总每步用量，并在返回前刷写会话。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 模式解析器、`runLoaderSmoke` 子进程 harness、选项与结果类型 |
| [`src/agent-turn.ts`](src/agent-turn.ts) | `runFixtureTurn` 直接 agent driver 与结果信封 |
| — | 不发布运行时不变量伴生入口；消费它的测试套件会检验该 harness。 |
| [`tests/fixtures/production-profile.ts`](tests/fixtures/production-profile.ts) | 仅限仓库内部、供集成 fixture 使用的交付 profile 组装 helper |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 harness 逐步进入它启动的组合以及它所服务的 fixture。

- [llm-replay](../llm-replay/README.zh.md)——冒烟组合为无密钥运行而挂载的模型 fixture 来源。
- [Agent 包](../../core/agent/README.zh.md)——`runFixtureTurn` 驱动的根 agent。
- [测试策略](../../../docs/testing.zh.md)——无密钥快照与冒烟层级。
- [test-support 组地图](../README.zh.md)——兄弟 harness 与支持包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为测试 harness 仅提交调用方测试的普通用户任务，并将提示词与工具组装交由已加载的树负责。

#### KV Cache 影响

除已加载树本身的影响外，无其他影响；该 helper 既不更改请求前缀，也不跨运行保留状态。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明何时需要对该 harness 特别小心。它们是当前包约束，不是任务积压。

- **构建模式需要事先构建**——拥有该配置的包 manifest 还必须声明配置中点名的每个包。
- **捕获的 stdout 与 stderr 仅受 execa 默认 100 MB `maxBuffer` 约束**——失控子进程在该上限处被终止，而不是在冒烟测试自选的预算处。
- **超时只终止直接子进程**——有故障的 fixture spawn 的进程树可能比冒烟测试存活更久，需要外部清理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
