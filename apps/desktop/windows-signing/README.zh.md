---
description: "配置和维护 Windows 打包 runner、签名凭据、EV Token 与签名缓存。运行分支代码或访问 Token 前，先阅读已接受的隔离风险。硬件失败需要操作者检查；打包成功不代表安装或生产发布已通过验收。"
---

# Windows 签名与 runner 运维

[English](README.md) | 中文

## 概述

配置和维护 Windows 打包 runner、签名凭据、EV Token 与签名缓存。运行分支代码或访问 Token 前，先阅读已接受的隔离风险。硬件失败需要操作者检查；打包成功不代表安装或生产发布已通过验收。

## 目录

- [信任前提与隔离缺陷](#trust-and-isolation)
- [机器配置与 runner 启动](#machine-setup)
- [签名配置](#signing-configuration)
- [签名与时间戳处理](#windows-ev-signing)
- [失败记录与人工恢复](#failure-and-recovery)
- [签名缓存与并发阶段](#signature-cache)
- [验证范围](#verification)

<a id="trust-and-isolation"></a>

## 信任前提与隔离缺陷

共享打包 runner 以内部团队代码和操作人员可信为前提。在此前提下，凭据和设备隔离暂缓实施，剩余风险按已知风险接受（由 #5973 跟踪）；尚未强制限制仅 signed/master 可访问。未签名模式跳过签名文件加载，但无法阻止同一 Windows 账户下的分支代码读取这些文件或访问 Token。SafeNet Single Logon 可能复用认证状态。直接调用设备可以绕过签名脚本并耗尽 PIN 重试次数；持久失败 interlock 只保护经过这些脚本的调用。跨账户 Token 隔离和剩余重试次数尚未验证。扩大访问范围、执行不可信贡献、改变 runner 共享方式前，或出现可疑活动后，重新评估 runner、账户和设备隔离。

<a id="machine-setup"></a>

## 机器配置与 runner 启动

使用 runner 专用 checkout，并将配置、证书和缓存放在其外部。注册和工具安装由操作者负责。打包输入与产物获取见[打包指南](../packaging/README.zh.md#windows-actions)。

运行 `pwsh -NoProfile -File apps/desktop/scripts/setup-windows-packaging.ps1 -Root <absolute-machine-root>` 创建私有 `packaging/{presets,secrets,certificates}` 和 `cache/windows-signatures` 目录并复制模板，不覆盖现有文件。添加 `-CheckOnly` 只检查不写入。在机器上填写 [preset 模板](../config/windows-packaging/test.env.example)和[签名模板](../config/windows-packaging/windows-signing.env.example)。从同一 scripts 目录运行 `start-windows-packaging-runner.ps1 -RunnerRoot <registered-runner-directory> -ConfigRoot <machine-root>/packaging -CheckOnly`，检查 runner 的 `tools` 目录下 PowerShell 7.6.6、Node、Python、Git、tar 和 Visual C++ 工具；打包 `--check` 完成其余工具链检查。省略 `-CheckOnly`，以显式配置目录和清理后的继承环境启动现有 runner。注册和工具安装单独进行；这些脚本不创建 token、不改系统安全设置、不清除签名失败记录。修改 preset 缓存路径前，使用下文签名缓存维护命令迁移已有条目。

### 受监督启动

完整的注册、标签、路由和审批配置顺序见 [CI 发布配置](../publishing/ci/README.zh.md#setup-sequence)。任务安装器需要 Windows .NET Framework 4.5+ 编译器，路径为 `%SystemRoot%/Microsoft.NET/Framework64/v4.0.30319/csc.exe`。它将 GUI 可执行文件编译到 `runner/dsh-task/launcher.exe`；该程序不分配控制台地启动 PowerShell，并等待其退出。`run.ps1` 自身的输出和错误分别写入名称唯一的 `launcher-*.out.log` 和 `launcher-*.err.log`，文件名包含 UTC 时间、PID 和随机标识。启动器失败时禁用周期启动，包括尚未读取重试预算时发生的失败。任务结果 `2` 表示启动器失败，`3` 表示无法写入错误日志，`4` 表示禁用任务也失败，需要操作者在计划任务中手动禁用。直接子进程退出后，最多等待五秒排空输出；超时返回 `5`，将诊断写入 `launcher-*.drain.log`：输出可能不完整，但周期恢复仍受原有重试预算约束。后代进程可能在 runner 退出后继续运行；日志排空不会终止它们。记录的停止目标是启动器进程，因此 stop 覆盖启动器及其后代。正常 runner 输出仍保存在 `run-*.log`。

以 runner 的 Windows 用户运行 `pwsh -NoProfile -File apps/desktop/scripts/windows-runner-task.ps1 -Action install -RunnerRoot <registered-runner-directory> -ConfigRoot <machine-root>/packaging`，使用该机器安装的 PowerShell 7。安装器检查环境，并将启动脚本复制到 `runner/dsh-task`；注册、工具和凭据仍单独管理。它注册一个初始禁用、权限受限的交互式计划任务，不保存账户密码。任务优先级 4 让 runner 及子进程使用普通 CPU、I/O 和内存优先级；计划任务默认值 7 会降低三者的优先级，使依赖安装变慢。已有任务保留原设置：在 runner 空闲时停止、卸载并重新安装任务，再启动。执行 `-Action start` 或 `-Action status` 时只传 `-RunnerRoot`；配置目录及重试选项仅适用于安装。任务在该用户登录桌面后启动，重启后也需要登录，注销时停止。它不提供无人值守开机，也不解锁签名 Token。

任务只允许一个实例，且没有执行时限。周期触发器每隔 `-RestartMinutes` 分钟（默认 `1`）检查一次，并恢复已退出的启动器，包括意外的零退出码。持久预算允许首次启动及 `-RestartCount` 次重启（默认 `10`），直到再次显式启动。每次桌面登录也会消耗预算，`status` 显示剩余启动次数；预算耗尽后，仅登录不能重启 runner。对正在运行的任务执行 start 不会重置预算。预算或配置文件缺失、无效时，自动启动会禁用，需修复后恢复。GitHub 启动器负责 runner 更新；任务恢复不会重跑失败的 workflow，也不会清除签名互锁。重试耗尽后，检查 `runner/dsh-task/run-*.log`、runner 的 `_diag` 日志和 `status`，修复原因后运行 `start`。任务运行不等于连接成功：确认出现 `Connected to GitHub` 和 `Listening for Jobs`，再到 Actions 确认任务分配。`run-*.log` 和 `launcher-*.log` 均保留，由操作者管理清理。

维护前暂停新 workflow 的触发，等待 runner 空闲。`-Action stop` 在该 runner 存在活跃 worker 时拒绝停止，否则禁用后续启动并停止任务进程树；本地检查无法阻止 GitHub 同时分配任务。`-Action uninstall` 要求任务已停止并禁用，保留注册、配置和日志。拉取仓库更新不会更新已安装的副本。升级时先记录原来的 -ConfigRoot、可选的 -NetworkRoot 和重试设置，再从更新后的 checkout 依次执行 `stop`、`uninstall`、携带原设置的 `install` 和 `start`，最后重新确认监听与 job 分配。迁移手动启动的 runner 时，只在空闲后停止原启动器，再启动计划任务；不要同时运行两个启动器。

操作者可在 Windows 上运行 `pwsh -NoProfile -File apps/desktop/tests/windows-runner-task.ps1`，使用隔离的假 runner 验证安装、无控制台的首次启动与自动恢复、防止重复启动、停止、子进程退出、启动／日志失败时的禁用处理和卸载。此显式运行的测试创建临时任务并保留诊断文件，不连接 GitHub 或访问签名硬件。`pwsh -NoProfile -File apps/desktop/tests/windows-runner-launcher.ps1` 无需计划任务，检查 GUI 可执行文件、子进程无控制台、退出状态、诊断输出以及存在继承管道写端时的有界排空；Windows CI 会执行该测试。真实机器验收还需检查空闲 runner 上线且不出现 Terminal 窗口、Actions job 分配，以及经操作者批准的重启后登录。签名打包和注销／重启验收需要操作者单独验证。

### 可选网络依赖

`ConfigRoot` 中没有 `runner-network.json` 时，启动仍使用清理继承环境后的直连行为。要配置网络依赖，请在 checkout 外创建操作者管理的该 JSON 文件，且只包含 `proxyUrl`、`noProxy`、`serviceName`、`probeUrl`、`attempts`、`timeoutSeconds` 和 `retrySeconds`。前四个字段为字符串，后三个预算为 1 至 60 的整数。直连时将 `proxyUrl` 留空，没有 Windows 服务管理依赖时将 `serviceName` 留空。URL 必须使用 HTTP(S)，不能包含凭据、查询参数或片段；代理 URL 不能包含路径。启动脚本在清理环境后设置 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 和 `NODE_USE_ENV_PROXY`，并要求 Node HEAD 探测成功才允许启动 runner。服务就绪检查不会启动或停止 Windows 服务。

若使用专用子进程，在安装任务时添加 `-NetworkRoot <absolute-private-network-directory>`。该目录必须包含 `launch.json`，且只包含绝对路径的 `executable` 文件名、字符串数组 `arguments`，以及 1 至 3600 的整数 `restartDelaySeconds`。此模式要求存在 `runner-network.json`，其中 `serviceName` 应留空。为子进程分配独立的数据目录、监听绑定和可执行文件标识，与桌面软件管理的应用分离；仅使用不同端口无法防止其他管理器按可执行文件名终止进程。脚本不会修改桌面网络设置。实际服务商名称、路径、地址、端口和参数只保存在机器配置中，不得写入仓库文件或共享日志。将两个配置目录的访问权限限制为 runner 操作者。

安装时会启动依赖进行就绪检查，并在注册任务前停止它。runner 存活期间，守卫仅在自己拥有的网络进程退出后，按配置间隔重新启动它；启动连续失败时仍会重试，但不会重启 runner、重跑任务或重试签名。退出、重启和启动失败消息写入 `run-*.log`，依赖进程的输出会被丢弃。重启消息只表明进程已创建，不代表网络可用；请在 runner 日志中确认重新连接。进程仍存活但无响应时需要操作者排查。守卫独占锁定 `NetworkRoot`，回收残留子进程前核对 PID、启动时间和可执行文件，并在 runner 退出时停止子进程。不可恢复的守卫错误会保留活动 runner 直到其退出，并报告恢复已停止。重新安装时保留 `NetworkRoot`；仅拉取代码不会替换已安装的辅助脚本。

Windows CI 使用隔离的本地 fixture 运行 `pwsh -NoProfile -File apps/desktop/tests/windows-runner-network.ps1` 和 `pwsh -NoProfile -File apps/desktop/tests/windows-runner-network-process.ps1`。在已配置的打包机器上，给第一条命令添加 `-CheckStartup`，可验证实际启动环境清理后的网络配置。这些测试不会使用签名硬件或外部网络端点。

<a id="signing-configuration"></a>

## 签名配置

通过[机器 preset 配置](../packaging/README.zh.md#configuration-and-local-builds)选择公开设置与签名文件；不选择 preset 时使用目标 dotenv 文件。

在 `.env.windows` 中填写 `DSH_DESKTOP_WINDOWS_CER_FILE`（公开 EV 叶证书）、`DSH_DESKTOP_WINDOWS_SIGNTOOL`（SafeNet 兼容的 SignTool）、`DSH_DESKTOP_WINDOWS_KEY_CONTAINER`（匹配的私钥容器）和 `DSH_DESKTOP_WINDOWS_TOKEN_PIN`（Token Password）。私钥仍保留在 USB Token；不要把证书或本地凭据文件提交到 Git。

PIN 不能包含 `]`、引号或换行，因为这些字符用于分隔 SafeNet `/kc` 值或对应的 CMD 参数。CMD 会禁用延迟展开，因此包含 `!` 的 PIN 可以原样到达 SafeNet。打包流程不会把任何 `DSH_DESKTOP_WINDOWS_*` 字段传给构建与 运行时准备子进程；它只向签名预检、独立的第一方运行时签名阶段与 electron-builder 提供四个配置输入，在其他字段已经清理的环境中只向签名 CMD 提供经过校验的签名字段，在 SignTool 启动前清除这些字段，并遮盖 SignTool 诊断。SafeNet 仍要求 PIN 出现在 SignTool 进程命令行中。本地 `.env.windows` 或机器管理的 `secrets/windows-signing.env` 明文保存 PIN，应限制文件访问权限。CI 读取 checkout 外的机器签名文件，并在任务结束后保留。不要提交或分享文件内容，也不要把凭据写入日志。配置检查不会消耗 Token 的 PIN 尝试次数；签名仍在首次失败后停止整批任务。

签名 Windows 配置从同一份公开证书的 `CN`、`O` 和 `C` 属性生成 updater 的 `publisherName`。每个属性都必须存在、非空且只有一个值。这些身份属性允许证书续期，无需固定叶证书指纹。已安装应用的 `app-update.yml` 保存预期发布者，下载的清单不能选择该身份。未签名测试构建省略 updater 配置。真实文件验证及其限制见[签名验收记录](../tests/README.zh.md)。

<a id="windows-ev-signing"></a>

## 签名与时间戳处理

启动签名构建前，先按[版本与打包说明](../packaging/README.zh.md#release-versions)确认输入。配置检查不代表 Token 认证成功。

Windows 签名构建在编译或准备依赖前执行受监督的签名预检。静态配置、证书有效期、审计存储、编译器可用性及遗留签名锁的检查不访问 Token。本地 .NET Framework C# 编译器生成一个专用小探针，由正式签名器仅签名一次，随后必须验出配置的证书和时间戳才能继续构建。探针绝不执行。预检的整体 60 秒期限包含时间戳尝试；超时、硬件签名报错或验签失败都会停止本轮流程，不再次调用硬件。成功只证明当前签名路径可用，不证明 PIN 已独立认证：SafeNet 可能复用登录状态。不要为了验证 PIN 而注销或重复认证。`--check`、仅准备和 `--unsigned` 模式不执行此硬件预检；未签名产物仍不能发布上传。自动回归测试使用假签名器，真实硬件由发布操作人员单独验收。

公开身份查询要求构建账户的 `PATH` 中有 PowerShell 7（`pwsh`）；查询进程不可用或失败时，以身份未知结果停止签名。编译探针前，独立非交互进程使用 `CRYPT_VERIFYCONTEXT | CRYPT_SILENT` 从固定的 eToken CSP 读取公钥。该进程只接收容器名，不接收 PIN 或签名凭据；15 秒期限计入已有预检总期限。两个 RSA 密钥槽必须完整读取（允许槽不存在），且至少一个公钥与配置证书匹配。提供程序或容器访问失败、不支持公开读取、输出损坏、超时或不匹配时，在硬件签名前停止。容器访问错误不能证明设备或容器不存在。中间件可能缓存公开信息，因此匹配不代表设备已认证、PIN 正确或已确认剩余尝试次数。此路径已由模拟 CSP 覆盖，当前 SafeNet 版本仍需操作人员单独验收。任何失败都不会自动重试认证或清除已有保护锁。

打包前插入并解锁 Token。electron-builder 钩子把每个产物交给采用 CRLF 的 `scripts/windows-sign.cmd`；该 CMD 只调用一次已配置的 SignTool，并指定 `/f`、SafeNet `/kc "[{{PIN}}]=容器"`、`/csp "eToken Base Cryptographic Provider"`和 SHA-256 文件摘要，不请求时间戳。随后钩子在隔离副本上完成 DigiCert SHA-256 RFC 3161 时间戳，不传递签名凭据。钩子不会改用 electron-builder 内置的 SignTool，也不会重试失败的签名请求。SignTool、证书、容器、PIN、Token 或签名不可用时，Windows 发布打包会失败，不会生成未签名产物。

时间戳处理仅对正常退出但返回失败或警告的时间戳命令重试，最多尝试三次，间隔为一秒和两秒。每次均从同一份已验证的主签名开始。启动错误、终止状态不确定或验签失败会立即停止。SignTool 使用短的私有路径；发布时先把已验证字节复制到目标卷，再原子替换。最终必须通过 Windows 信任、证书、时间戳和规范化全文件相等检查。尝试耗尽后停止打包并保留证据，不再次调用硬件。参见[签名完成决策](../../../.agents/notes/implemented/process/2026-09-17-windows-signature-completion.zh.md)。

<a id="failure-and-recovery"></a>

## 失败记录与人工恢复

将 `SignTool Error: No private key is available.` 视为签名失败：立即停止所有签名尝试，由操作者检查签名配置和 Token 状态后再继续。设备具体的 PIN 重试上限和剩余次数尚未验证，不得通过认证尝试探测。出现此错误后不要重试打包或签名探针。签名器串行执行 Token 操作，并在首次失败后拒绝所有排队任务。

Windows 打包命令通过 `DESKTOP_PACKAGING_RECORD` 输出 `.desktop-build/packaging-runs/` 下的唯一目录。每次运行保留 `run.json`、带时间戳的 `events.jsonl`、脱敏后的 `stdout.log` 和 `stderr.log`，以及 `result.json`。签名失败还会写入 `fatal.json` 并通过 stderr 通知父进程；监督程序立即请求终止当前阶段的进程树并等待退出。失败阶段不能启动后续阶段或生成发布完成记录。日志写入失败也会停止运行。终止错误仍按失败处理，需要操作者检查；缺少最终记录表示尚未确认完成。

硬件签名必须属于受监督的打包运行。调用命令解释器前，签名器原子获取 `%USERPROFILE%/.dsh-desktop-signing/attempt.json` 并记录本次尝试。只有签名成功且配置证书的主签名通过验证后才释放该文件；随后完成时间戳，不再访问硬件。失败、中断、已有锁定文件或审计存储不可用都会阻止再次访问硬件，包括同一 Windows 账户下的另一个签名器实例、进程或代码检出目录。没有定时恢复或自动重试。管理员必须检查保留的证据及令牌状态，再明确授权恢复锁定状态；登录令牌或替换 PIN 文件不会清除它。记录区分签名意图、命令解释器 PID 和完成结果，不计量 CSP／令牌内部的认证次数。不记录命令参数、PIN 或凭据环境。其他 Windows 账户及无关签名程序不在此锁定机制的保护范围内。

<a id="signature-cache"></a>

## 签名缓存与并发阶段

运行时签名在当前 Windows 账户的各 worktree 间共享完整的已签名文件。`.env.windows` 中的 `DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR` 指定固定本地磁盘上的绝对目录；默认值为 `%USERPROFILE%\.dsh-desktop-signing\signature-cache\v1`。缓存目录必须属于当前账户，访问权限不得向其他普通账户开放；带链接的路径会被拒绝。缓存项标识原始字节、公钥证书和签名工具链。每次恢复都检查摘要、Windows 信任状态、时间戳和证书，再替换未签名文件；缓存项无效会停止打包，不回退到硬件签名。不会仅因缓存较旧而重新签名。缓存信任同账户运行的程序，不防御管理员。[运行时签名缓存决策](../../../.agents/notes/implemented/process/2026-09-17-windows-runtime-signature-cache.zh.md)定义验收要求和设计限制。

预检、主要运行时签名、应用运行时签名和产物生成分别持有账户级签名阶段锁，直到受监督的子进程结束。其他构建进入这些阶段前等待；编译和准备步骤不持锁。运行时签名进程自行持锁，因此仅终止外层打包进程不会释放仍在访问缓存的阶段锁。迁移及维护获取同一把锁；旧版或外部签名命令不参与排队，应另行避免并发。阶段等待不计入预检期限。关闭阶段句柄会释放普通竞争锁，不删除独立的硬件尝试互锁；遗留硬件失败仍需操作人员恢复。

缓存命中的复制、摘要和逐文件候选信任检查使用 `.env.windows` 中的 `DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY` 个工作任务（默认 `4`，整数 `1`–`8`）。所有恢复完成后，有界 PowerShell 批次逐项验证恢复目标的信任、时间戳和证书，通过后未命中项才进入串行硬件签名。恢复失败会停止派发新的恢复任务并等待在途工作结束；目标验签失败会等待当前检查批次结束并阻止硬件签名。运行时 smoke 检查和最终完整性校验仍须执行。

PE 发现会读取每个普通文件的头部，同时最多打开八个文件，拒绝链接和损坏的 Windows 可执行文件，并在报告失败前等待在途读取和关闭结束。打包将 `windows:enumerate-code` 与 `windows:inspect-signatures` 记录为签名和产物验证的嵌套阶段；其耗时已包含在外层阶段中。

Windows 打包从 `.env.windows` 或所选预设读取 `DSH_DESKTOP_WINDOWS_PACK_CONCURRENCY`：必须为正整数，默认 `4`。Windows 使用有界 worker 批量打包第一方和 vendor tarball，随后校验每个产物并记录发布顺序。完整构建成功后，tarball 打包与 Electron、主要运行时准备在各自输出目录中并行执行。两者都成功结束后才开始运行时签名；准备失败会停止新的打包命令，并等待在途进程结束后返回。设为 `1` 时 tarball worker 串行执行；独立的 `release:pack` 默认使用 `1`。

每个运行时阶段向标准输出及打包日志写入 `SIGNATURE_CACHE_SUMMARY`，包含实际目录、策略标识、命中及未命中数、新发布及保留项数、签名请求数、省去的签名请求数和验证失败数。计时区分签名、恢复文件和新签名文件的信任验证及恢复；恢复耗时包含其信任检查和暂存清理。这些统计不包含预检、最终产物签名及外层运行时验签。阶段锁事件单独记录等待时间。 并发计时累加逐文件工作耗时，不代表阶段墙钟时间。

使用 `pnpm --dir apps/desktop run cache:windows-signatures --usage` 查看结构完整的缓存项字节数和数量，或用 `--from <absolute-old-cache>` 导入显式指定、属于同账户的旧缓存。迁移不修改源目录，跳过暂存名称，拒绝损坏项，并保留已有有效项，即使它们的时间戳字节不同。`--clear` 在阶段锁保护下显式删除完整缓存项；不执行自动容量淘汰。`--directory <absolute-cache>` 指定维护目标目录，无需加载发布凭据。不完整暂存项保持原状并单独计数；仅在所有构建停止后检查它们。这些命令绝不清除硬件失败证据。默认存储位于 AppData 之外，避免 MSIX 启动器虚拟化将账户缓存拆开；被重定向的覆盖目录会明确失败。

<a id="verification"></a>

## 验证范围

签名性能证据与更换 runner 后的复测由[签名并发验收](../tests/signing-concurrency/README.zh.md)维护。更新与安装证据由[Desktop 验证记录](../tests/README.zh.md)和[已安装更新流程](../tests/installed-update/README.zh.md)维护。本文档不授权 PIN 重试、自动删除 interlock、设备初始化或改变已接受的隔离策略。

经操作人员授权后，可运行 `node apps/desktop/tests/windows-signing-concurrency.perf.ts --execute --config-root <打包配置目录的绝对路径> --rounds 2` 做并发实验。不加 `--execute` 只打印用法。默认比较完全串行、两个完成任务共用单路硬件签名，以及两路硬件签名，每批使用六个合成 PE 副本。第二轮反转模式顺序。

加上 `--corpus <清单 JSON 的绝对路径>` 后，改用真实发布文件比较 1、2、4 个并发任务。清单是非空 JSON 数组，每项包含绝对路径 `path` 及对应的小写十六进制 `sha256`。准备阶段复制哈希固定的文件，验证签名并仅移除副本上的有效签名；签名无效或字节变化会中止准备。移除签名要求 SignTool 支持 `remove /s`；配置中的版本不支持时，可用 `--strip-tool <signtool.exe 的绝对路径>` 仅覆盖这个公开准备工具。硬件签名和时间戳仍使用机器 preset。每批使用经过字节比对的全新无签名模板副本，保持清单顺序。配合语料使用 `--pipeline-control` 时，改为四个完成任务共用一个硬件请求。原文件和发布缓存保持不变。

实验读取机器 test preset，核对公开身份，持有账户签名阶段锁，每批保留一条硬件尝试保护记录。首错停止派发并排空已发出的工作；最多可能已有四条硬件请求在途。只有全部签名、时间戳和文件验证成功才正常释放保护记录。文件从不执行。记录保留在 `.desktop-build/qualification/signing-concurrency`，包含整批及单文件耗时、批次起止时的主机 CPU 计数、可用内存和驱动进程内存采样。内存采样不含子进程，不能用于确定峰值内存。计时不含输入准备、等锁和包组装。重放现成产物还排除了它们之间的构建依赖；实验不启用生产并发，也不代表完整发布性能。

## 开发备注

无。
