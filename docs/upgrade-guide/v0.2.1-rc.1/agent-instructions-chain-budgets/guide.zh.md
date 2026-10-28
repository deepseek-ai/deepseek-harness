---
kind: upgrade-guide
description: "@deepseek-ai/dsh-agent-instructions 的 maxBytes 分别限制每条指令链，因此同时包含两条链的基线最多可达配置值的两倍。"
---

# 按指令链设定 `@deepseek-ai/dsh-agent-instructions` 的 `maxBytes`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-agent-instructions` 的 `maxBytes` 原先限制完整的工作区指令基线和每条对账消息。现在它分别限制用户全局指令链（`$DSH_HOME/AGENTS.md` 与共享 agents 根目录）和项目指令链，因此同时包含两条链的消息最多可达配置值的两倍。导出的 `loadBaselineInstructions` 与 `renderAgentInstructions` 遵循同一上限。把 `maxBytes` 当作总提示词预算设定的部署会看到更大的上限。

## 迁移

1. 若仍须遵守原来的总量，在部署的 `cordis.yml` 或 patch 中 `@deepseek-ai/dsh-agent-instructions` 配置行里把 `maxBytes` 减半；`dsh-base` 保持 `65536`。`maxBytes` 属于基线标识，因此修改后恢复的每个会话都会收到一次完整的替代基线。

   ```yaml
   - name: '@deepseek-ai/dsh-agent-instructions'
     config:
       maxBytes: 32768
   ```

2. 启动新会话，在其会话日志中读取第一条 `source.kind` 为 `agent-instructions` 的 `user/message`：其文本不超过 `maxBytes` 的两倍，且一行 `Workspace instruction budget ...` 会指名所有被省略或截断的文件。
