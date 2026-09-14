# 后端续聊基准

[English](README.md) | 中文

## 概述

在不使用网络服务或所记录的用户数据的情况下，测量长历史请求处理、冷启动的工具密集型续聊和重复发现非活动 fork 子会话。SDK 变体通过已发布 sdk-minimal profile 和显式 editor patch 执行 100 个轮次和 800 次真实文件读取；其他用例隔离后端服务成本。所有用例均不渲染浏览器。

## 目录

- [运行](#run)
- [测量](#measurements)
- [开发备注](#dev-note)

<a id="run"></a>

## 运行

在仓库根目录使用 `pnpm run build:bench` 构建库和 worker，然后运行 `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/agent-continuation/agent-continuation.bench.ts`。不要让计时运行与构建或其他基准重叠。

测试报告全部五个新进程样本、CPU 型号、可用并行度、平台／架构和 Node/V8 版本，并约束经审查的中位数预算。目录和工具续聊用例均使用标准托管 CI 的 900 ms 期望值与 1.25× 余量（1,125 ms）；请求历史使用单独审查的 297 ms 托管上限（[证据](../../.agents/notes/implemented/simplification/2026-09-06-agent-request-freeze-evidence.zh.md)），SDK 续聊使用参考机器缩放。worker 失败时报告退出状态、信号、超时和 stderr；失败时也会删除临时根目录。必需基准通道自动发现此文件。

<a id="measurements"></a>

## 测量

[workload.ts](workload.ts) 负责定义合成维度。其当前代历史在首个步骤的用户输入之前保留空 system 头节点，因此续聊提示词会替换该头节点而不移动历史消息。[Agent Note](../../.agents/notes/implemented/testing/2026-09-06-backend-continuation-performance.zh.md) 负责说明计时终点、校准证据、内存解释和排除项。模型适配器不执行提供方序列化或网络调用；集成用例通过真实工具执行流水线运行合成工具体，SDK profile 变体则执行真实文件读取。

## 开发备注

无。
