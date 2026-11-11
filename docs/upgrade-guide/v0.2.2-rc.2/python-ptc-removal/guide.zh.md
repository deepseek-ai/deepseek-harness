---
kind: upgrade-guide
description: "自定义 Python PTC 组合必须将已移除的运行时包替换为 Node 提供方，并使用 TypeScript 程序。"
---

# 移除 Python PTC 运行时

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-experimental-ptc-runtime-python` 不再发布，也不再包含于本仓库。选择该包的自定义组合必须迁移到 [`@deepseek-ai/dsh-ptc-runtime-node`](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md)。已发布 profile 已经选择 Node 提供方。

## 迁移

1. 在选择 Python 提供方的 `cordis.yml` 或 profile patch 中，将对应行的 `name` 替换为 `@deepseek-ai/dsh-ptc-runtime-node`。移除该行的 Python 运行时 `config`；如有需要，单独配置 Node 限制。除了 `sandbox` 和 `sandboxPolicy`，Node 还需要 `fs` 与 `subprocess`。复用已有提供方；本地组合若缺少它们，在同一执行环境中挂载 `@deepseek-ai/dsh-fs-local` 与 `@deepseek-ai/dsh-subprocess-local`。
2. 将 Python `run_code` 程序改写为 TypeScript。如需每次调用都使用全新执行环境，设置 `config.executionMode: per-call`；参见 [Node 运行时配置](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md)。
3. 如果仍需使用相关工作流，重新启用仅因 Python 提供方而禁用的 `workflow-ptc`、`tool-workflow`，以及此前启用过的 `tool-ralph` 行。
4. 为受影响的 profile 添加 `--dump-config` 并运行，确认其 PTC 运行时行选择 `@deepseek-ai/dsh-ptc-runtime-node`，且不再保留 Python 提供方行。运行一个 PTC 任务并确认其 TypeScript 程序完成。
