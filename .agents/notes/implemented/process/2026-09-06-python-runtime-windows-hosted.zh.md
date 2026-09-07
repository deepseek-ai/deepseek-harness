# Agent Note: Windows Python runtime CI 保留在 GitHub 托管 Windows 上

Status: implemented

[English](2026-09-06-python-runtime-windows-hosted.md) | 中文

## 问题

当 #3629 加入故障切换选择器与作业私有的 Windows 工具链后，[build-exe-for-python-sdk.yml](../../../../.github/workflows/build-exe-for-python-sdk.yml) 中的 Windows x64 目标开始对受信任的 PR CI 通过 `DSH_CI_FAILOVER_WINDOWS=selfhosted` 解析运行器。共享的 `dsh-win-ci` 池并未让该通道更可靠。2026-09-06（所有时间均为 UTC；每次运行都执行 #3629 迁移工作流的选择器，该选择器自 07:56 合并起生效）：安装后 wheel 冒烟测试在 09:12 于 `dsh-win-ci-16` 上为[PR #3640（`ci/benchmark-standard-runner`）的提交 `ca3ffe95`](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34023970384)通过，随后 10:06 在 `dsh-win-ci-21` 上为[PR #3337（`feat/visualizer-host-plugin`）](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34026500701)失败，10:46 在 `dsh-win-ci-04` 上为[PR #3640 的最终 head `c5ba873f`](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34028339888/job/101473395734)失败——`smoke_sdk_profile_plugin` 打包的 `dsh plugin add` 子进程无输出即退出，而该次运行的 Linux 与 macOS 单元均通过；11:29 的作业重试再次出现相同的无声死亡。迁移提案（[#3629](https://github.com/deepseek-harness/deepseek-harness/pull/3629)）保持 `proposed`，因为其吞吐量与共享负载验收标准从未实测。

## 决策

Windows x64 目标始终使用托管的 `matrix.runner`——PR CI 为 `windows-2025`——配以标准 setup-python 工具链、pnpm 缓存恢复与 pkg 缓存。来自 #3629 的故障切换选择器、作业私有 Python 准备步骤、自托管依赖安装与后置清理、私有准备脚本及路由测试均被移除。`DSH_CI_FAILOVER_WINDOWS=selfhosted` 再次只重定向 [ci.yml](../../../../.github/workflows/ci.yml) 中的原生 Windows 作业；[故障切换手册](2026-07-26-ci-failover-runbook.zh.md)与 [python/development.zh.md](../../../../python/development.zh.md) 描述仅托管的 runtime 构建。迁移中的 UTF-8 模式导出之所以存在，是因为持久主机使用 GBK 默认代码页；托管镜像提供该通道此前运行的区域设置。

## 已考虑的替代方案

**保留故障切换路由。** 不采用：共享池同一天两次复现相同的安装后 wheel 子进程无声死亡，而迁移清单的吞吐量验收仍然悬置；并且把正确性通道路由进故障切换状态，会使其耦合到无关的池故障开关。

**改为修复共享池。** 交由池运维者处理：观测到的失败是无输出即退出的子进程，而非镜像前置条件缺失；同一镜像还服务原生 Windows 故障切换作业。

**在托管镜像上保留作业私有工具链。** 不采用：私有 uv/Python 下载的存在理由是不修改持久共享主机；一次性托管镜像已提供迁移前通道使用的已注册 Python 3.10 工具链。

## 后果

每个符合条件的拉取请求再次为 runtime 构建支付 GitHub 托管 Windows 容量，作业私有准备与清理机制（包括有界文件系统重试）随通道一同移除。交换来的是每次构建运行在带标准工具链与托管缓存的一次性主机上，且 Windows 故障切换开关只覆盖迁移前文档所述的原生 Windows 作业。未来的自托管尝试必须在任何路由变更前，对实际池重新验证吞吐量与失败可复现性，并且必须重建已退役 #3629 提案记录的约束：setup-python 的 Windows 安装器会删除匹配的机器/当前用户安装记录并为所有用户安装（私有工具缓存无法隔离这些注册表状态），每个构建缓存与临时测试根目录必须作业私有并使用复制导入而非共享 store 链接，清理必须在成功、失败与取消路径上以有界 Windows 文件系统重试执行，且只有 Windows x64 目标可移植——Linux 目标的 manylinux 检查需要 Docker。
