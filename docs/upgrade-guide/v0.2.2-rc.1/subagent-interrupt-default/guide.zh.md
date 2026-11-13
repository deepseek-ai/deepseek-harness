---
kind: upgrade-guide
description: "内置配置关闭普通 subagent 和 Team 模式的 interrupt_agent。"
---

# 内置配置关闭 agent 中断

[English](guide.md) | 中文

## 变更

base 组合包及 Web 的 `standard`、`cordis`、`ptc` preset 现在为各自的 `tool-subagent-control` 行设置 `config.interrupt: false`。使用这些配置的模型不再获得 `interrupt_agent`，也包括 Team 模式。消息、发现、收件箱等待和 subagent 服务的中断 API 仍然可用。插件自身的默认值仍为 `true`；省略该设置的独立组合仍提供中断工具。

## 迁移

保留 `interrupt: false` 可维持内置行为。如需恢复中断工具：

1. 编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。对于 `headless`、`sdk`、`acp` 等基于 base 的 profile，追加：

   ```yaml
   - id: tool-subagent-control
     config:
       interrupt: true
   ```

2. 对于 `web` 或 `desktop`，改为覆盖需要启用的声明行：`preset-standard`、`preset-cordis` 或 `preset-ptc`。从已安装的 `@deepseek-ai/dsh-web-app` 组合包的 `presets/<name>.patch.yml` 中复制该声明的完整 `config`（源码：[standard](../../../../packages/bundle/web-app/presets/standard.patch.yml)、[cordis](../../../../packages/bundle/web-app/presets/cordis.patch.yml)、[ptc](../../../../packages/bundle/web-app/presets/ptc.patch.yml)）。如果 profile 已经覆盖该声明，编辑已有覆盖以保留自定义配置。patch 会替换整个 `config`：保留 `id`、`order` 和完整的 `plugins` 列表，包括 `delegation` 组。在该组的 `config` 内，将 `tool-subagent-control` 行的 `config.interrupt` 改为 `true`。以声明的外层 ID 为 patch 目标，写法参见[修改内置 preset](../../../../packages/preset/agent-preset/skills/dsh-doc/references/compositions.md#change-a-shipped-preset)。顶层以 `tool-subagent-control` 为目标的 patch 无法修改 preset 内的子行，只会修改已禁用的 Host 行。保持该 Host 行禁用。
3. 重启 profile，并使用修改后的 preset 创建新 Session；已有 Session 保留原 preset 修订。确认模型的工具定义包含 `interrupt_agent`、`send_message`、`list_agents` 和 `wait_agent`。
