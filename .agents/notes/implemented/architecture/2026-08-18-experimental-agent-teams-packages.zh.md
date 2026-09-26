# Agent Note: 以实验性包名发布 Agent Teams

Status: implemented

[English](2026-08-18-experimental-agent-teams-packages.md) | 中文

## 问题

Agent Teams 的服务与工具约定仍在变化，但它需要使用真实 Session 日志、subagent 生命周期、工具、示例、快照和仓库检查。用户还需要直接从 npm 安装完整 Team 组合，而无需构建源码 checkout。

把这些包移入产品职责组会移除实验性名称，并暗示稳定包 owner 已经就位。发布 `packages/experimental/` 下的所有包又会暴露无关的内部原型。发布策略必须让用户安装 Agent Teams，同时让内部专用原型保持私有。

## 决策

`packages/experimental/agent-team`、`packages/experimental/tool-agent-team`、`packages/experimental/agent-team-profile` 与 `packages/experimental/client-ui-agent-team` 是公开 workspace 包。它们保留现有 `@deepseek-ai/dsh-experimental-*` 名称并加入 dsh 发布系列。[发布拒绝列表决策](../process/2026-09-12-experimental-publication-denylist.zh.md)负责默认公开与私有例外；[实验性包规则](../../../../packages/experimental/AGENTS.md)负责依赖隔离与后续 promotion。

dsh 打包与发布集合以及本地基线发布器包含这四个 Agent Teams 目录和 [Cua Driver 提供方](2026-09-12-computer-use-provider-registration.zh.md)。workspace 约束要求它们省略 `private`、将 `publishConfig.access` 设为 `public`，并保留实验性 npm 前缀。实验组之外的发布包、应用和 Python 运行时不能在 `dependencies`、`optionalDependencies` 或 `peerDependencies` 中引用实验包；实验包可以依赖发布包和彼此。

通用的调用方预留 continuable child 身份和精确 direct-child drain 仍属于稳定 Subagent 服务。它们负责 Subagent 身份与 Activation 生命周期，不 import 或命名 Agent Teams；实验性 Team 服务沿允许的方向消费这些能力。

[单组合包决策](2026-09-18-agent-teams-single-bundle.zh.md)取代了独立 Host 与 Web 组合包的组合方式。本记录保留发布、依赖隔离与 promotion 的理由。当前 Team profile 仍须显式启用，并禁用模型可见名称与 Team 工具重叠的全局 continuable-child control；[可选组合包决策](../process/2026-09-15-shipped-optional-bundles.zh.md)负责其随安装交付的规则。

profile 启动会先解析所选 bundle，再计算[不可变 runtime resolution](2026-09-09-profile-resolution-generations.zh.md)。runtime resolution 保留安装优先顺序，按 profile 顺序完整遍历每个显式 bundle 根，并让 pnpm 管理的 profile 包保持优先。运行时拦截在内存中强制该结果，不物化 fallback 链接。因此，私有 profile 层可以携带实验性 plugin 配置行，而无需把这些 plugin 加入发布 app、要求 profile 用户直接安装传递依赖、破坏 packaged-runtime 的模块身份，或改变其他 profile 的解析结果。

对这四个包而言，实验性状态改变兼容性与支持预期，而不阻止发布。这些包仍须满足仓库的一般文档、不变式、生命周期、安全、单元测试、真实组合测试和快照要求。promotion 前仍须评审公开约定、限制、测试证据、运行时依赖方，并由一名具名 owner 接受稳定包义务。

## 曾考虑的替代方案

**把 Agent Teams 移入产品职责组。** 这会移除要求保留的实验性 npm 名称，并在约定稳定前暗示已有稳定包 owner。

**让 Agent Teams 保持私有且仅供源码 checkout 使用。** 这会保留最简单的实验性策略，但用户无法从 npm 安装完整 opt-in 组合。

**发布所有实验性包。** 其他原型仍只供内部使用，也没有接受公开包约定。

**把 Subagent 前置能力移入 experimental 目录。** child 身份分配与 Activation teardown 属于 Subagent owner，且不包含 Team 专用约定。移动或复制这些能力会反转依赖方向，或把同一个生命周期拆到多个包中。

## 后果

Agent Teams 会作为 dsh 发布系列中的四个可安装 tarball 发布，同时保持包名不变，也不会在随附 profile 中启用 Team。公开可用不代表这些包稳定或默认受支持，稳定发布包也不能对其建立运行时依赖。

发布系列保留实验性 npm 名称。promotion 仍会按照实验性包规则产生路径和 npm 名改动。
