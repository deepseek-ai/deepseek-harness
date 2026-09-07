# 活跃 Assistant 重连基准

[English](README.md) | 中文

[reconnect.bench.client.ts](reconnect.bench.client.ts) 测量重连携带未完成的 100,000 个 reasoning delta 前缀时，生产 Client 的折叠成本。编译后的私有适配器调用 `ClientAssistantStream.replace()`，不增加产品导出。三个全新纯 Node worker 在计时前合成紧凑 baseline；替换时间与强制 GC 后的保留 heap 分别执行中位数预算检查。下一个稠密序号的实时 frame 仍须被接受。标准托管 CI 使用 50 ms 替换预期及共享的 1.25× 余量（向上取整为 63 ms）；保留 heap 预算仍为 30 MiB。记录样本和合成回归对照使用与 worker 判定相同的时间断言。

通过 `pnpm run build:bench` 构建，再在 `vitest.bench.config.ts` 中选择 `benchmarks/active-stream-reconnect`。该聚焦 Node workload 既不构建也不测量浏览器渲染。[前端性能预算](../../.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.zh.md)记录校准与排除项。
