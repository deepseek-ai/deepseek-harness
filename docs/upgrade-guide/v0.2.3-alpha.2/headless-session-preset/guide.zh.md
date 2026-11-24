---
kind: upgrade-guide
description: "自定义 headless profile 按 ID 恢复 Session 时需要 agent preset 注册表。"
---

# 从自定义 headless profile 恢复 Session

[English](guide.md) | 中文

## 变更

`--session-id` 现在通过 `agentPresets` 服务读取已保存的 agent preset。直接挂载 headless runner 的自定义 profile 过去只需 Session 持久化与查询服务就能完成这项检查。内置的 `dsh-headless` 组合包会启用注册表，并保留已配置的默认值。

## 迁移

1. 如果自定义 profile 直接在 `dsh-base` 上挂载 runner，在 profile 的 `cordis.patch.yml` 里启用已有的注册表条目。

   ```yaml
   - id: agent-preset-registry
     disabled: false
   ```

2. 如果 profile 自行提供基础配置，在其依赖中添加 `@deepseek-ai/dsh-agent-preset-registry`，并插入一条使用该插件名的注册项。读取已保存的选择无需配置默认 preset。
3. 回到原工作目录，用已有的 headless Session ID 运行 `dsh --profile <profile> --session-id <id> "continue"`，确认 runner 恢复了该 Session。
