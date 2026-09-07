# Agent Note: Wine 与原生 Windows CI

Status: implemented

[English](2026-08-08-native-windows-pull-request-ci.md) | 中文

## 问题

Wine 在 Linux 内核与区分大小写的 ext4 之上采用 hoisted 依赖布局检查 win32 工具链。它无法证明 NTFS、DACL、ConPTY、崩溃持久性或原生进程行为。因此，拉取请求的正确性需要原生 Windows 构建和进程检查，独立于合并后的 Wine 结果。

覆盖率审计发现，陈旧分支状态恢复了针对受支持 LSP 源码的临时排除项。因此，原生 Windows 需要按同一逐文件 100% 阈值执行完整的受支持源码清单，而不能依赖缩小后的平台专用分母。

## 决策

[ci-master.yml](../../../../.github/workflows/ci-master.yml) 中仅 master 触发的 `windows` 作业在 `ubuntu-latest` 上运行 `windows node 24 / wine`。它保留经过校验和验证的 Windows Node、Wine apt 与 pnpm 缓存、仅限工作区快照的 hoisted 安装，以及运行工作区构建与生产网站的[共享 Wine 门禁脚本](../../../../scripts/wine-windows-gates.sh)。Node 分发文件传输采用有界重试；nodejs.org 的大文件传输停滞时，由支持范围请求的传输镜像续传相同字节，但版本和 SHA-256 权威仍属于 nodejs.org，归档通过该校验前绝不会投入使用。根据[仅 master 平台策略](2026-09-06-master-only-platform-ci.zh.md)，Wine 不参与 PR 聚合。[已归档的 Wine 实验](../../archived/process/2026-07-27-wine-windows-gates-experiment.md)保留其实测取舍，而本文负责当前双通道拓扑。

每个拉取请求还会在组织自有的 `dsh-windows-2025-16core` 运行器上启动 4 个相互独立的原生作业：`windows-build`、`windows-coverage`、`windows-native-tests` 与 `windows-observational`。每个作业都会为工作区符号链接启用开发人员模式，通过 `pnpm/action-setup` 提供仓库固定版本的 pnpm，在不传输 store 归档的情况下执行不可变安装，并在原生 PowerShell 下运行自己的清单。Windows 故障切换变量会把这 4 个作业全部重定向到公司内部运行器池。各作业采用 60 至 120 分钟的截止时间，以约束卡住的工作，同时不把性能目标当作正确性截止时间。

`windows-build` 与 `windows-native-tests` 是 `all checks passed` 的依赖项；其工作区构建和定向原生进程结果具有阻断性。`windows-coverage` 仍是常规作业，但不在聚合流程的 `needs` 中，因此逐文件 100% 覆盖率结果会保持红灯并可见，却不会延迟必需判定。`windows-observational` 同样不在聚合流程的 `needs` 中，并使用 `continue-on-error`，因为静态检查、文档、包与构建产物的阻断性判定由 Linux 负责。

`windows-coverage` 与 Linux 覆盖率通道一致，不先构建工作区就运行[job 内分区覆盖率](2026-08-18-in-job-partitioned-coverage.zh.md)：4 个单 worker 插桩分片与一个双 worker 的豁免重型门禁并行运行；工作区导入通过 tsconfig paths 映射解析到 `src`，消费构建产物的套件在未构建的检出上会自跳。两项覆盖率门禁都通过 `DSH_COVERAGE_TEST_TIMEOUT_MS=90000` 提高 Vitest 的单测试、expect.poll 与 hook 预算。`windows-observational` 拥有自己的工作区构建和生产网站验证，会一起启动相互独立的静态门禁，并将 `publint` 限制为最多 8 个 worker。其 built-bin 冒烟测试只在其他所有观测性门禁结算后启动；冒烟测试的 `needs` 边仍要求构建成功，而 `after` 边会在其他门禁失败后保留这项诊断。这可避免有界的真实应用启动测量与 tool-catalog、NodeNext、包及文档进程争抢资源。translation-pairing 合并套件只导入 `scripts/` 源码和子进程，因此放入豁免重型套件门禁；V8 插桩不会为它贡献任何阈值覆盖率，却会放大 Git 进程延迟。Lefthook 并发 fixture 保留原有结果，采用 30 秒单用例预算与 10 秒进程就绪探测；安装器则允许被抢占的 lock 持有者在独占创建后用 5 秒发布记录。directory-picker 组合为防抖配置写入提供显式的 15 秒轮询预算；workspace-context 组合 fixture 使用测试自有、没有无关 1 秒截止时间的信号。LSP 源码与 ACL 沙箱源码仍计入 Windows 分母：基于 stub 的失败路径套件把每个进程内 ACL 沙箱文件都带到 100%，只有 runner 入口保持排除——它只作为 spawn 出的子进程在插桩运行之外执行，其行为由 runner 套件端到端钉住。窄范围且带注释的 V8 ignore 只覆盖不可达分支（另一平台专属分支、生命周期内不可达的防御守卫），其行为测试仍保留在所属平台。

16 核配置是这项清单经实测选定的容量规格。使用 6 个 coverage worker 的试验分别以 6 分 27 秒和 7 分 50 秒跑出完整通过结果，而在单个插桩 Vitest 进程内使用 4 个、3 个和 2 个并发 worker 的分支头精确试验暴露出不稳定的 fixture 与 worker 退出。相互独立的单 worker 子进程保留进程隔离。历史上的 16 分片样本把插桩覆盖率缩短到 112.66–122.01 秒。拉取请求覆盖率作业会在没有前置构建的情况下调度 4 个插桩子进程和 2 个豁免 worker，而自托管完整参考流程会用 1 个 worker 串行运行未分片的覆盖率门禁。拉取请求若采用 6 分片配置，就会产生足以违反有界测试截止时间的进程与类型感知 lint 争用。16 个插桩分片加 2 个豁免 worker 会在计入系统开销前就超过 16 核分配。32 核对比仅将聚合门禁时间缩短 1.47 秒，且仍在 fork worker 内触发 CJS lexer 致命故障，因此增加核心数没有带来可靠的墙钟时间改善。

首次原生运行暴露出两项被兼容性通道掩盖的故障。文档投影测试此前只按 `/` 拆分来派生图片 basename；现在改为使用 Node 根据平台计算的 basename。Chokidar 消费方收到的 `%TEMP%` 以 `C:\\Users\\RUNNER~1` 这个 8.3 别名表示，而 libuv 返回的是长目录名，导致其 Windows 事件路径断言失败。共享的设置 watcher 与凭据 watcher，以及 Cordis 的模块 HMR（热模块替换）与精确配置 HMR，现在都会在打开 watcher 前规范化现有的原生监听基准路径或层级最深的现有祖先路径，并保留尚不存在的后缀；文件访问和诊断仍使用配置路径。模块 HMR 会挂接监听器并等待主 watcher 的 ready 事件，之后插件启动才会完成，因此启动后立即发生的编辑无法与初始扫描形成竞态。HMR 验收通过相同的异步原生 realpath 操作派生预期身份，避免同步 Windows 路径写法仍保留 8.3 别名。

可移植文件系统 fixture（测试前置数据）通过 `node:path` 派生路径、比较原生 realpath 标识、在 Node 启动器边界保留文件 URL，只规范化由 API 负责的分隔符或行尾，并使用每个宿主均允许的文件名。仅适用于 POSIX 的信号、模式位、不可读状态和 writer lock 场景按平台设门禁；可移植故障约定则通过每个宿主均可构造的冲突，断言结构化错误码、回滚、最后有效状态、原子替换及不存在临时残留。凭据权限验证采用无效路径 fixture；该路径在每个宿主上都会于系统查找前产生表示“非缺失”的 `ERR_INVALID_ARG_VALUE`，而不依赖文件祖先究竟产生 `ENOTDIR` 还是 `ENOENT`。worker 死亡 fixture 会先观察其协议前置条件，再由宿主触发真实终止，而不在嵌套 Windows Worker 中调用 `process.exit()`；这样既保留了 worker 退出约定，也不会让外围 Vitest fork 暴露于 Node 进程级的原生退出断言。压力与集成工作负载保留原有断言；如果 Windows 插桩或进程拆卸可能超过 Vitest 默认上限，就为其设置显式的有界时间预算。

原生 watcher 使用 `canonicalizeWatchPath()` 对层级最深的现有祖先执行 realpath 解析；后缀缺失时，先证明该祖先是可枚举目录，再拼回后缀。这可避免 Windows 8.3 别名与长格式 libuv 事件混用，并让所有宿主在祖先为普通文件时都保留 `ENOTDIR`。设置、凭据、skill（技能）根与 Cordis HMR（热模块替换）在发现和诊断时保留配置路径；模块 HMR 则使用规范写法作为 Node 加载缓存标识、挂接监听器并在插件启动完成前等待主 watcher 就绪，因此启动后立即发生的编辑不会与初始扫描形成竞态。`watchFollowSymlinks: false` 时，若 skill 根本身是符号链接，系统不会展开最后这一级链接，从而让 Chokidar 强制执行该边界。

Windows 的持久 JSONL 路径会保留驱动器根目录的原生写法，并仅对后代路径与暂存路径应用扩展长度命名空间。ACP（Agent Client Protocol）拆卸阶梯使用真实 Node 子进程，以符合宿主语义的结果证明优雅终止与强制终止两个层级，并避免声称 Windows 会交付 POSIX 信号。产品接受裸命令时，可执行 fixture 会提供 `.cmd` 包装脚本与 `PATHEXT`。repository-cache 辅助包位于所选 Git 子路径内，因此它们声明的 `file:` 依赖会在 Windows 上以相同方式暴露命令包装脚本。随附的安装器会导出 pnpm 自有的 workspace-ignore 配置，保留 `PNPM_HOME` 作为 pnpm 数据配置，同时从生命周期 `PATH` 中移除该目录，并在 `PATHEXT` 中优先选择 `.CMD`；因此，嵌套 Git 包安装既不会重新加入外层 workspace，也不会让继承的 Windows pnpm 可执行文件抢在事务持有的 wrapper 之前。

启动后，只有根 fiber 与 Loader 均处于活跃状态时，系统才会继续设置 profile watcher。只有当同一次调用所记录的信号已取得关闭流程所有权时，系统才会隔离并发设置错误；无关 HMR 故障仍会响亮失败。[进程关闭控制器](../bug-fix/2026-08-03-cli-signal-shutdown-escalation.zh.md)会在根级 dispose 成功后让单次任务的正常完成流程排空 Node 剩余句柄，同时让拆卸失败、截止时间到期和信号升级继续强制退出。vendored Include 会串行化防抖写入，只对瞬时访问或忙碌故障执行有界退避重试，并确保每个由计时器触发的拒绝都得到观察。持久化最终失败后，该故障会保留在队列中，并重新抛给拆卸责任方；成功拆卸则会排空最新写入。

Shiki 会禁用 TextMate 正则的延迟编译，并在用户内容进入保持不变的逐行 tokenization（词元化）预算前预热每种启动语法，从而避免调度器争用发布不完整的高亮流。Codex 真实产品 fixture 固定使用稳定版 0.149.1 schema，并选择实际提供的命令工具与对应参数形态；这样既保留由提供方负责的协议，也能在每种宿主上证明无人值守拒绝和整棵进程树退出。

## 曾考虑的替代方案

**让每项原生 Windows 结果都成为 `all checks passed` 的依赖项。** 这会为聚合流程提供保真度最高的 Windows 判定，但也会让每次合并等待覆盖率和重复的观测性清单。要求构建与定向原生进程套件通过，可以保留快速的原生正确性信号，同时继续自动产生其他结果。

**只在拉取请求上运行 Wine。** Wine 能快速触达阻断性 win32 工具链分支，但即使真实 NT、NTFS、PowerShell、进程或原生插件约定已经损坏，也可能报告绿灯。

**将每个非阻断原生作业都标记为 `continue-on-error`。** 观测性作业采用该设置，因为它的阻断性判定由 Linux 负责。覆盖率仍是聚合流程 `needs` 之外的常规作业，因此阈值失败会保持明显红灯，却不会阻断聚合流程。

**排除看似不受支持的文件或削弱 Windows fixture。** 不予采纳，因为受影响的 LSP、watcher、持久化、客户端与进程行为均受支持。仅适用于另一平台的分支采用窄范围标注；可移植结果继续计入分母，并通过符合真实宿主行为的 fixture 验证。

**保留 GitHub 标准的 `windows-2025` 运行器。** 该可移植双核镜像能可靠完成这份完整清单，但其 32 分钟的串行结果使自动原生信号的实用性远低于所选的 16 核运行器。

**使用 32 核或更大的运行器。** 32 核对比仅比 16 核将聚合门禁时间缩短 1.47 秒，且仍因 Node 的 CJS lexer 失败；先前高并发的 32 核和 64 核试验也以同类故障失败。因此，增加容量只会提高资源分配成本，却不能带来稳定的端到端收益。

## 后果

Wine 提供合并后的工具链证据。`all checks passed` 变绿时，原生覆盖率与观测性结果仍可能处于待处理或红灯状态，因此分支保护采用定向原生构建和进程检查，而评审者和后续自动化采用其余原生结果。

尽管如此，每个拉取请求都会获得真实 NT 内核、NTFS、PowerShell、Windows 进程、原生插件和受支持源码覆盖率信号。原生作业会在构建、覆盖率与观测性工作区中重复设置流程，并在构建与观测性工作区中重复构建，但它们会降低每个作业的进程数，并暴露兼容性通道掩盖的路径、watcher、生命周期与 fixture 缺陷。

维护者必须保留两种有意设计的执行拓扑：Wine 快照使用 Linux 安装加 hoisted 布局来触达 win32 二进制文件，而原生作业在组织自有的 16 核 Windows 运行器上使用相互独立的不可变工作区。任一拓扑独有的失败都必须依据该边界分类，不得削弱或静默跳过。
