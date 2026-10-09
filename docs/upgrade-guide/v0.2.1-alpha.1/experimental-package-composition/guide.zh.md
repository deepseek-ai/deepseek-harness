---
kind: upgrade-guide
description: "可选 hooks、webhooks、工具与技能所需的显式安装、peer 依赖和配置。"
---

# 可选能力的显式安装与组合

[English](guide.md) | 中文

## 变更

CLI 与 Python 运行时的安装依赖不再包含 hook 桥接，CLI 也不再包含 webhook 包对。Base 与完整 Web 预设省略休眠的 Ralph 行，base 也省略休眠的徽章行。仅启用已移除行的 patch 不会插入其插件。默认活动行为、插件注册名称、工具名称与已记录的 Session 事件名称保持不变。

包归属和命名遵循[实验包策略](../../../../scripts/experimental-package-policy.ts)。安装与组合相互独立：安装插件包不会挂载它，必须先选择 bundle 才能配置其贡献的行。

## 迁移

1. 将目标 profile 缺少的包与所需 peer 一起安装。Profile 禁用自动 peer 安装。例如，运行 `dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code @deepseek-ai/dsh-hook-protocol`。Codex 桥接需要相同的协议 peer；GitHub 适配器需要同时安装 `@deepseek-ai/dsh-webhook` 与 `@deepseek-ai/dsh-webhook-github`。
2. 覆盖 bundle 的行之前先选择可用的 bundle。对于手动组合的能力，将覆盖已移除行的 patch 替换为完整插入。在预设的 `config.plugins` 中添加预设内工具及其所需服务。Host 徽章插入示例：

   ```yaml
   - insert:
       - id: skill-badge
         name: '@deepseek-ai/dsh-skill-badge'
   ```

3. GitHub review 使用适配器随附的示例，替代已删除的 CLI 示例。遵循[安装版 profile 说明](../../../user/guide/github-review.zh.md)；将定制规则模块保留在 profile 内，使其导入能解析该 profile 安装的包。
4. 启动 profile，确认配置的插件激活时没有缺包、缺 peer 或缺行错误。确认预期工具或技能在目标 Agent 预设中可用。
