# Agent Note: 在持久化 Linux 运行器上执行受信任的发布演练

Status: implemented

[English](2026-09-06-release-rehearsal-selfhosted.md) | 中文

## Problem

依赖布局检查和发布打包演练消耗托管 Linux 分钟，但不需要 npm 或 API 凭据。将任意拉取请求代码或携带凭据的发布任务放到持久化共享主机会削弱隔离；复用未经清理的检出目录也会削弱打包载荷验证。

## Decision

[release.yml](../../../../.github/workflows/release.yml) 的两个作业和 [release-vendor.yml](../../../../.github/workflows/release-vendor.yml) 的打包作业仅在写权限维护者控制的仓库变量 `DSH_CI_FAILOVER_LINUX` 设为 `selfhosted` 时选择现有 Linux 自托管池。选择器要求当前仓库为正式仓库且触发者不是 Dependabot，然后只接纳 master 推送，或作者不是 Dependabot 的同仓库、非 fork PR（Pull Request）。手动触发始终选择 `ubuntu-24.04`，其他不满足条件的上下文也一样。[故障切换手册](2026-07-26-ci-failover-runbook.zh.md) 负责按平台划分的开关与热备操作。发布演练有意与主 CI 共用 Linux 开关：启用或禁用会同时路由两类负载，不能独立切换发布演练。未设置时仍默认使用托管池；只有运维人员选择 `selfhosted` 期间才节省托管分钟，无论该选择用于故障恢复还是持续的成本控制。

运行器标签为 `[self-hosted, linux, x64, vm-backup]`。运行器注册共享一台虚拟机，不代表独立机器容量。每个作业在 pnpm 设置前将 Node 编译缓存与 node-gyp 头文件放在运行器私有临时卷上，pnpm 设置目标路径包含运行、重试次数和作业标识。`TMPDIR` 也指向 `runner.temp`，因此临时 npm 消费目录既在检出目录之外，也在运行器清理范围之内，即使进程被强杀而无法执行 `finally` 也一样。持久化 pnpm 存储位于检出清理范围之外；只有 GitHub 托管运行器恢复远端存储缓存。两个演练工作流都不保存远端缓存。

检出操作显式清理被忽略和未跟踪的输出，再执行锁定依赖安装与现有构建。完整标签历史、打包并发、依赖检查、压缩包验证和产物保留期均保持不变。打包安装验证器在检出目录外创建全新的消费目录，用 npm 安装压缩包，移除继承的 Node 解析钩子，并在 `finally` 中删除消费目录；预热 pnpm 存储无法用工作区链接或过期构建输出代替压缩包载荷。[npm 发布决策](2026-08-10-npm-release-sequences.zh.md) 仍负责发布族与发布操作。两个手动发布工作流全部保留在托管运行器上，本改动不增加凭据，也不改变注册表。

## Alternatives considered

始终使用托管演练可以避免持久化主机风险，但会保留全部托管分钟。始终自托管则失去可移植回退。增加调度作业或可复用工作流会多出一个逻辑作业，并隐藏三个简短的设置序列。允许任意引用的手动触发，会让维护者操作获得比明确事件信任规则更广的持久化主机访问权限。

## Consequences

取消变量或将其改为非 `selfhosted` 值，会将后续符合条件的作业路由到托管 Ubuntu。这是运维人员选择的回退，不会自动探测运行器健康，也不会切换已排队的作业。共享虚拟机仍可能与其他受信任作业竞争资源；仓库写权限维护者仍对进入持久化信任域的代码负责。工作流不安装主机系统包，也不修改全局主机配置。

[scripts/tests/ci-release-selfhosted.spec.ts](../../../../scripts/tests/ci-release-selfhosted.spec.ts) 使用受信任事件和 fork、Dependabot、其他仓库、非 master 推送、手动触发、缺失 PR 数据、禁用开关等负向对照求值已提交的选择器。测试固定设置顺序、检出清理、仅托管运行器访问远端缓存、发布隔离和保留命令。真实发布构建与打包安装执行仍由 PR CI 验证；选择器测试不声称重现这些构建。
