---
kind: upgrade-guide
description: "Claude Code 与 Codex bundle 添加全局委派工具，同时保留包名和行标识。"
---

# 原生子代理 bundle 包含全局工具

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-subagent-claude-code` 和 `@deepseek-ai/dsh-subagent-codex` 保留包名、bundle 选择、提供方行 ID、配置及原生认证。已选中的 bundle 现在还会把委派工具注册为 Host 全局工具，包括 minimal 在内的所有预设都可见；此前 bundle 只注册提供方。启用 bundle 后，运行中的 Agent 从下一次请求起即可看到该工具；关闭后则不再可见。

贡献的 Host 行为 `tool-subagent-claude-code` 和 `tool-subagent-codex`。后续用户层可以按行 ID 覆盖其配置或禁用状态。覆盖不会选中未选中的 bundle。预设自行注册的同名工具会为其 Agent 遮蔽该全局工具。

委派遵循共享的托管 activation API：工具返回子级 ID，完成结果通过已记录的通知发送给父 Agent。移除已废弃的 `backgroundMode` 设置；这些原生提供方仍支持 `maxDepth: provider-managed`。

## 迁移

1. 保留已选中的 bundle 名称、提供方配置和认证。已有仅提供方的包需要在插件 → 官方中**更新**才能获得贡献工具的 bundle；按提示重启。要使用新的提供方，启用其卡片。[安装目标](../../../../packages/boot/plugin-manager/README.zh.md#use-this-package)对应已发布的 DSH 版本或源码 checkout；版本字符串相同不代表旧注册表包等同于开发链接。关闭只取消选择；删除仍为独立操作。
2. 使用普通行补丁配置该工具。配置覆盖仍会替换整份配置。例如，以下补丁在保留提供方注册的同时禁用 Codex 工具：

   ```yaml
   - id: tool-subagent-codex
     disabled: true
   ```

3. 如果手动的 Host 行注册了同名工具，移除该重复行，或禁用 bundle 的贡献行。在 Session 中验证有效工具目录。
4. 插件客户端收到必填的 `BundleInfo.official` 和 `BundleInfo.availability` 字段；详情 slot 的 `PluginPackageRef` 也会收到它们。`official` 标识项目维护，`availability` 表示 `installation`、`profile` 或 `missing`，`installed` 仍表示 profile 的依赖声明。只展示已有字段的详情 slot 读取方无需修改；构造方和精确校验器必须包含新增字段。可选的 `installTarget` 标识所提供的版本及注册表或本地链接 spec。

**其他 profile。** 这些 bundle 层只插入 Host 行，因此 headless、SDK、ACP 和自定义 profile 也可以选择它们。保留提供方包而不选择其 bundle 的 profile，可以参考 [Codex](../../../../packages/subagent/subagent-codex/README.zh.md#exposing-the-tool) 或 [Claude Code](../../../../packages/subagent/subagent-claude-code/README.zh.md#exposing-the-tool) 示例组合相同的行。
