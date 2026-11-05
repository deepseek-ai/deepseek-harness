# Agent Note: 新实验包命名不使用 experimental 前缀

Status: implemented

[English](2026-11-04-unprefixed-experimental-package-names.md) | 中文

## 问题

名为 `@deepseek-ai/dsh-experimental-<name>` 的实验包迁入产品分组时必须重命名。重命名会改变引用该包名的每个导入、依赖项、模块声明和 profile 文件，因此晋升会附带一次与能力行为无关的迁移。

## 决策

新实验包使用 `@deepseek-ai/dsh-<name>`，不使用 `experimental` 前缀。每个新实验包都在[实验包命名策略](../../../../scripts/experimental-package-policy.ts)的 `EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS` 中声明，因为隔离检查和插件记录归属只通过这个映射识别不带前缀的实验包名。晋升时移动该包并删除其映射条目；其 npm 名称保持不变。

带前缀的既有包列在 `LEGACY_PREFIXED_EXPERIMENTAL_PACKAGE_DIRECTORIES` 中。`pnpm run constraints` 拒绝其他目录中出现该前缀，也拒绝已列出但不再包含带前缀包的目录，因此该清单只能缩减。遗留包在晋升时重命名；提前重命名需要[插件身份决策](2026-10-06-web-desktop-plugin-identity-compatibility.zh.md)要求的发布与迁移依据。

本决策取代插件身份决策记录的暂缓清理，该清理为每个实验包加上前缀。[包规则](../../../../packages/experimental/AGENTS.md)向作者说明命名规则。

## 考虑过的替代方案

**默认保留前缀。** 名称能体现实验状态，但每次晋升都要重命名该包，并迁移其消费方和已安装 profile。

**现在重命名遗留包。** 一次重命名即可删除遗留清单，但会在没有晋升需要的情况下改变既有依赖和 profile 使用的已发布名称。

**只记录规则，不设门禁。** 从遗留包复制的新包会保留前缀，而所有检查仍会通过。

## 后果

不带前缀包名映射随每个新实验包增长；遗留清单只会缩减。识别不带前缀的包是否为实验包依据的是目录位置和该映射，而不是 npm 名称；不带前缀的名称也不因此获准进入默认产品。
