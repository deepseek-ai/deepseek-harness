# Agent Note: Require product use or an explicit package classification

Status: implemented

[English](2026-10-05-product-package-classification.md) | 中文

## 问题

安装依赖可能长期处于休眠状态。出现在依赖图中，并不表明随附 profile、运行时导入或可选能力使用了它。反过来，嵌入式 SDK 或需要部署配置的提供方即使不出现在默认 GUI 中，也可以承担维护中的产品职责。

## 决策

非实验包必须具有有效产品用途，或在[包策略](../../../../scripts/product-package-policy.ts)中显式列出。策略区分可选集成、SDK、构建工具、测试工具、Web 分发包和纯声明基础设施，每个例外记录其维护职责。[实验性状态](../../../../packages/experimental/README.zh.md#status)描述成熟度与支持承诺，独立于安装、可选启用与官方发现。

[产品用途检查](../../../../scripts/verify-product-use.ts)跟踪有效的随附 profile、预设子行、运行时源码导入与显式动态挂载。检查在组与 Include 中保留禁用状态，并先应用 patch 再统计用途。Manifest 依赖和纯类型引用不产生运行时用途。可选组合包的可达关系与默认可达关系分别计算。未知包及无效或过时的策略条目会使静态 CI 和包卫生检查失败。

[默认产品隔离规则](2026-09-12-default-product-experimental-isolation.zh.md)保持独立：其保守的安装与声明遍历即使对已禁用行，也会拒绝意外实验依赖。该遍历不能证明活动产品用途。

## 考虑过的替代方案

**将所有已安装包视为已使用。** 冗余依赖本身就能满足分类要求，从而掩盖休眠代码。

**将所有非默认能力归为实验性。** 部署前提与安装成本不能证明不成熟；受支持的可选提供方与 SDK 需要独立分类。

**统计所有声明的 patch 行。** 禁用的 Include、缺失目标或后续替换都可能阻止该行挂载。只有有效组合才能证明用途。

## 影响

新增非实验包需要产品消费者或经过审查的分类。改名和减少随附可用性需要升级说明，已记录事件和已发布数据继续遵守既有义务。回归 fixture 拒绝只有 manifest 依赖、禁用子树、无效 patch 和过时分类的情况。SDK、测试、构建与声明包仍可独立安装，无需新增运行时挂载。
