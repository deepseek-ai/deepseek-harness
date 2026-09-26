# Agent Note: Blacksmith 作为 CI 池的故障切换支路

Status: implemented

[English](2026-09-09-blacksmith-failover-leg.md) | 中文

## 问题

[故障切换手册](2026-07-26-ci-failover-runbook.zh.md)把降级的企业池流量路由到自有的 `vm-backup` 与 `dsh-win-ci` 池——它们是经过验证但容量有界的备用池。Blacksmith 按需出售类似 GitHub 托管的运行器，其迁移向导提议整体替换仓库的 `runs-on` 标签，这会把持有凭据、基准与 spec 钉死的作业默认放到第三方基础设施上。整体替换不适合作为默认：它会打破 workflow 契约 spec、扭曲基准与性能预算测量，并在没有决策记录的情况下搬动信任边界作业。

## 决策

`DSH_CI_FAILOVER_LINUX` 与 `DSH_CI_FAILOVER_WINDOWS` 额外接受值 `blacksmith`。任何仓库写者设置它时，该平台参与切换的作业按各作业配置的 vCPU 档位重定向到 Blacksmith 托管运行器；任何其它值（或未设置）保持今天的运行器，`selfhosted` 继续路由到自有池。与既有取值一样，这是写者可管理的仓库状态——无需合并，重跑受影响的作业即可——并且只在设置期间产生费用，这正是它作为明确的故障或实验选择、而非默认的原因。

`blacksmith` 下参与切换的作业：[ci.yml](../../../../.github/workflows/ci.yml) 中三个企业级 Linux 工作作业、`node-compat` 各腿、`all-checks-passed` 判定作业与三个 Windows 作业，使用该工作流为各作业声明的运行器规格；`expected-filenames`；sandbox 的 bwrap 腿；以及两个手动基准矩阵——其 4-32 vCPU 档位映射到 Blacksmith 等价档，64/96 核行保留自有池标签，因为 Blacksmith 没有对应档位。blacksmith 分支不带 Dependabot 排除：Blacksmith 运行器是临时的，因此把 Dependabot 留在托管池的持久虚拟机理由不适用。python-runtime 构建器整体保持托管：其 PR 与 master 调用方（`ci.yml` 与 `ci-master.yml` 的 `python-runtime` 作业）会把真实 API 凭据（`DEEPSEEK_API_KEY_EXTERNAL`）传入该可复用工作流，其 macOS 与 arm64 单文件分支需要 GitHub 镜像，且其 wheel 产物供给 PyPI 发布链。docs-pages 工作流是 tag 派发的发布，因此同样保持托管。

其余作业在任何取值下都保留自己的运行器：被 workflow spec 钉死在标准托管运行器上的作业（`node-24-bench`、`python-sdk`、master 的 Wine 门禁、`release-publish` 与 `release-vendor-publish`、Cloudflare preview、weighted-approval 一对）；持有凭据的作业（真实 API 的 e2e 通道、issue App token 作业、npm 与 PyPI 发布作业）；需要 Blacksmith 缺失的宿主能力的作业（Landlock 各腿及其打包校验、Seatbelt 腿、linux-arm64 单文件分支）；以及发布形态的链——npm 发布、PyPI 发布、node-addon-system 发布链与 Pages 部署工作流——它们整体保持托管，因为其产物供给已发布的 registry 输出。`release.yml` 与 `release-vendor.yml` 中的发布演练作业（`dependencies`、`pack`）保持改动前既有的路由不变：它们只带既有的 `selfhosted` 分支，因此在 `blacksmith` 取值下与变量未设置时一样回落到托管的 `ubuntu-24.04` 默认，并不新增 `blacksmith` 分支。

## 备选方案

整体采纳迁移向导。否决，因为它打破 workflow 契约 spec、改变基准语义与性能预算校准，并默认把持有凭据与信任边界的作业搬到第三方基础设施；更早的向导迁移（已关闭的 PR #3053）因成本与同样的 review 结论被否决。

只把自有池作为唯一故障切换目标。作为唯一选项被否决，因为它是容量有界的备用；Blacksmith 为「故障对象正是自有池本身」的故障与实验场景提供弹性容量。

## 后果

blacksmith 各腿在有人设置该值前保持休眠，因此只在真实故障切换或明确实验期间被使用。镜像试运行（PR #3841，已关闭）把参与集硬编码到 Blacksmith 标签上跑过，确认 `blacksmith-4vcpu-ubuntu-2404`、`blacksmith-16vcpu-ubuntu-2404` 与 `blacksmith-16vcpu-windows-2025` 可调度可执行。Blacksmith 将其运行器注册为 self-hosted，因此在 `blacksmith` 取值下 `node-compat` 各腿会真实执行 toolcache 隔离与隔离安装校验步骤（以 `runner.environment == 'self-hosted'` 为条件），而非全部跳过；三条腿都在试运行镜像上通过（run 34322356689）。同一试运行还暴露了一个由本改动修复的环境发现：在 `**` 展开中遇到 symlink 文件时，node 24.13 的内部 `fs.glob` 会 lstat-probe `<matched>/<下一段>` 并抛 ENOTDIR 而非跳过（run 34319926270），使 `check:ci:static` 内的 `verify-md-wrap` 在 Blacksmith 上失败，直到 [repo-files.ts](../../../../scripts/repo-files.ts) 用 dirent walker 替换 `globSync`；修复后的 static 通道在同一镜像上转绿。触发条件是 probe 已匹配 symlink 之下的路径，而非笼统的「`**` 扫过含 symlink 的树」：同一 run 中其它扫描含 symlink 树的 `globSync` `**` 调用点保持绿色，无需改动。两个基准矩阵的 8 与 32 vCPU 标签（ubuntu-2404 与 windows-2025）不在试运行范围内，是按已实测的 4/16 vCPU 标签命名对称推定的；首次使用前请用一次手动 dispatch 确认。Landlock、Seatbelt 与 linux-arm64 的排除仍基于更早迁移尝试（已关闭的 PR #3053）的散文式 dispatch 实测，此处记录为已知缺口；试运行按设计无法触发这几条腿。workflow spec 钉住了新分支——`ci-workflow.spec.ts` 断言扩展后的 selector 中出现 Blacksmith 标签，`ci-compatible-selfhosted.spec.ts` 求值 `blacksmith` 路由模式——因此未来重写 selector 会使单元门禁变红。默认成本姿态不变：除非变量指明，否则没有任何东西跑在 Blacksmith 上。
