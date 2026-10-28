---
kind: upgrade-guide
description: "禁用命令行提供方的 Headless 组合必须直接提供沙箱策略配置。"
---

# 替换 headless startup 时配置策略

[English](guide.md) | 中文

## 变更

headless 组合包在激活沙箱策略前，通过 `headlessStartup` 读取 `--add-dir`。禁用 `headless-startup` 的 overlay 也必须从 `sandbox-policy` 移除该依赖，否则策略及其依赖工具会保持 pending 状态。普通 `dsh headless` 调用无需修改配置。

## 迁移

1. 在禁用 `headless-startup` 的 overlay 中直接提供策略。在此替换配置中保留已有策略设置：

   ```yaml
   - id: sandbox-policy
     inject: []
     config:
       mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
       workspaceRoot: !!js process.cwd()
   ```

2. 如果 overlay 保留命令行 startup，但替换了 `headless-runner` 或 `sandbox-policy`，请保留 [headless 组合包](../../../../packages/bundle/headless/cordis.patch.yml)中的 `headlessStartup` 绑定。
3. 通过自定义配置档运行一个小任务并确认工具已激活。如果保留 startup，请传入 `--add-dir`，并检查对所选目录的写入是否成功。
