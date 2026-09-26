# Agent Note: Windows 沙箱删除约束：强制完整性 + 环境性删除拒绝

Status: implemented

[English](2026-09-19-windows-acl-mandatory-integrity-confinement.md) | 中文

## 问题

[受限令牌档](2026-08-08-windows-acl-restricted-token-sandbox.zh.md)通过把请求的访问掩码与 restricting SIDs 求交集来约束写入。该交集只覆盖针对对象**自身**安全描述符的那次访问检查：Windows 也会依据**父目录**的 `FILE_DELETE_CHILD` 权限批准写入或删除，而这项权限不需要任何 restricting SID 副署。因此 `cmd /c del` 与 `[System.IO.File]::Delete`——凡走 `DeleteFileW` 的路径——在两种受限模式下都能删除工作区之外的文件（issue #4581），而同一子进程的普通写入却被拒绝。

## 决策

每次授权现在都在一次 `SetNamedSecurityInfoW` 调用中施加三项编辑，并把受限令牌降到同一级别：

1. 能力 SID 的允许 ACE（`GRANT_MASK`，`OI|CI`）——写权限本身，未变；
2. 对 world SID 的 `FILE_DELETE_CHILD` 拒绝 ACE，带 `CONTAINER_INHERIT_ACE`——能力 ACE 的 DELETE 位成为授权根内唯一的删除授权来源；
3. Low 完整性强制标签（`S-1-16-4096`、`SYSTEM_MANDATORY_LABEL_NO_WRITE_UP`、`OI|CI`）——并用 `SetTokenInformation(TokenIntegrityLevel)` 把受限令牌降到同一级别。

三者都不可省。标签是唯一能触及父目录 `FILE_DELETE_CHILD` 路径的手段：无论权限来自哪一项，内核都在访问检查内部执行强制策略，因此授权根之外的 Medium 对象不仅防写、也防删。拒绝项则负责隔开**各个**授权根：所有授权根都带 Low 标签，仅靠完整性检查它们之间仍会放行。而拒绝项只做容器继承，是为了不破坏环境 ACL 的可用性：`0x40` 是 `FILE_ALL_ACCESS` 的成员，若落到文件上会让授权根内每次 `GENERIC_ALL`／`FullControl` 打开都被拒绝——收窄标志之前已在真实 runner 上实测确认。

标签在工作区根上**常驻**，与能力 ACE 同理：按会话回收会导致每次供给都重新传播整棵树，并与并发会话竞争。`revokeWrite` 只在该目录上不再留有其他能力授权时才清除标签，因此同一目录上的两份授权仍可独立撤销。幂等跳过要求精确 ACE、精确拒绝与精确标签三者齐备，因此早前版本已授权的工作区会在下次供给时补上拒绝项。

## 考虑过的替代方案

### 为什么不让标签按会话回收？

那样可以消除下面的外部性，但每次供给都要付出确定性工作区 SID 本要避免的急切全树传播（大型工作区上以数十秒计），而且并发会话或崩溃会话会让标签反复消失与重建。

### 为什么 read-only 模式不用 Untrusted 完整性？

本机实测：Untrusted（`S-1-16-0`）令牌根本无法启动 `pwsh`——DLL 初始化失败（`0x8007045A`，`BCrypt.dll`）——该模式将没有可用的 shell。

### 为什么不用 `OI|CI` 施加 `FILE_DELETE_CHILD` 拒绝？

那样拒绝项也会落到授权根内的每个**文件**上（用 `icacls` 观察到的正是 `Everyone:(I)(DENY)(DC)`），而 `0x40` 属于 `FILE_ALL_ACCESS`，于是这些文件上的 `CreateFileW(GENERIC_ALL)` 会对用户、Administrators、SYSTEM 与 DSH host 一并返回 `ERROR_ACCESS_DENIED`。收窄标志消除了这一类影响；授权根内**目录**的 FullControl 打开仍被拒绝，这是拒绝一项属于完全访问掩码的权限所无法避免的代价。

### 为什么不干脆去掉这层约束、只把逃逸写进文档？

逃逸本身就是报告内容：`cmd /c del` 删除工作区之外的文件，恰恰是沙箱承诺不允许的事；而仅靠读侧或纯 ACL 的改动关不掉它——restricting SID 交集在构造上就触及不到父目录路径。

### 为什么不让每个工作区拥有自己的完整性级别？

强制完整性控制只有五个固定级别（Untrusted、Low、Medium、High、System），无法像 `S-1-4-x-y` 能力 SID 那样按工作区派生。

## 后果

所得：删除在 Windows 接受的每条授权路径上都被约束，且被约束在各自的授权根内；此前记录的 Everyone 写边界被关闭；写入、读取与进程可见性其余部分不变；每次 Win32 调用失败都 fail-closed。所失（全部记录在包 README 中）：常驻 Low 标签会向**任何**以同一用户身份运行在 Low 完整性的进程放宽该工作区树，并比 DSH 生命期更长（这是在该完整性级别上拥有写边界本身的代价）；被授权目录现在还必须授予 `WRITE_OWNER` 才能写入标签（完全控制的工作区具备，仅授予 Modify 的会大声失败）；授权根内目录的 FullControl 打开被拒绝；被其他 AppContainer 工具以包 SID 标记过的目录树对 Low 子进程不可读；FAT 类目标仍未验证。[受限令牌档笔记](2026-08-08-windows-acl-restricted-token-sandbox.zh.md)仍是该档令牌列表、runner 约定与授权生命周期的归属者；本笔记只负责删除路径与封闭它的完整性层。

## 测试

`runner.spec.ts` 以真实 runner 与真实受限令牌钉住行为：两种模式下经 `cmd`、.NET、`Remove-Item` 与 libuv 的越界删除全部被拒且**宿主侧文件仍存在**；一个会话无法删除另一个授权根内的文件；NUL 在两种模式下仍可写；授权根内**文件**的 `GENERIC_ALL` 打开成功，而**目录**的同一打开被拒绝；同一目录上两份授权之一被撤销后，存留的授权仍可用。`acl.spec.ts` 钉住真实 DACL／标签生命周期、拒绝项只继承到容器、以及共享标签的撤销规则；`token-failure-paths.spec.ts` 钉住 `TokenIntegrityLevel` 的精确载荷；失败路径套件覆盖每处新增分配与提前退出，包括标签 ACL 与描述符的释放。

## 相关

- [Windows sandbox 档：原始 ACL 受限令牌](2026-08-08-windows-acl-restricted-token-sandbox.zh.md)——本次改动所扩展的档（保持 active；本笔记只取代其删除路径边界）。
- [沙箱决策](2026-07-06-sandbox.zh.md)——平台链与 `partial` 强制执行词汇。
