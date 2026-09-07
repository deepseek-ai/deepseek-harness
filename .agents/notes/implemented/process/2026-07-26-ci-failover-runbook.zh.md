# Agent Note: CI 故障切换手册 — 托管池 → 自有池

Status: implemented

[English](2026-07-26-ci-failover-runbook.md) | 中文

## 问题

[CI](../../../../.github/workflows/ci.yml) 中三个必需的 Linux 工作作业（`node 24 / static`、`node 24 / coverage`、`node 24 / snapshots and artifacts`）运行在托管的企业级 32 核池上；聚合它们的必需判定作业（`all checks passed`）运行在标准 `ubuntu-latest` 上；[原生 Windows 作业](2026-08-08-native-windows-pull-request-ci.zh.md)运行在托管的 `dsh-windows-2025-16core` 大型运行器上。当企业池发生故障——作业无限排队或企业标签消失——所有开启的拉取请求都无法合并，而"合并一个修复"这一常规恢复手段本身正被那些无法运行的必需检查死锁。**适用范围：两个独立开关，每个平台一个。**`DSH_CI_FAILOVER_LINUX` 恢复企业级 Linux 池故障（三个必需的 Linux 工作作业加 `all checks passed` 判定作业）；`DSH_CI_FAILOVER_WINDOWS` 恢复托管 Windows 池故障（原生 Windows 作业）。Linux 池故障无需重定向 Windows 作业，反之亦然。[Node 兼容性作业](2026-09-06-node-compatibility-selfhosted.zh.md)也通过隔离设置跟随 Linux 开关；判定作业的 `node-24-bench`、`python-sdk` 和 `python-runtime` 依赖仍留在标准托管运行器上；若更大范围的 GitHub 托管容量故障连标准池一并击倒，这些依赖仍会阻塞 `all checks passed`。因此故障需要一个任何具备仓库写权限的响应者都能在不合并任何代码的情况下触发的开关。

## 决策

三个主要 Linux 作业（`node-24`、`node-24-coverage`、`node-24-consumers`）、三个 `node-compat` 矩阵条目和 `all-checks-passed` 通过 `DSH_CI_FAILOVER_LINUX` 解析；原生 Windows 作业通过 `DSH_CI_FAILOVER_WINDOWS` 解析。一个平台的开关不会重定向另一个平台。仓库写者将变量设为 `selfhosted` 时，适用的可信作业选择 `vm-backup` 或 `dsh-win-ci`；否则保留工作流定义的托管回退。Node 兼容性作业要求同仓库且非 fork 的头部以及非 Dependabot 作者，使用隔离运行时设置，并保留 `ubuntu-latest` 回退。Linux 故障切换限制快照并发，并跳过托管软件包缓存恢复。判定作业跟随工作作业，避免继续在不可用的托管池排队。每个开关都是写者可管理的仓库状态而非一次合并，因此在检查失败时仍然有效。`serial / linux (self-hosted standby)` 与 `serial / windows (self-hosted standby)` 通道在 master 推送上重新验证完整的未分片聚合流程。

`ci-master.yml` 只豁免一个事件不做取消（`${{ github.event_name != 'push' }}`），因此一次 master 推送不会取消上一次推送留下的、仍在运行的演练。每次演练以单门禁工作进程执行完整的未分片聚合流程，耗时长于 master 合并的间隔；在无条件取消下，演练会在得出结论前被后续运行取代，该通道无法产出供响应者查看的就绪证据。

这项豁免比「演练总能跑完」要窄，有两点限制。其一，GitHub 每个组只保留一个待运行条目，更新的待运行条目会顶掉更早的，繁忙时段中间的推送运行仍会以 `cancelled` 结束。其二，该表达式是针对**新触发的运行**求值的，因此自身事件不是 `push` 的运行——例如在 `ci-master.yml` 内的 master 上派发的基准测试，与其演练共用 `CI master-<ref>` 组——求值为 `true`，会取消正在运行中的演练。这属于罕见的手动操作，且下一次 master 推送即可恢复证据，因此不值得为它再加机制。这项豁免换来的是该通道**周期性**地得出结论，而这正是它能作为证据的前提。

这个决定必须放在工作流级：取消作用于被取代的整个运行，作业级 `concurrency` 组并不能豁免其所属作业。采用否定式写法而非仅指名 `pull_request`，是有实质作用的：后者会连 `workflow_dispatch` 一起停止取消，而每次运行器基准测试会在 master 上的同一并发组内同时占用 12 台大规格运行器、最长 15 分钟，届时重复派发会排在演练之前，而不是替换掉已过时的测量。成本之所以可控，是因为 `ci-master.yml` 中一次 master 推送承载[合并后的运行时与 Wine 检查](2026-09-06-master-only-platform-ci.zh.md)和这两条演练；拉取请求作业位于独立的 `ci.yml`（不监听 `push`），而基准测试在 `ci-master.yml` 内受 `workflow_dispatch` 门控。`scripts/ci-workflow.spec.ts` 会锁定这个推送可达集合——按条件精确匹配，因为否定式事件判断会包含它所排除的事件名——使新的推送可达作业无法悄悄开始累积未取消的运行。

### 发布演练共用 Linux 开关

`DSH_CI_FAILOVER_LINUX=selfhosted` 还会将符合条件的同仓库 PR 和 master 推送中的无凭据依赖布局作业与 dsh/vendor 两个打包作业路由到 `vm-backup`。[发布演练决策](2026-09-06-release-rehearsal-selfhosted.zh.md) 负责更严格的事件准入规则及保留托管的手动触发。这种耦合是有意的：持续设置变量来节省发布分钟，也会让符合条件的主 CI Linux 作业持续使用自托管。清除变量会让两类负载的后续运行返回各自的托管目标；发布操作始终保留托管。

### 自有池是什么

`vm-backup`：一台共享虚拟机，运行多个常驻 systemd 管理的运行器实例。注册实例共享 CPU、内存和磁盘；实例数量不代表独立机器数量。其镜像必须预装 Playwright Chromium 的 Linux 系统软件包；CI 会下载锁文件选定的浏览器，但绝不在这台持久化共享主机上运行 `apt`。切换前先看 `serial / linux (self-hosted standby)` 最近一次运行：其聚合流程包含浏览器回放，因此绿色热备同时验证常规容量和这项浏览器先决条件。

#### Windows 池

`dsh-win-ci`：公司内部 Windows CI 服务器（一台 96 核 / 580 GB 机器）上 32 个常驻运行器实例（计划任务 `GH-Runner-01`…`GH-Runner-32`）。标签：`[self-hosted, dsh-win-ci, windows]`。镜像必须预装 Node 24、pnpm、Git（Git Bash 在 `PATH` 上，即 `C:\Program Files\Git\bin`——`bash` 工具按名称 spawn `bash`）、PowerShell 7，并为符号链接支持启用开发人员模式。通用 Windows 通道的工作区与 pnpm store 必须都位于 ReFS 卷（`F:`）上：这些安装步骤在 ReFS 上传递 `--package-import-method=clone`，这需要该卷布局以及系统 corepack pnpm 携带的 `@reflink/reflink` 原生模块（见 [Windows ReFS store note](../../archived/process/2026-08-30-windows-refs-store-block-clone-install.md)）；没有此布局的重建运行器会在 Windows 构建门禁阶段以 TS6231 失败。切换前先看 `serial / windows (self-hosted standby)` 最近一次运行：绿色热备验证该池能端到端执行 `check:ci:windows-complete`。

### 切换步骤（任何具备写权限的协作者，约 1 分钟，无需合并）

两个开关相互独立：只切换发生故障的那个平台。

1. 仓库 **Settings → Secrets and variables → Actions → Variables → New repository variable**：名称 `DSH_CI_FAILOVER_LINUX`（Linux 池故障）或 `DSH_CI_FAILOVER_WINDOWS`（Windows 池故障），值 `selfhosted`。
2. 重新触发必需作业，使其重新解析运行器池。已经为托管标签**排队**的作业不会重定向，也无法原地 re-run，因此对于本手册所述的无限排队故障，应取消卡住的运行并 re-run all jobs，或推送一个新提交；“Re-run failed jobs”只有在作业真正失败（而非仍在排队）时才有用。
3. 切换到此完成。Linux 故障切换状态下，工作流还会把 `DSH_SNAPSHOT_MAX_CONCURRENCY` 降为 12，以限制共享虚拟机上的争抢，并跳过托管路径的 pnpm 缓存恢复，因为虚拟机的持久 store 会直接提供热安装。覆盖率在两个 Linux 池上都使用 4 个单 worker 插桩分区与 2 个豁免 worker。Windows 开关没有并发或缓存分支；它只重定向原生 Windows 作业的运行器池。

**Dependabot 例外。**两个开关的选择器都刻意排除了 `dependabot[bot]`：故障切换期间，Dependabot 拉取请求继续在托管池排队，而不是把依赖项提供的代码放到持久化虚拟机上执行。故障期间 Dependabot PR 持续排队是预期行为而非切换失败；托管池恢复后它会自行完成。

**谁能扳动这个变量。**GitHub 的 API 允许任何具有写权限的协作者管理仓库变量，因此每个开关实际是写者级而非严格的管理员级。在本仓库的信任模型下这并不构成升权：runner group 接纳本私有、禁 fork 仓库的全部工作流（这是让 PR 引用的故障切换得以成立的刻意取舍），因此任何写者本就可以通过推送分支工作流触达这台虚拟机。抵御不可信代码的边界是仓库成员资格；变量只是为成员路由工作。

## 切换期间的容量

Linux 开关启用期间，容量需覆盖 master 热备、主 CI 作业，以及每个符合条件的 PR 或 master 推送的三个发布演练作业。每个可信 PR 还会增加三个门禁并发度为一的 Node 兼容性作业，包括需要构建的 Node 22 条目和冷临时运行时下载。发布工作流不会因为新运行到来而取消正在执行的演练，因此不同引用的重叠运行会增加持续的构建、打包和安装负载。延长自托管运行前，检查当前 CPU、内存、磁盘和队列压力；同一虚拟机上新增注册只增加调度槽位，不增加机器资源。不能只依据热备负载推断空闲容量。主机资源允许增加注册实例时，使用组织级注册 token（组织 Settings → Actions → Runners → New runner）。复制现有 runner 目录时**必须排除身份文件**——`rsync -a --exclude '.runner*' --exclude '.credentials*' --exclude '_diag' --exclude '_work' <src>/ <dst>/`（通配同时排除 `.runner_migrated`/`.credentials_migrated`——GitHub 会在迁移过的运行器上写入这些文件，它们同样会触发 already-configured 拒绝）——再跑 `config.sh`（原样拷贝 `.runner`/`.credentials` 会使其以 "already configured" 拒绝），然后**启动监听器**：`sudo ./svc.sh install ubuntu && sudo ./svc.sh start`。仅注册不会上线；启动服务增加的是调度槽位，而非 CPU 或内存。


### 切回

删除 `DSH_CI_FAILOVER_LINUX` 或 `DSH_CI_FAILOVER_WINDOWS` 变量（或改为 `selfhosted` 以外的任何值），新的运行即解析回各自的托管池。若故障期间追加注册过实例，将其移除。

### 信任边界

这些变量是写者可管理的仓库状态；`pull_request` 事件本身既不能设置它们，也不能让不同的值生效，选择器表达式存在于工作流定义中。需要注意：故障切换期间，`pull_request` 运行执行的是 PR merge 引用自带的工作流定义——抵御不可信代码的边界是仓库成员资格（私有、禁 fork、选择器排除 Dependabot），而非该变量。关于 runner group 策略的说明：把 runner group 绑定到 master 引用的工作流与本故障切换机制**不兼容**——包括 Node 兼容性矩阵在内的故障切换作业是从 PR merge 引用求值的 `pull_request` 运行，master 绑定的组会让它们持续排队（2026-07-27 实际故障中亲历；当时将组放宽为本仓库全部工作流才疏通了切换）。更严格的运行器侧策略以牺牲 PR 故障切换为代价；当前采用的形态是仓库范围、全工作流的组访问。

## 曾考虑的替代方案

**通过合并一次工作流改动来切换池。** 否决，因为触发切换的故障状态恰恰是任何 PR 都无法合并的状态：必需检查正是失败的那些。仓库变量是写者可管理的状态，重跑即生效，无需合并。

**让自托管池长期处于必需路径中。** 否决，因为这是拿托管池的可用性去换自有虚拟机的可用性，只是搬移了单点故障而非增加回退。未设置变量时默认保留托管目标，开关提供由运维人员选择、可逆的自托管路径；按平台拆分意味着一个平台的故障不会重定向另一个平台。

## 后果

从托管池故障中恢复只需切换受影响平台的变量（任何写者可设）加一次重跑，关键路径上没有合并。代价是每个平台都要维护第二套运行器拓扑：热备通道在每次 master 推送时都运行它们，避免故障切换目标变得陈旧；而 `ci.yml` 中的快照并发与缓存恢复分支带有一条 `selfhosted` 支路（仅 Linux），必须与托管支路保持同步。按平台拆分开关多了一个需要管理的变量，但把每个开关的影响范围限定在单个平台的作业上。
