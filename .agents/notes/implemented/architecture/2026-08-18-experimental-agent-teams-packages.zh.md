# Agent Note: 将 Agent Teams 作为私有实验性包孵化

Status: implemented

[English](2026-08-18-experimental-agent-teams-packages.md) | 中文

## 问题

Agent Teams 的服务与工具约定仍在变化，但它需要使用真实 Session 日志、subagent 生命周期、工具、示例、快照和仓库检查。把这些包放在产品职责组会使其成为 dsh 发布系列成员，并获得与稳定包相同的发布预期。

没有实际包的 experimental 目录曾经让没有消费方的放置、依赖、promotion 和发布规则长期存在。Agent Teams 提供了具体消费方，但该目录需要机械强制的发布排除与依赖隔离，不能只用文档标记状态。

## 决策

`packages/experimental/agent-team`、`packages/experimental/tool-agent-team`、`packages/experimental/agent-team-profile`、`packages/experimental/client-ui-agent-team` 与 `packages/experimental/agent-team-web-profile` 是私有 workspace 包。[实验性包规则](../../../../packages/experimental/AGENTS.md)负责其 npm 名和 promotion 重命名；本记录负责其目录归属、发布排除与依赖隔离。

dsh pack 与 publish 集合以及本地 baseline 发布器均排除 `packages/experimental/` 下的所有 manifest。`release:dsh` 仍会让这些 manifest 跟随 dsh 共享版本递增，但不会创建发布 tag。workspace 约束要求每个实验性包设置 `private: true` 并省略 `publishConfig`。同一个顶层检查会拒绝发布包、发布 app 或 Python runtime 通过 `dependencies`、`optionalDependencies` 或 `peerDependencies` 依赖实验性包。实验性包可以依赖发布包和其他实验性包；测试可以通过 `devDependencies` 使用它们，示例可以显式加载它们。

通用的调用方预留 continuable child 身份和精确 direct-child drain 仍属于稳定 Subagent 服务。它们负责 Subagent 身份与 Activation 生命周期，不 import 或命名 Agent Teams；实验性 Team 服务沿允许的方向消费这些能力。

私有 Host 侧 Agent Teams profile bundle 依赖 Team 包，并在 `dsh-base` 之后应用。它会插入 Team 配置行，并禁用模型可见名称与 Team 工具重叠的全局 continuable-child control。独立的私有 Web profile 在 `dsh-web-app` 与 Host profile 之后应用；它会插入 Team UI，后者挂载 Team package 生成的 Remote contribution。两个层都保持已发布 base、CLI、Web 与 Python runtime 的依赖图不变。

profile 启动会先解析所选 bundle，再修复模块 fallback。共享 fallback 保留 dsh 安装的载体专用条目：普通 Node 下使用 symlink，打包 executable 中使用 ESM proxy。仅由所选 bundle 闭包携带的缺失包会链接到当前 profile 自己的 `node_modules` 下，而 pnpm 管理的 profile 条目仍具有优先权。闭包发现从每个显式外部 bundle 的真实包目录开始；即使前一个依赖具有相同包名，也会遍历所有列出的根。后续发现会排除 dsh 所有的 profile projection，避免投影后的依赖重新进入自己的闭包。link ownership 通过规范化父路径比较，使 junction 规范化后的 target 仍可删除。因此，私有 profile 层可以携带实验性 plugin 配置行，而无需把这些 plugin 加入发布 app、要求 profile 用户直接安装传递依赖、破坏 packaged-runtime 的模块身份，或改变其他 profile 的解析结果。

实验性状态只改变发布与兼容性预期。这些包仍须满足仓库的一般文档、不变式、生命周期、安全、单元测试、真实组合测试和快照要求。promotion 前必须评审公开约定、限制、测试证据、发布 payload、运行时依赖方，并由一名具名 owner 接受稳定包义务。

## 曾考虑的替代方案

**把 Agent Teams 留在产品职责组，并标为显式启用。** 显式启用的组合可以控制模型行为，但不会阻止包发布，也不能阻止稳定包对其建立运行时依赖。

**预留空的 experimental 组。** 没有实际包的目录没有 owner，也没有可供测试的发布机制。只有具体包需要这套强制处理时，该组才存在。

**把 Subagent 前置能力移入 experimental 目录。** child 身份分配与 Activation teardown 属于 Subagent owner，且不包含 Team 专用约定。移动或复制这些能力会反转依赖方向，或把同一个生命周期拆到多个包中。

## 后果

Agent Teams 可以使用完整仓库依赖图与质量检查，而不进入正式 tarball，也不会成为受支持的运行时依赖。在 Team 包 promotion 前，发布包不能暴露 Team，因此 CLI 实验会安装显式的私有 profile 层，而不是修改已发布 bundle。通用 profile launcher 可以接受该层，而不会让它的 plugin 依赖进入 dsh 发布闭包。

孵化期间的产品职责分组不够直接。promotion 会按照实验性包规则产生路径和 npm 名改动。
