---
kind: upgrade-guide
description: "PTC 执行器 overlay 不再提供 workflow 工具，也不再加载 workflow 引擎。"
---

# PTC overlay 移除 workflow 工具

[English](guide.md) | 中文

## 变更

在此前的版本中，[`apps/cli/config/examples/ptc.yml`](../../../../apps/cli/config/examples/ptc.yml) 只把工具执行切换为 PTC，因此带该 overlay 的 headless 或 SDK 运行仍会列出 `workflow` 工具、其 `tool:workflow` 系统提示词段落以及对应的 `run_code` 绑定。现在该 overlay 还会禁用 `workflow-ptc` 引擎行和 `tool-workflow` 行，与 Web 的 `ptc` agent preset 相同：`run_code` 用代码编排工具调用，模型不再看到也无法调用 `workflow`。不带该 overlay 时默认的原生执行仍保留 workflow 工具。

受影响的是传入该 overlay 的 TypeScript 与 Python SDK 应用和 headless 运行，以及在 PTC 模式下预期存在 `workflow` 的提示词、评测或录制的会话记录。

## 迁移

1. 若要在 PTC 模式下保留 workflow 工具，在该 overlay 之后再应用一个重新启用这两行的 patch：

   ```yaml
   - id: workflow-ptc
     disabled: false

   - id: tool-workflow
     disabled: false
   ```

   通过 `--patch` 在 `ptc.yml` 之后传入，或在 TypeScript、Python SDK 的 `patches` 选项中放在该 overlay 之后。
2. 否则，把原先调用 `workflow` 的编排改为 `run_code` 程序或 `subagent` 调用。
3. 用一次 PTC 运行确认：不带额外 patch 时，第一个模型请求中没有 `tool:workflow` 段落，其 `run_code` 绑定也不声明 `workflow` 函数；带上该 patch 后两者都会恢复。
