# Agent Note: 仅 master 执行的平台 CI

Status: implemented

[English](2026-09-06-master-only-platform-ci.md) | 中文

## Problem

macOS Intel、ARM 与 Linux ARM64 上的 Python 运行时构建，以及通过 Wine 执行的 Windows 构建和网站检查，会在每次拉取请求修订时消耗付费托管容量。原生 Linux 与 Windows x64 已提供必需的可执行文件和安装后 wheel 包证据，原生 Windows 检查也会在合并前覆盖构建与进程行为。

## Decision

[CI](../../../../.github/workflows/ci.yml) 要求 Linux x64 与 Windows x64 上的 Python 运行时验证。[CI master](../../../../.github/workflows/ci-master.yml) 仅在 master 推送时通过同一可复用构建器选择 Linux ARM64、macOS ARM64 与 macOS x64。两个调用方均传入 `ci: true` 和显式外部 API 密钥，保留完整的无密钥安装后 wheel 包场景及可信 live 测试的明确失败。Fork 与 Dependabot 拉取请求仍不带密钥；运行器信任与回退选择器保持不变。Python 发布保留全部五个目标。

Wine 作为独立的托管 Ubuntu master 作业运行一次。其现有的按镜像标识的 apt 缓存恢复和保存也负责生成默认分支缓存，因此不需要单独的缓存预热作业。原生 Linux 与 Windows 串行聚合不调用 Wine。Wine 保持托管运行，避免在持久 Linux VM 上执行共享宿主机 apt 事务和共享 Wine prefix 清理。脚本负责临时快照、checkout 内的 Wine prefix 和经过校验和验证的 Windows Node 缓存；环境准备、失败传播及始终执行的清理保持不变。

父工作流与可复用运行时工作流均保留正在执行的 master 推送检查，不被后续 master 推送取消。GitHub 并发机制仍允许替换待执行的运行；手动基准测试可以取消父工作流。master 推送会调度全部三个选定载体，但不保证每个中间提交都得到结果。PR（Pull Request）、手动和发布运行的取消行为保持不变。

本决策部分取代[安装后 wheel 包验证](../testing/2026-08-23-installed-python-wheel-black-box-ci.zh.md)、[原生 Windows CI](2026-08-08-native-windows-pull-request-ci.zh.md)、[串行参考](2026-07-21-serial-cross-platform-ci-reference.zh.md)和[故障切换手册](2026-07-26-ci-failover-runbook.zh.md)中的调度策略。这些记录仍保留产物来源、平台保真度、串行完整性与信任规则的决策价值。

## Alternatives considered

**在拉取请求上保留全部目标和 Wine 必需检查。** 这能在合并前发现平台特定缺陷，但会在每次修订时重复付费原生构建。所选策略明确接受这四项检查在合并后发现问题。

**等到发布或要求手动派发。** 这会失去自动的默认分支信号。master 推送保留定期触发的检查，不缩减发布矩阵。

**把 Wine 合入自托管串行聚合。** 聚合并未覆盖 Wine。加入它会改变持久宿主机依赖、共享缓存归属与清理隔离；此次调度优化不需要这种迁移。

## Consequences

macOS、Linux ARM64 或 Wine 特定回归可能在必需 PR 检查为绿时合并。master 失败仍是普通失败作业，不是 `continue-on-error` 观测项。Linux/Windows x64 安装后 wheel 包检查及原生 Windows 构建和进程检查继续阻塞 PR 聚合；其依赖绝不引用已移除的 Wine PR 作业。

[路由回归测试](../../../../scripts/tests/ci-master-platforms.spec.ts) 通过现有脚本 spec 覆盖率清单运行，检查目标划分、仅 master 条件、凭据传递、取消、Wine 唯一性、聚合依赖有效性及完整发布矩阵。已执行的负对照移除 Intel 目标、错误路由 Wine 并恢复失效聚合依赖；每项均产生预期失败。真实平台执行仍由 CI 负责；本地调度测试不声称执行了原生运行时或 Wine。
