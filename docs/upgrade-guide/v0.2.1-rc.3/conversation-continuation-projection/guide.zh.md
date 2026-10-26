---
kind: upgrade-guide
description: "自定义 Conversation 组合必须提供 sessionProjections 才能激活 Host 插件。"
---
# 为 Conversation 提供 Session 投影

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-conversation` 的 Host 入口需要 `sessionProjections` 服务来发布手动继续资格。挂载 Conversation 却没有投影提供方的自定义组合必须补上提供方。随产品提供的 Web 和 Desktop 组合已经提供它。Session 日志不需要迁移。

## 迁移

1. 检查自定义 profile 的 bundle 和 `cordis.patch.yml` 中是否已有 `@deepseek-ai/dsh-session-projection` entry；存在时保留该提供方。
2. 如果组合中没有该提供方，在 profile 的 `cordis.patch.yml` 中添加以下条目：

   ```yaml
   - id: session-projection
     name: '@deepseek-ai/dsh-session-projection'
   ```

3. 重启 profile 并确认 Conversation Host 入口已激活。支持的模型请求失败后，空草稿且空闲的普通 composer 应提供播放按钮。

支持的失败类型和提交行为见 [Conversation 参考](../../../../packages/client/ui-conversation/README.zh.md#shell-and-standard-props)。
