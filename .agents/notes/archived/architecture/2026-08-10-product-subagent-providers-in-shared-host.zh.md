# Agent Note: 产品 subagent 提供方位于共享 profile 宿主

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-product-subagent-providers-in-shared-host.md) | 中文

## 问题

[Codex 与 Claude Code 提供方约定](../feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md)最初以可独立安装的包交付，由部署环境在通用 subagent 工具旁加载。Agent Preset 后来成为单个 agent（智能体）的模型可见工具的常规责任方，但 preset 不能安全地拥有这些产品提供方：`ctx.subagents` 是进程级注册表，提供方名称在 Host 内唯一，而宿主消费方会跨会话解析同一个注册表。因此，重复组装 preset 会争用同一组已配置名称。如果要求用户同时编辑 Profile 和 Preset，也会使通用 preset 配置项本身不完整。

归属决策必须同时保留两个彼此独立的事实：加载提供方不得启动产品，也不得对产品执行身份验证；而工具授权仍须按 preset 决定，这样两个会话才能暴露不同的产品。全局产品开关、按 agent 创建提供方实例或预先枚举的组合 preset，都会为其中一个事实另设第二责任方。

## 决策

产品提供方仍是进程级的 host plane（宿主平面）注册。[生产安装排除决策](../simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.zh.md)只取代本说明原先由 base bundle 安装提供方的选择：生产 `dsh-base` 既不依赖也不挂载它们。选择产品集成的 Profile 会安装目标提供方 Bundle；其 patch 挂载默认实例，而 Profile 可以在 host plane 挂载更多命名实例。[命名实例决策](../feature/2026-08-18-product-subagent-named-instances.zh.md)负责每个配置项的注册身份：两个产品都接受多个唯一的 `providerName`，同时保留 `codex` 与 `claude-code` 作为默认值。加载任一插件只会注册一个休眠后端；对应的 Codex 或 Claude 进程直到第一次实际委派调用时才启动。Agent Preset 通过普通 `dsh-tool-subagent` 配置项的 `provider` 与 `toolName` 准确公开单个 agent 所需的已配置实例，而无需更改 Host 注册表。

每个提供方包都拥有可直接安装的 Bundle patch 与私有产品运行时。本说明继续负责每个已安装提供方的进程级 Host 放置。提供方约定说明继续负责每个产品的协议、结果映射、取消、进程树生命周期与证据层级。[命名实例决策](../feature/2026-08-18-product-subagent-named-instances.zh.md)负责两个可选产品模型及其他逐实例配置。[Agent Preset 架构](2026-08-03-per-session-agent-presets.zh.md)继续负责宿主与 agent 的划分、preset 创作，以及改动只影响新组装会话的规则。

每个 Bundle 都把可执行文件选择交给包自有的产品运行时：Codex 包运行自身声明的 wrapper，Claude Code 包则让锁定的 Agent SDK 选择私有原生可执行文件。两个提供方都不会查询或回退宿主产品命令。加载 Profile 不会创建产品状态、探测版本或测试身份验证；它可以提供每个已挂载 Provider 实例的部署配置，包括可选的不透明模型，以及由[非交互权限决策](../feature/2026-08-15-product-subagent-noninteractive-permissions.zh.md)负责的产品专属 `permissionMode` 值，但不会把这些选择移入 Agent Preset 或面向模型的工具。平台载荷缺失和产品故障仍局限于发生问题的那次委派。

## 验证

base bundle 测试证明生产 `dsh-base` 既不包含产品提供方依赖，也不包含提供方配置项。Web 组装会安装两个可选 Bundle，并覆盖不暴露任何工具、仅暴露 Codex、仅暴露 Claude 和同时暴露两者这四种工具集合，也覆盖自行创作的 preset 发生改动后的代际隔离。由包负责的 Loader 组装证明每个 Bundle 默认实例与额外命名实例都会完成注册，而不会启动产品进程。无密钥 ACP（Agent Client Protocol）快照固定 Codex 双工具集合与最终四工具组合，提供方测试则另行证明私有平台载荷选择与无宿主回退、配置隔离、失败、取消和进程树完全停稳。

## 考虑过的替代方案

**将产品提供方保留为 Profile 层的按需启用项。** 这样可缩小默认依赖闭包，但要求用户同时编辑 Profile 与 Preset。生产安装排除决策接受这项安装取舍；本说明保留的要求是，任何被选中的提供方实例都在 host plane 挂载，而不是放入 preset。

**存储全局或按 Profile 配置的产品启用开关。** 进程级开关会与 Preset 争夺模型可见工具的责任归属，也无法表示两个会话使用不同组合。可用性与身份验证属于部署事实，并非另一份需要持久化的产品状态。

**在每个 Agent Preset 内挂载提供方。** 提供方名称属于进程级注册表，因此重复组装会话会在同一组已配置名称上发生冲突。宿主消费方也需要独立于任何单个 agent 的生命周期使用该注册表。

**交付四个产品组合 preset。** 四个身份会复制完整组装，只为表示两条独立的工具行。普通行已经能表达完整矩阵，无需新增名单或维护状态。

## 后果

用户在 Profile 中安装每个被选中的产品提供方，挂载所需命名实例，再通过与其他插件相同的 Agent Preset 创作路径公开这些实例的工具。每个新会话只会获得其所选 preset 所贡献的工具。没有选择产品提供方的 Profile 不承担对应包或模块的加载开销；加载已选择的实例仍不会启动产品进程、登录、调用模型或创建产品主目录。

Host 注册表仍是提供方的唯一权威，每个 Bundle 仍是部署可用性的权威，每个 Preset 仍是模型工具的权威。这个显式的双门生命周期避免全局启用开关，并让包移除与按会话创作保持独立。
