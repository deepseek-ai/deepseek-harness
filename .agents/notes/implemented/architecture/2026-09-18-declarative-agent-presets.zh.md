# Agent Note: 声明式 Agent preset 与保留代际

Status: implemented

[English](2026-09-18-declarative-agent-presets.md) | 中文

## Problem

Preset 目录重复承担 Cordis 配置的所有权。独立的发现、元数据、复制和编辑 API 无法通过普通 profile 补丁表达相同组装。保存时释放定义，也必须保留运行中 Agent 仍在使用的插件。

## Decision

`dsh-agent-preset-registry` 负责选择与运行时代际；`dsh-agent-preset` 在普通 Cordis YAML 中声明标识、显示元数据和子插件列表。定义提前激活。激活失败保留在列表中，并拒绝新绑定，但不阻止应用启动。

注册表拥有各代际的 scope 与 Loader 树。Agent 将自身 scope 链接到选定代际，子 Agent 继承父方的确切代际。更新使旧代际退役；Agent 和临时历史读取者保留引用，直至释放。最后一个引用释放后，退役树被销毁。Host 注册表和 Agent loop 保持共享；preset 的服务提供方与消费者需要处于隔离 realm 中。

Web 编辑器与 `agent_preset` 工具只接受子插件 YAML。保存写入当前 profile 的用户补丁，保留显示元数据和无关配置。版本检查和 profile 锁防止覆盖并发保存；验证拒绝会使编辑失效的更高优先级覆盖。持久化与激活结果分别报告。配置在 Host 中执行，因此工具写入需要批准或完全访问权限。

会话数据继续记录 preset 标识。重启时根据当前配置解析该标识，定义缺失则拒绝恢复。旧的可执行代际仅保留在进程内，不会序列化。保存的用户默认值与空白会话选择保持不变：未指定 preset 的新会话解析 `selectedDefault`，客户端的开发者工具偏好只决定是否展示这项选择。

## Alternatives considered

**同时保留目录 preset 与声明。** 两个可写来源会争用标识，需要额外的优先级、迁移和编辑规则。普通 profile 配置已提供所需持久化和分层，因此 preset 不再有独立路径。

**让声明插件拥有运行中的子树。** 编辑时 Loader 释放插件会撤销运行中 Agent 的工具。注册表所有权使保留代际具有独立于声明的明确生命周期。

**首次选择时才加载。** 延迟激活推迟诊断，并增加首次使用的等待状态。提前激活适用于这些组装，且可在选择前暴露失败。

**Preset 损坏就拒绝应用启动。** 可选能力集失败后应仍能在 Web 中修复。健康定义和 Host 服务保持可用。

## Consequences

同一进程可以运行能力不同的 Agent，同时共享各选定代际。退役代际在仍有引用时占用内存。Preset 不提供安全沙箱，用户覆盖会替换整个子插件列表，不会合并后续内置变更。

原有目录与逐会话挂载决策保留为[历史背景](../../archived/architecture/2026-08-03-per-session-agent-presets.md)。Host 服务所有权继续由 [Host 平面说明](2026-08-10-host-plane-ownership-after-presets.zh.md)记录。

## Testing

注册表测试覆盖父子 scope 保留、历史读取租约、选择日志及激活失败。编辑器测试使用真实 profile 补丁，检查冲突拒绝并保留嵌套表达式。随附 Web 组装测试通过构建产物验证激活、作用域工具、Creator 技能和 profile 编辑。
