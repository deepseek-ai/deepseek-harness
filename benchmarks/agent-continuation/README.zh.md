# 后端续聊基准

[English](README.md) | 中文

## Summary

在不使用网络服务或录制用户数据的情况下，测量长历史请求处理、冷工具密集续聊和重复发现非活动 fork 子会话。SDK 变体通过已发布 sdk-minimal profile 执行 100 个轮次和 800 次真实文件读取；其他用例隔离后端服务成本。所有用例均不渲染浏览器。

## Table of Contents

- [运行](#run)
- [测量](#measurements)
- [Dev Note](#dev-note)

<a id="run"></a>

## 运行

在仓库根目录使用 `pnpm run build:bench` 构建库和 worker，然后运行 `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/agent-continuation/agent-continuation.bench.ts`。不要让计时运行与构建或其他基准重叠。

测试报告全部五个新进程样本，并约束经审查的中位数预算。目录和工具续聊用例均使用标准托管 CI 的 900 ms 期望值与 1.25× 余量（1,125 ms）；请求历史使用 190 ms 托管期望值与相同余量（238 ms），SDK 续聊使用参考机器缩放。worker 失败时报告退出状态、信号、超时和 stderr；失败时也会删除临时根目录。必需基准通道自动发现此文件。

<a id="measurements"></a>

## 测量

[workload.ts](workload.ts)拥有合成维度。[Agent Note](../../.agents/notes/implemented/testing/2026-09-06-backend-continuation-performance.zh.md)拥有计时终点、校准证据、内存解释和排除项。模型适配器不执行服务商序列化或网络调用；集成用例通过真实工具执行管线运行合成工具体，SDK profile 变体则执行真实文件读取。

## Dev Note

无。
