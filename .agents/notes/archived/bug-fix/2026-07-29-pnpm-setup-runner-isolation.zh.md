# Agent Note: 按 GitHub Actions runner 隔离 pnpm 设置

Status: implemented
Archived: 2026-09-04

[English](2026-07-29-pnpm-setup-runner-isolation.md) | 中文

## 问题

`pnpm/action-setup@v4` 的安装目标目录默认为 `~/setup-pnpm`，并会在设置期间替换该目录。自托管 CI 故障切换在同一个 VM 用户下运行六个 GitHub Actions runner 服务，因此并发作业会共用同一目标目录。在复现运行中，三个作业在 73 毫秒内进入 pnpm 设置；其中一个设置过程删除了另一个进程的当前工作目录，导致两个作业在 Node 的 `uv_cwd` 初始化阶段失败。换到另一台 runner 重试后通过，说明该故障取决于时序，并非仓库测试回归。

## 决策

[主 CI 工作流](../../../../.github/workflows/ci.yml)与 [CI master 工作流](../../../../.github/workflows/ci-master.yml)中的每个**非 Windows** `pnpm/action-setup` 步骤都设置 `dest: ${{ runner.temp }}/setup-pnpm-${{ github.run_id }}-${{ github.run_attempt }}`。每个 runner 服务独占自己的临时目录，因此一个设置过程无法替换另一个 runner 的安装目录；run/attempt 后缀还能防止同一 runner 上顺序作业因残留的锁定 `pnpm.exe` 而失败。Windows 原生作业与 [python SDK exe 构建](../../../../.github/workflows/build-exe-for-python-sdk.yml)在 `setup-pnpm-js-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}` 下使用独立的 pnpm 可执行文件（非 `standalone: true`，目录本身起分离作用）：run/attempt/job 后缀让每次作业都使用全新目录，即使顺序作业落到同一自托管 runner、且前一作业留下被锁定的 @reflink 原生模块。持久 store 的复用仍由 `PNPM_CONFIG_STORE_DIR` 独立处理，遵循 [pnpm 配置决策](../process/2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.zh.md)。

[工作流回归测试](../../../../scripts/ci-workflow.spec.ts)会找出 `ci.yml`、`ci-master.yml` 与 `build-exe-for-python-sdk.yml` 中的每个 `pnpm/action-setup` 步骤，并拒绝缺少 runner 专属目标目录的步骤。这可确保后续新增的作业也处于同一隔离边界内。

## 曾考虑的替代方案

**串行执行故障切换作业。** 否决：这会牺牲由六个 runner 组成的池所具备的预期并行能力，并把 action 内部的目录冲突变成原本相互独立作业之间的队列等待。

**为每个 runner 服务分配独立的 Unix 用户。** 这同样能够隔离 `HOME`，但会把该不变量转移到外部 VM 配置中，并使刻意共享的持久 pnpm store 的所有权变得复杂。工作流已经获得 runner 专属临时目录。

**重试失败的设置步骤。** 否决：重试只能降低观测到的冲突发生率；另一个并发设置过程仍可能再次删除同一个共享目录。

## 后果

pnpm 可执行文件采用临时安装，并按 runner 隔离；包下载仍使用已配置的持久或缓存 store。托管作业使用相同的显式目标目录，不改变缓存政策。工作流中的每个设置步骤因此增加三行配置；只有在 pnpm 配置有意改用另一种隔离机制时，才需要更新回归测试。
