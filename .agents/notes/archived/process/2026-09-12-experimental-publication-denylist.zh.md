# Agent Note: 默认发布实验性包并保留显式私有例外

Status: implemented
Archived: 2026-09-30

[English](2026-09-12-experimental-publication-denylist.md) | 中文

## 问题

公开实验性包的允许列表要求每个新加入仓库的可安装原型都修改一次策略。实验性状态描述兼容性与支持预期，但内部专用原型仍需要显式排除发布。

## 决策

本地 npm baseline 发布器与公开 dsh 发布系列默认发现实验性包。[`PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES`](../../../../scripts/experimental-package-policy.ts) 负责显式私有排除项。拒绝列表为空，因此所有当前实验性包都参与发布。

拒绝列表以外的每个实验性目录默认公开。workspace 约束要求公开包省略 `private` 并设置 `publishConfig.access: public`；所有实验性包保留 `@deepseek-ai/dsh-experimental-*` npm 前缀。添加私有原型需要拒绝列表条目及其私有 manifest（元数据清单）。

本决策取代 [Agent Teams 包决策](../architecture/2026-08-18-experimental-agent-teams-packages.zh.md)中的默认私有发布原则。该决策的依赖隔离、显式启用组合、工程要求与 promotion 规则继续生效。发布不提供稳定性或支持承诺。

## 曾考虑的替代方案

**保留公开允许列表。** 即使默认发布路径能够发现新公开实验性包，每个包仍需要额外的策略条目。

**立即发布所有实验性包。** 这会暴露现有的内部专用原型。显式私有拒绝列表改变新包的默认策略，同时保留这些原型的当前发布状态。[已归档的发布决策](../../archived/process/2026-09-12-publish-all-experimental-packages.md)记录了这些包后来的发布。

## 后果

新实验性包无需修改允许列表即可加入两条 npm 发布路径。私有例外有一个共享 owner，workspace 校验会拒绝与之不符的 manifest。
