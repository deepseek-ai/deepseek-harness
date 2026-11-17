---
kind: upgrade-guide
description: "Python PTC 运行时包、外部提供方、SDK 渲染器和 Python 专属绑定 API 均已移除，须迁移到 TypeScript PTC。"
---

# 移除 Python PTC

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-experimental-ptc-runtime-python` 不再发布，也不再包含于本仓库。选择该包的自定义组合必须迁移到 [`@deepseek-ai/dsh-ptc-runtime-node`](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md)。已发布 profile 已经选择 Node 提供方。`dsh-tool-executor-ptc` 也移除了对报告 `language: 'python'` 的外部 `PtcRuntime` 提供方的支持：通过已选中的执行器组装提示词、执行程序，或使用非 TypeScript 提供方创建 `/run-code` 工具，会以 `ToolContextUnavailableError` / `TOOL_CONTEXT_UNAVAILABLE` 失败。该包不再导出 `jsonSchemaToPy` 或 `renderToolsSdkPy`。

## 迁移

1. 在选择 Python 提供方的 `cordis.yml` 或 profile patch 中，将对应行的 `name` 替换为 `@deepseek-ai/dsh-ptc-runtime-node`。移除该行的 Python 运行时 `config`；如有需要，单独配置 Node 限制。除了 `sandbox` 和 `sandboxPolicy`，Node 还需要 `fs` 与 `subprocess`。复用已有提供方；本地组合若缺少它们，在同一执行环境中挂载 `@deepseek-ai/dsh-fs-local` 与 `@deepseek-ai/dsh-subprocess-local`。
2. 替换任何外部 Python PTC 提供方，移除 `jsonSchemaToPy` 与 `renderToolsSdkPy` 导入。需要渲染 SDK 时使用 TypeScript 的 `renderToolsSdk` API。`dsh-ptc-runtime` 将 `PORTABLE_RESERVED_WORDS` 替换为 `RESERVED_BINDING_WORDS`，并移除 `DUNDER_MEMBER`；删除 Python 专属的绑定命名检查。
3. 将 Python `run_code` 程序改写为 TypeScript。如需每次调用都使用全新执行环境，设置 `config.executionMode: per-call`；参见 [Node 运行时配置](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md)。
4. 如果仍需使用相关工作流，重新启用仅因 Python 提供方而禁用的 `workflow-ptc`、`tool-workflow`，以及此前启用过的 `tool-ralph` 行。
5. 为受影响的 profile 添加 `--dump-config` 并运行，确认其 PTC 运行时行选择 `@deepseek-ai/dsh-ptc-runtime-node`，且不再保留 Python 提供方行。运行一个 PTC 任务并确认其 TypeScript 程序完成。

`python/sdk` 中的 Harness Python 客户端、其打包运行时 wheel，以及其他工具使用的 Python 环境均不受影响。已有 Session 日志保留其记录的输出。
