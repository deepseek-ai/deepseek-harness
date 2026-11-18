---
kind: upgrade-guide
description: "自动模型切换要求有效的目标压力预算与成功的压缩。"
---

# 模型切换检查目标上下文压力

[English](guide.md) | 中文

## 变更

启用 `compaction-basic` 自动模式时，提供方／模型切换会在记录新请求 header 前检查目标压力。此前，主动压力检查使用上次已提交路由，并对配置或摘要失败记录警告。现在，无法解析目标容量、压力预算无效或压缩无法将历史降至阈值以下时，切换会以 `MODEL_SWITCH_COMPACTION_FAILED` 失败。这也影响目标预算无效的短会话。已完成的剪枝与之前的检查点仍保留；先前请求 header 也保持不变。

## 迁移

1. 确保每个可选路由都有已注册的适配器，且其 `resolveModelInfo()` 声明了 `context.contextWindow`。对于缺少此元数据的中间件路由，通过适配器暴露容量，或设置 `auto: false` 仅使用手动压缩；这也会关闭自动压力压缩与溢出恢复。

2. 对于小窗口，在 `cordis.yml` 的精确提供方／模型策略下配置 `headroomTokens`。默认值为 65,536 token，必须与路由请求的输出预留共同适配窗口。对于 65,536 token 窗口与 4,096 token 的请求输出上限，下列策略会留下正数压力预算：

   ```yaml
   - name: '@deepseek-ai/dsh-compaction-basic'
     config:
       modelPolicies:
         - provider: local
           model: small-context
           headroomTokens: 4096
           maxTokens: 4096
   ```

3. 将 `local` 与 `small-context` 替换为已注册路由。策略的 `maxTokens` 限制摘要输出；目标请求自身的输出上限单独设置。解析后的保留预算必须低于触发阈值。先用短历史切换一次以验证配置，再用长历史验证压缩。切换失败时，修正所报原因后重试，或选择更大的模型。详见[包配置参考](../../../../packages/compaction/compaction-basic/README.zh.md#use-this-package)。
