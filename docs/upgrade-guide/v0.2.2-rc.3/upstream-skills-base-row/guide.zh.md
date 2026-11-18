---
kind: upgrade-guide
description: "基础 profile bundle 新增 `upstream-skills` 行；禁用了 `skill` 行的组合中，该行保持等待状态，启动时多出一条警告。"
---

# 上游技能基础行

[English](guide.md) | 中文

## 变更

基础 profile bundle 新增 `upstream-skills` 行（`@deepseek-ai/dsh-upstream-skills`），它是注入 `skills` 的 Host 服务。保留 `skill` 行的组合不受影响。禁用了 `skill` 行、又没有禁用 `upstream-skills` 的 `cordis.yml`、patch 或 overlay 会让新行一直处于等待状态，每次启动在 stderr 多输出两行：

```text
dsh: warning: 1 entry did not activate
upstream-skills (@deepseek-ai/dsh-upstream-skills): pending (waiting for service: skills)
```

原本已经报告未激活条目的组合，条目数加一，并把这一行与其他条目一起列出。

## 迁移

1. 在每个禁用了 `skill` 行的 `cordis.yml`、patch 或 overlay 中，紧挨着它禁用新行：

   ```yaml
   - id: upstream-skills
     name: '@deepseek-ai/dsh-upstream-skills'
     disabled: true
   ```

2. 启动该 profile，确认 stderr 不再出现 `upstream-skills`。
