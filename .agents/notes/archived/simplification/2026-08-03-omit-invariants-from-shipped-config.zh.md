# Agent Note: 从交付的 dsh 配置中省略运行时不变式

Status: implemented
Archived: 2026-09-04

[English](2026-08-03-omit-invariants-from-shipped-config.md) | 中文

## 问题

`@deepseek-ai/dsh-invariants` 与各包拥有的 `./invariant` 伴随插件是可选的开发诊断。交付的 TUI 挂载了该服务和四个有状态伴随插件，而交付的 Web 配置树省略了这些条目，导致两个产品 surface 的诊断成本和失败行为不同。即使始终启用的产品边界仍负责会话验证与不可变历史，关系断言失败也可能终止普通的 TUI 运行。

## 决策

`apps/cli/config/` 下交付的 `dsh` 配置树既不挂载 `@deepseek-ai/dsh-invariants`，也不挂载任何包拥有的 `./invariant` 伴随插件。因此，CLI 包不再直接依赖不变式服务。

不变式支持仍可供聚焦测试、示例组合包、生成的 SDK 组合，以及显式选择诊断的自定义部署使用。会话验证、快照、冻结和来源事件引用验证始终启用，且不依赖可选服务，具体由[源端拥有的不可变性决策](../architecture/2026-06-11-dev-invariants-over-deep-readonly.zh.md)规定。

构建后 CLI 的配置转储测试会检查两个交付的 surface，并拒绝服务条目或任何 `@deepseek-ai/dsh-*/invariant` 条目。

## 已考虑的替代方案

- **挂载服务并设置 `enabled: false`。** 不予采纳，因为交付的配置树和 CLI 依赖仍会携带不安装任何检查的诊断。
- **保留仅由 TUI 挂载的方案。** 不予采纳，因为两个交付的 surface 仍会保留不同的诊断和失败行为。
- **从仓库中移除不变式支持。** 不予采纳，因为包拥有的检查在测试、示例、生成的 SDK 及显式开发组合中仍然有用；只有默认产品配置不在其范围内。

## 后果

- 普通的 `dsh` TUI 与 Web 运行不安装不变式监听器或 trace 状态，也不会因 `InvariantError` 失败。
- 开发和自定义组合仍可显式使用不变式服务及伴随插件。
- 构建后 CLI 的组合输出会验证两个 surface 的交付配置中均不存在这些条目。
- 始终启用的会话完整性保持不变。
