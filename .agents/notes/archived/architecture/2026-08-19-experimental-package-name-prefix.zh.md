# Agent Note: 在 npm 名中标记实验性包

Status: implemented
Archived: 2026-09-04

[English](2026-08-19-experimental-package-name-prefix.md) | 中文

## 问题

目录归属、私有 manifest 与发布系列过滤可以阻止实验性包进入发布，但 npm specifier 或 Cordis 配置项无法体现该状态。外观稳定的包名可能被复制到其他组合中，而读者看不出其完整公开约定仍处于实验阶段。

## 决策

`packages/experimental/` 直属的每个包都使用 `@deepseek-ai/dsh-experimental-*` npm 前缀。workspace constraints 门禁会发现这些 manifest，并在现有 `private: true` 与省略 `publishConfig` 要求之外拒绝缺少该前缀的包。

Agent Teams 使用位于 `packages/experimental/agent-team` 的 `@deepseek-ai/dsh-experimental-agent-team`，以及位于 `packages/experimental/tool-agent-team` 的 `@deepseek-ai/dsh-experimental-tool-agent-team`。包 import、Cordis 配置项、生成目录和仓库元数据直接使用这些名称，不提供兼容别名。

promotion 会把包移至其产品职责组、从 npm 名中移除 `experimental-`，并原子更新全部仓库引用。预发布兼容策略允许该重命名不提供别名包。

## 曾考虑的替代方案

**保留外观稳定的 npm 名，仅通过目录和发布元数据表达实验状态。** 这种方式可以减少 promotion 改动，但 import specifier 与配置项会隐藏包状态，也无法在评审中携带仅存在于仓库内的目录规则。

**使用 experimental 后缀。** 前缀会把所有实验性包归入一个可搜索的 npm 命名空间，并在产品职责之前显示状态；后缀会把该标记分散在各个职责名称之后。

## 后果

实验性 import 与配置项无需查阅仓库布局即可表明其支持状态。顶层 constraints 命令及其聚焦单元测试会阻止新实验性包遗漏该前缀。

promotion 会明确重命名 import、配置、生成引用与元数据。不会有兼容包保留实验名称。
