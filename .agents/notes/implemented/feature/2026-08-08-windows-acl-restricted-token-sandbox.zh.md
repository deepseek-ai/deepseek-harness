# Agent Note: Windows sandbox rung: raw ACL restricted tokens over mxc and AppContainer

Status: implemented

[English](2026-08-08-windows-acl-restricted-token-sandbox.md) | 中文

## 问题

最初的[沙箱决策](2026-07-06-sandbox.zh.md)将 `PLATFORM_CHAINS.win32` 留空，因此交付的 Windows profile 因不存在隔离执行器而退化为 danger-full-access。win32 档必须约束沙箱词汇表中的两种文件效果模式——`read-only`（不显式授予任何可写根目录）与 `workspace-write`（允许写入工作区根目录及后端定义的临时区域）——并报告其机制无法约束的任何效果；读取、网络与进程可见性仍在这套词汇之外。

## 决策

直接基于原始 ACL 机制实现该档：把调用者令牌复制为 `WRITE_RESTRICTED` 受限令牌（`CreateRestrictedToken`，`WRITE_RESTRICTED` + `DISABLE_MAX_PRIVILEGE` + `LUA_TOKEN`），其 restricting SIDs 携带彼此独立的工作区能力与私有临时目录能力。`WRITE_RESTRICTED` 只对写访问做交集检查，因此读取保留调用者的环境访问，而写入还必须匹配这些能力 ACE 之一。该交集只覆盖对象自身的那次访问检查，而 Windows 也会依据父目录的 `FILE_DELETE_CHILD` 权限批准写入或删除——这项权限不需要任何 restricting SID 副署，因此只要调用者的环境 SID 持有 Modify，`cmd /c del` 就能删除工作区之外的文件。所以令牌还会被降级为 Low 完整性，每个被授权目录都在添加 ACE 的同一次调用中收到 Low 禁止上调强制标签；无论权限来自哪一项，内核都会在访问检查内部执行该策略，于是被授权根目录保持可写，而其他一切不仅防写、也防删。由于每个授权根目录都被标记为 Low，仅靠完整性检查仍会让一个受限子进程删除**另一个授权根目录**（别的工作区、同级的活跃临时目录）内的文件，因此每次授权还会向 world SID 拒绝 `FILE_DELETE_CHILD`：能力 ACE 的 DELETE 位由此成为授权根目录内唯一的删除授权来源——对受限子进程如此，对用户自身进程亦如此，而后者的日常删除仍然可用，因为同一份 DACL 直接向其授予 DELETE。该机制来自 huoyaoyuan/windows-acl-restrict-poc（`10e4dfb`）的演示；本移植检查每个 API 调用并 fail-closed（POC 因忽略失败而 fail-open）。工作区 SID 由规范工作区路径确定性派生（`workspaceWriteSid`——sha256 → `S-1-4-x-y`）；其常驻工作区 ACE 是跨会话复用缓存，精确 ACE 跳过可避免重复的急切全树传播。每个活跃的会话/工作区对则获得一个随机私有临时目录，以及一个从该路径派生的、经过域分离的 SID（`tempWriteSid`）；其 ACE 可回收，TMP/TEMP 指向该目录，令牌默认 DACL 列入该临时 SID，因此新建的临时对象不会获得共享的工作区能力。fork 因此无法写入同级会话的临时目录树。即使恢复的是同一会话，新的提供方也会选择新的路径和 SID，因此崩溃残留只是失效垃圾，而非冲突或继承的能力；无 agent（智能体）的调用会逐调用创建并移除同样的形态。环境临时根目录绝不会被隐式授权。如果工作区等于或包含临时根目录，调用会在任何 ACL 改动发生前失败，因为否则其可继承的常驻 ACE 会向每个私有子目录授权；直接 API 会拒绝可写根目录与实际私有临时目录在任一方向上的重叠。PowerShell 可借助这项私有临时目录能力完成启动时的 AppLocker 探针，因此在没有主机范围策略时，`workspace-write` 会保持 FullLanguage；`read-only` 无法创建探针文件，会保守地进入 ConstrainedLanguage。这一区别属于 PowerShell 启动行为，不是 ACL 边界的一部分。令牌列表为 read-only = [登录 SID、Everyone]，workspace-write = [登录 SID、Everyone、工作区 SID、可选临时 SID]。登录 SID + Everyone 是保活不变式（没有它们，早期 DLL 初始化会以 0xC0000142 死亡，CNG 会让 pwsh 以 0xE0434352 崩溃）。Everyone 仍留在列表中，但它带来的写权限已被标签层否定；由于 NTFS ACL 属于文件对象，工作区内获授权的硬链接仍会使同一对象的外部别名获得授权，而 DACL 中携带其他沙箱 AppContainer 包 SID 的文件对 Low 完整性子进程不可读。拒绝所有硬链接会让普通 pnpm 工作区不可用，因此提供方报告 `enforcement: 'partial'`，原生套件则钉住这些缺口。Read-only 不含任何能力 SID，因此常驻工作区 ACE 在模式降级后保持失效。Authenticated Users 在两种列表中都不存在——CIM 不可用，从而关闭 C:\-root 建树逃逸——INTERACTIVE/LOCAL 也不存在，因此 Public 树写入被拒绝。新建匿名管道和同步对象通过 `SetTokenInformation(TokenDefaultDacl)` 继承临时 SID（禁用临时目录时继承工作区 SID，read-only 下继承 Everyone）；named pipe 保持 Win32 层 owner/SYSTEM/Admins 全权、Everyone/ANONYMOUS 只读的模板，因此受限孙进程的管道 stdio 仍被拒绝。它以 [`@deepseek-ai/dsh-sandbox-windows-acl`](../../../../packages/sandbox/sandbox-windows-acl/README.zh.md)、[`dsh-sandbox-local`](../../../../packages/sandbox/sandbox-local/README.zh.md) 的 `win32` 档，以及作为隔离执行器的 [`@deepseek-ai/dsh-pwsh-sandbox`](../../../../packages/shell/pwsh-sandbox/README.zh.md) 交付。

## How the restriction works (why no new identity)

身份路线靠"**谁**在跑子进程"来限制，本档靠"令牌派生"来限制。身份路线（landstrip 的 restricted-user、AppContainer）用全新账户或容器 SID 运行子进程，该身份在宿主的文件上从零条 ACE 开始——一切访问（包括读）默认拒绝，子进程要碰的每条路径都必须事后为那个身份补写 ACE 才能放行：这正是让两个备选方案出局的全盘 DACL 改造。受限令牌保留调用者自己的 SID 与 logon session：[`CreateRestrictedToken`](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken) 派生一个加入 restricting SIDs 与 `WRITE_RESTRICTED` 标志的令牌，于是 Windows 做两次访问检查——一次按正常 SID，一次按 restricting SIDs——只有两次都放行，写类访问才被授予。读只凭正常检查即可通过（调用者的 SID 在其可读范围内本来就携带读权限），所以本档不需要任何读授权、也不需要新账户；写还必须额外通过能力 SID 检查，而只有工作区与临时目录的 ACE 能满足它。`DISABLE_MAX_PRIVILEGE | LUA_TOKEN` 在令牌侧合成了新账户的受限用户效果，即使提升过的调用者派生的也是过滤令牌。同一原语其实也能限制读（`SidsToDisable` 把 SID 变为 deny-only），但受限读的令牌需要逐路径的读授权——恰好重新引入身份路线付出的代价——而沙盒词汇表从不要求读隔离。

## 考虑过的替代方案

### 为什么不选 mxc（Microsoft xContainer）？

两个否决理由。其一，OS 版本要求太新：[mxc 的 OS 版本支持文档](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md)把产品下限设在 Windows 11 24H2（build 26100），而 BaseContainer 档（T1，`Experimental_CreateProcessInSandbox`）只在 25H2+（build 26600+）且启用 OS feature 时存在——在 25H2 及以下的所有受支持版本上，文件系统策略都会回退到 T3，即 AppContainer 加宿主侧 DACL ACE 改造。其二，在任一档下支持任意路径读都意味着要为子进程可读的每个路径写 ACL 授予读权限：模型要读整个工作区和任意文件，就需要全盘改写宿主 DACL——对只做写限制的需求而言，这是不必要的驻留副作用与代价。

### 为什么不选 AppContainer？

AppContainer 令牌没有环境读访问：每个可读路径都必须预先通过 capability 或显式 ACE 授予，因此任意路径读——harness 的读模型——在不做同样的全盘授予时无法支持。受限令牌完全不需要读授予：它只对写访问做交集。

### 为什么不选 landstrip？

landstrip 评估在实现前已被否决（未经实战检验；自建 launcher 方案胜出），且其 Windows 后端是 AppContainer 形态，继承同样的任意路径读问题。

## 后果

所得：仅写隔离、不引入新的 OS 版本下限（`CreateRestrictedToken` 比 mxc 的版本早二十年；强制完整性控制出现得更早）、读/网络/进程可见性完全不受影响（与模式词汇表一致）、删除在 Windows 接受的每条授权路径上都被约束且被约束在各自的授权根目录内，且 fail-closed 错误携带 API 名与精确 Win32 错误码。会话共享有意常驻的工作区能力，但不共享各自可回收的临时能力；重启残留既不能阻塞恢复的会话，也不能向其授权。所失：强制执行在结构上只能是部分的，因为此令牌形态无法把 NTFS 硬链接别名限制在路径边界内，而 Low 完整性的令牌也无法打开 DACL 中携带其他沙箱 AppContainer 包 SID 的文件——被这类工具标记过的目录树对受限子进程将不可读；无读侧或网络隔离；控制台隔离不可用（通过 `CREATE_NO_WINDOW` 或 `CREATE_NEW_CONSOLE` 创建的子进程以 `STATUS_DLL_INIT_FAILED` 死亡；[启动可见性](../bug-fix/2026-09-16-windows-subprocess-console-visibility.zh.md)保留控制台继承）；工作区常驻安全描述符改动（复用缓存，以及工作区改名后的失效残留）与异常关闭后遗留的随机临时目录垃圾，直到 OS 卫生机制将其回收；工作区授权采用急切的全树传播（`SetNamedSecurityInfoW` 立即遍历每个后代——大型工作区上耗时数十秒），每台机器每个工作区只付一次；CIM 在两种受限模式下均不可用（Authenticated Users 不存在，从而关闭 C:\-root 建树逃逸）；FAT 类无 ACL 目标的行为未经验证而非「仍可写」；NULL-DACL 目录在 grant/revoke 往返下不保持身份；read-only pwsh 会进入 ConstrainedLanguage，而在没有主机策略时 workspace-write 保持 FullLanguage；named pipe 打开仍被拒绝，因此 libuv 管道 stdio 的孙进程以 EPERM 失败，而继承/忽略的 stdio 与匿名管道可用。包 README 负责记录这些运行限制。

## 测试

产品可见的 Windows 阵容切换仅存在于 win32，而必须在 macOS/Linux 上可重放的 keyless 快照无法覆盖它；替代证据是 bundle 组合 spec 加上 win32 真实 runner 套件，组装态信号由 CI 的 Windows lane 负责。`sandbox-local/tests/acl-grants.spec.ts` 在 mock Win32 的情况下钉住随机临时目录分配、按会话/工作区复用、fork/工作区分离、崩溃后恢复不冲突、成对 argv SID、失败清理，以及常驻/可回收生命周期。在 Windows 上，`workspace-sid.spec.ts` 钉住工作区/临时目录派生与域分离；`acl.spec.ts` 钉住真实 DACL、环境性删除拒绝与强制标签生命周期；`runner.spec.ts` 钉住 Low 完整性级别、成对 SID 验证、共享工作区 SID 时对同级会话临时目录的拒绝、经 `cmd`、.NET、`Remove-Item` 与 libuv 触发的越界删除回归、针对另一个工作区与另一棵活跃临时目录树的跨根删除回归、无 agent 调用的逐调用临时目录创建/移除、TMP/TEMP 重写、模式降级、Public 与 Everyone 拒绝、硬链接部分边界、按模式区分的 PowerShell 语言行为与孙进程 stdio。ARM64 与模拟 x64 原生运行负责提供架构特定的验收证据。

## Related

[pwsh 执行器决策](../../archived/feature/2026-08-01-pwsh-tool-and-executor.md)拥有本档所消费的 pwsh-sandbox/tool-pwsh 方言划分。

[删除约束决策](2026-09-19-windows-acl-mandatory-integrity-confinement.zh.md)以 Low 完整性层与环境性删除拒绝扩展本档；它只取代本文档所述的删除路径。
