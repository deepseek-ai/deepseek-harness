---
kind: upgrade-guide
description: SDK profile 新增 cordis_inspect 运行时检查工具。
---

# SDK 运行时检查工具

[English](guide.md) | 中文

## 变更

`sdk` profile 现在挂载提供检查注册表及其 Host provider 的 `cordis-host-runner`，以及 `tool-cordis`，模型像在 Desktop 标准模式和创造模式中一样收到 `cordis_inspect`。Host 查询读取 Service、Event、Config、Runtime 和 Tool 数据；SDK 不提供浏览器，因此目录不列出 Client provider。`sdk-minimal` 保持不变。

## 迁移

1. 检查固定的提示词、工具 schema 和工具名允许列表，确认新增的 `cordis_inspect` 定义。
2. 如需保持原来的工具集合，在 profile patch 中禁用 `tool-cordis` 行：

   ```yaml
   - id: tool-cordis
     disabled: true
   ```

   这样只移除工具。如需同时从进程中移除检查注册表和 Host provider，还要禁用 `cordis-host-runner` 行。

3. 运行一个任务，确认首个模型请求只在该行启用时列出 `cordis_inspect`。
