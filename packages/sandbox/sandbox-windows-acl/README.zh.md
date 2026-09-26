---
description: "面向 Windows 上选择、配置或排查受限令牌进程隔离的用户与维护者的 Windows 写入限制沙箱后端。"
kind: "package-library"
---

# @deepseek-ai/dsh-sandbox-windows-acl

[English](README.md) | 中文

## 概述

在 Windows 上，本包将子进程的写入与删除限制在工作区和私有临时目录内：`workspace-write` 授予这两处，`read-only` 均不授予。挂载 `dsh-sandbox-local` 后，受限的 bash 与 PowerShell 命令即获得此行为；调用方也可以直接使用公开 `AclSandbox` API；任何 Win32 操作失败都会阻止不受限制的 spawn。每次授权同时写入能力 SID 允许 ACE、对父目录删除权限的环境性拒绝，以及被降级令牌必须匹配的 Low 完整性标签，因此一个授权根目录无法触及另一个。该保证仍为部分强制：硬链接是文件对象别名，而被其他 AppContainer 工具 ACL 过的文件不可读。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Windows 上，挂载本地沙箱提供方后，此后端就是 `ctx.sandbox` 背后的 runner——无需额外配置。要在 harness 之外 spawn 受限子进程时，直接嵌入 `AclSandbox` API。

### 何时选择

为在 `read-only` 或 `workspace-write` 下隔离子进程文件操作的 Windows 组合选择它。当子进程还需要读侧隔离或网络限制时请另选机制：`WRITE_RESTRICTED` 只交叉检查写访问，因此请把此后端与读侧策略或 AppContainer 能力令牌配对以获得更强隔离。

### 直接 API

`AclSandbox` 以捕获 stdio 的方式 spawn 受限子进程（runner 风格使用可用继承 stdio）。它要求显式提供私有临时目录，或用 `tempDir: null` 禁用临时写入——环境临时根目录绝不会被隐式授权。

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AclSandbox, tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'

const workspaceRoot = process.cwd()
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-'))

// mode selects the token's restricting-SID list (see Modes below) and must
// match the grant shape. workspace-write requires distinct workspace and
// private-temp identities; pass tempDir: null to disable temp writes.
const sandbox = new AclSandbox({
  writableDirs: [workspaceRoot],
  tempDir,
  writeSid: workspaceWriteSid(workspaceRoot),
  tempWriteSid: tempWriteSid(tempDir),
  mode: 'workspace-write',
})
await sandbox.init() // throws on ANY Win32 failure — never spawns unrestricted

const child = sandbox.spawn({ command: 'pwsh', args: ['-NoProfile', '-Command', '...'], cwd: workspaceRoot })
const { stdout, stderr, exitCode } = await child.wait()

sandbox.dispose() // revokes the revocable (temp) grant and label, keeps the standing workspace pair
rmSync(tempDir, { recursive: true, force: true })
```

工作区的安全描述符改动以常驻方式授予——`dispose()` 保留它们，因为它们是跨实例的复用缓存——而不同的临时 SID 以可回收方式授予。每次授权就是一次调用，同时携带能力 SID 允许 ACE、环境性删除拒绝与 Low 禁止上调标签。服务端对应实现是 `AclWriteGrant` 类：每个目录一次 `add(path, standing)`，`dispose()` 撤销可回收路径并释放各 SID。

### 隔离给你带来什么

在 `workspace-write` 下，子进程可以写入工作区及其私有临时目录；受 ACL 管辖的其他写入与删除都会被拒绝，已记录的硬链接与 AppContainer ACL 边界除外。在 `read-only` 下不存在显式写入授权，因此写入与删除都会被拒绝，同样带有已记录的边界。

临时隔离按每个活跃的会话/工作区对进行：共享工作区的会话共享其写权限，但无法写入彼此的临时目录。新的提供方总会选择新的临时路径和 SID，因此崩溃残留既无法阻止恢复的会话，也无法向其授权。

### 失败与恢复

`init()` 在任何 Win32 失败时抛出——子进程绝不会不受限制地 spawn。执行命令前失败的 runner 会向 stderr 打印 `windows-acl-run: <detail>` 并以 127 退出，seam 的 runner 失败规则将其归类为损坏的沙箱，而非拒绝。清理按设计尽力而为：`dispose()` 会尝试全部临时撤销并把失败聚合为 `AggregateError`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释受限令牌机制、令牌列表、runner 约定与已验证边界；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 机制

调用者令牌被复制为 `WRITE_RESTRICTED` 受限令牌，其 restricting SIDs 携带彼此独立的工作区与私有临时目录能力，该令牌还会被降级为 Low 完整性。Windows 执行两次访问检查——先对正常 SID，再对 restricting SID——并且只在两次检查都通过时才授予写类访问；与此同时，内核的强制完整性检查会拒绝对任何未标记为 Low 的对象进行写类访问。写 SID 交叉检查只覆盖对象自身的那次访问检查：Windows 也可以依据父目录的 `FILE_DELETE_CHILD` 权限批准写入或删除，而这项权限不需要任何 restricting SID 副署，因此只带交叉检查的令牌不仅能删除其环境用户 SID 所控制的任何文件，还能删除**另一个授权根目录**内的文件——那里的 Low 标签恰好能通过完整性检查。所以每次授权还会向 world SID 拒绝 `FILE_DELETE_CHILD`，使能力 ACE 的 DELETE 位成为授权根目录内唯一的删除授权来源，并在同一次 `SetNamedSecurityInfoW` 调用中把该目录标记为 Low。工作区 SID 由规范工作区路径确定性派生（`workspaceWriteSid`），因此工作区根目录的安全描述符改动每台机器每个工作区只物化一次，之后每次会话、调用或重启都命中精确 ACE／精确拒绝／精确标签跳过。每个活跃的会话/工作区对则获得一个随机私有临时目录，以及一个从该路径派生的 SID（`tempWriteSid`），因此各会话共享预期的工作区权限，却不会继承彼此的临时目录权限。每个策略专用 Win32 调用和 [`dsh-win32-process`](../../subprocess/win32-process/README.zh.md) 提供的进程原语都有检查；失败抛出携带 API 名、精确错误码、系统文本与失败上下文的 `Win32Error`——从构造上 fail-closed。

### 模式与令牌列表

`workspace-write`（登录 SID、Everyone、工作区 SID、临时 SID）为工作区与会话的私有临时子目录分别授予 Write；`read-only`（登录 SID、Everyone——不含写入 SID）不授予任何内容。两种模式都 spawn 降级为 Low 完整性的令牌，对它而言只有被标记 Low 的目录保持可写。保活组（登录 SID + Everyone）在两种模式下都存在：没有它，早期 DLL 初始化会以 `0xC0000142` 死亡、CNG 会让 pwsh 以 `0xE0434352` 崩溃。写入 SID 有意留在 read-only 列表之外：先前 workspace-write 时期留下的常驻授权 ACE 仍然失效，因为 write-restricted 的 pass-2 检查只授予 restricting 列表所携带的内容，而常驻安全描述符改动让重新升级免于重新传播。

NUL 写入是环境性的、不是被授权的：设备 DACL 授予 Everyone 读+写+执行（`0x1201BF`），因此访问掩码落在其内的打开者（cmd 的 `> NUL`、node 的 `\\.\NUL`）在两种模式下都能写。`Set-Content NUL` 在两种模式下都失败（PowerShell/.NET 层效应，非设备 DACL 所致），而 PowerShell 的 `> $null` 重定向不受影响。

Authenticated Users 在两种列表中都不存在——WMI 命名空间安全检查失败（`0x80041003`），因此 CIM cmdlet 与 `Get-ComputerInfo` 在所有受限模式下都不可用，且 C:\-root 树创建逃逸被关闭。INTERACTIVE/LOCAL 同样不存在：宿主的 Public 树向 INTERACTIVE 授予写权限，因此 Public 写入被拒绝。

### 隔离 runner

面向 seam 的形态是 runner 入口（`./runner`）：`dsh-sandbox-local` 在调用者命令的位置 spawn 的 argv 前缀包装——与 bwrap/landlock-run/sandbox-exec 同一架构。runner 创建受限令牌，在它之下 spawn 包装后的 argv，调用者的 stdio 直接透传，把子进程包进 `KILL_ON_JOB_CLOSE` job，镜像子进程的退出码，并在退出时撤销其自行管理的临时授权。每个 runner 侧失败都会向 stderr 打印 `windows-acl-run: <detail>` 并以 127 退出——seam 的 runner 失败规则匹配该签名。

```sh
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> [--write-sid <S-1-4-…> --temp-write-sid <S-1-4-…>] -- <argv...>
```

seam 先把确定性工作区 SID 的 ACE 常驻物化（每个工作区每服务器生命周期一次——复用缓存），再为每个活跃的会话/工作区对创建随机私有临时目录和不同的可回收 SID，把两种身份作为必须成对出现的 `--write-sid`/`--temp-write-sid` 传入；runner 对照各自所属路径验证二者，既不授权也不撤销（`manageDacls: false`）。fork 获得不同的临时能力；即使恢复的是同一会话，新的提供方也会给出新的路径和 SID，因此崩溃残留只是失效垃圾。如果不带这一对标志，`--temp` 指定的是根目录：无 agent（智能体）/独立的 workspace-write runner 会创建随机私有子目录，自行管理其临时 SID，重写 TMP/TEMP，并在退出时移除该子目录。重启后重新授权常驻工作区 ACE 是幂等的：`grantWrite` 读取当前 DACL，当完全相同的 ACE 已存在时跳过重新传播。工作区若等于或包含临时根目录，会在任何授权前被拒绝。

启动时若带有 subprocess 控制标记，runner 会通过受限子进程的 CRT 启动表转发 fd 7，并在 spawn 后立即关闭自身副本。可选的 `controlFileDescriptor: 7` 输入要求 `stdio: 'inherit'`；在管道 stdio 下请求它会在进程创建前失败。

### 已验证边界

- **Everyone 仍留在两种 restricting 列表中，但不再带来写权限。** 保活组是早期 DLL 初始化与 CNG 所必需的；如今 Low 标签会拒绝对被标记根目录之外、由 Everyone 授权的写入，因此这一旧缺口已关闭。
- **在授权根目录内，能力 ACE 的 DELETE 位是唯一的删除授权来源。** 授权会向 world SID 拒绝 `FILE_DELETE_CHILD`，这同时移除了环境性默认行为：自身 DACL 未授予 DELETE 的文件不再能凭父目录权限删除——受限子进程与用户自身进程皆然。用户日常删除仍然可用，因为工作区 DACL 直接向其授予 DELETE。
- **拒绝项只继承到子目录，且子目录的 FullControl 打开会被拒。** `FILE_DELETE_CHILD` 只在目录上被评估，因此该 ACE 带 `CONTAINER_INHERIT_ACE`、绝不落到文件上（它的位 `0x40` 属于 `FILE_ALL_ACCESS`，若落到文件上会让用户、Administrators、SYSTEM 或 DSH host 的每次 `GENERIC_ALL`／`FullControl` 打开都被拒绝）。授权根内的目录保留该拒绝项，因而会拒绝这类打开；基于 `DELETE` 的删除、`MAXIMUM_ALLOWED` 与常规读写打开不受影响——两种结果都已被 runner 套件钉住。
- **写入与删除受限；读取、网络与进程可见性不受限。** 两层都不交叉检查读取，因此受限子进程可以读取调用者可读的任何文件（包括其他工作区中的文件）并打开套接字；`read-only` 因而需要读侧策略才能表达。
- **硬链接是文件对象别名，而非路径别名。** 传播到已有硬链接上的可继承工作区授权会标记并授权底层同一文件的安全描述符，因此同一对象也可通过外部别名写入；拒绝工作区中的所有多链接文件不具可行性，因为普通 pnpm 安装会使用硬链接。
- **控制台隔离不可用。** 以 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 创建的子进程在 DLL 初始化期间以 `STATUS_DLL_INIT_FAILED`（`0xC0000142`）死亡；子进程共享宿主控制台，基于管道的 stdio 重定向不受影响。
- **安全描述符改动是对真实目录的驻留改动。** 工作区 ACE、拒绝项与标签按设计常驻（复用缓存，绝不撤销）；临时改动由 `dispose()` 撤销——但若该目录上仍留有其他能力授权，撤销会保留共享的 Low 标签——撤销后残留的那条拒绝项会随临时目录本身一并消失；手工 `icacls` 清理无法在本平台回收它们（`ERROR_NONE_MAPPED` 1332），请通过本模块回收。
- **常驻 Low 标签的生命期长于 DSH，并会向其他 Low 完整性的进程放宽该目录树。** 工作区的可继承标签在会话结束后（以及同卷移动后）依然存在，因此任何以同一用户身份运行在 Low 完整性的其他进程——别家产品的 Low-IL 沙箱、受保护模式阅读器——都能写入与删除工作区内的内容，而在 Medium 标签下这会被拒绝。这个标签是写边界的代价：没有它受限子进程根本无法写入，而按会话回收会导致每次供给都要重新传播整棵树。
- **被授权目录必须由调用者拥有并授予 `WRITE_OWNER`。** 所有者隐式获得的只有 `READ_CONTROL` 与 `WRITE_DAC`；标签位于 SACL，因此合并应用还需要 `WRITE_OWNER`（完全控制目录——即正常工作区情形——本就具备）。DACL 只授予 Modify 的目录现在会大声失败，而不是静默跳过隔离。
- **环境临时根目录绝不会被隐式授权。** 直接调用方必须提供已存在的私有 `tempDir` 及其不同的 `tempWriteSid`，或用 `tempDir: null` 禁用临时写入；实际临时目录不得与任何可写根目录重叠。
- **受限子进程的临时能力按每个活跃的会话/工作区对私有。** runner 在 spawn 之前把 TMP/TEMP 改写为该私有目录；共享同一工作区 SID 的两个令牌无法写入彼此的临时目录。
- **受限令牌下 `whoami` 与令牌检查 cmdlet 可能失败。** 子进程对复制令牌的 `GetTokenInformation` 部分不可用，因此这类报告型 cmdlet 是否可用取决于宿主环境；这是诊断噪音而非运行故障。

### 头文件验证与源码索引

沙箱拥有的 SID、ACL、令牌、文件与锁声明由 [`verify/abi-probe.cpp`](verify/abi-probe.cpp) 对照 Windows 头文件检查。共享进程、stdio 与 Job ABI 由 [`@deepseek-ai/dsh-win32-process`](../../subprocess/win32-process/README.zh.md#header-verification) 归属并验证。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `AclSandbox`：受限令牌策略、DACL 授权、fail-closed 的 spawn 与 dispose |
| [`src/runner.ts`](src/runner.ts) | 基于共享 Win32 进程原语的 runner 入口 |
| [`src/grant.ts`](src/grant.ts) | `AclWriteGrant`：服务端授权物化与撤销 |
| [`src/token.ts`](src/token.ts) + [`src/acl.ts`](src/acl.ts) | 沙箱背后的 Win32 令牌与 DACL 原语 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

先从子系统参考文档了解共享词汇，再看挂载此档的提供方、其消费方与设计决策。

- [进程沙箱子系统](../../../docs/subsystems/sandbox.zh.md)——模式、逐调用策略与强制执行语义。
- [本地沙箱后端](../sandbox-local/README.zh.md)——把此后端挂载为 win32 档的提供方。
- [沙箱 seam 包](../sandbox/README.zh.md)——此后端实现的服务约定。
- [Win32 进程库](../../subprocess/win32-process/README.zh.md)——共享的受限进程、stdio、Job、等待与句柄清理原语。
- [Bash 沙箱执行器](../../shell/bash-sandbox/README.zh.md)与[pwsh 沙箱执行器](../../shell/pwsh-sandbox/README.zh.md)——消费它的受限执行器。
- [Windows ACL 受限令牌沙箱决策](../../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)——为何选择原始 ACL 受限令牌而非 mxc 与 AppContainer。

-----

<a id="model-experience"></a>
## 模型体验

间接地通过 [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.zh.md)、[`dsh-pwsh-sandbox`](../../shell/pwsh-sandbox/README.zh.md) 及其工具呈现；它们渲染此后端的部分强制执行与拒绝事实（工具层通过 `denialSignatures` 分类的受限 stderr），而 [`dsh-sandbox`](../sandbox/README.zh.md) seam 拥有 `SANDBOX_UNAVAILABLE` 文本、`sandbox-local` 拥有 runner 选择。

#### KV Cache 影响

无直接影响；拒绝面属于工具层。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明后端何时不合适，或何时需要特别运维。它们是当前包约束，不是通用 Windows 对比或任务积压。

- **每个工作区一个写入白名单**——写入 SID 是白名单的基本单位，且就是工作区身份；同一沙盒实例跨两个工作区复用时，两个根目录会互相扩大授权面。请按工作区根目录各建一个实例——seam 正是这样做的，以工作区路径为键。
- **清理按设计尽力而为**——`dispose()` 会尝试全部临时撤销并把失败聚合为 `AggregateError`；清理失败可能留下随机目录及其仅含临时 SID 的 ACE。进程退出后，不会再有令牌携带该 SID，因此残留保持失效，直到 OS 临时目录卫生或手动移除目录将其回收。
- **常驻工作区 ACE 是不可见残留。** 工作区改名会派生新的 SID；旧路径上的旧 ACE 留在原地（失效、仅含写入 SID），未来的清理命令可以回收它们。
- **NULL-DACL 目录在 grant+revoke 往返下不保持身份。** 带 NULL DACL 的目录意味着「所有人完全控制」；`grantWrite` 从该 null 构建新 ACL，撤销往返后留下的是 EMPTY（全部拒绝）DACL 而非原始 NULL DACL。真实工作区与临时目录都带真实 DACL，因此这仍是记录在案的边界情形。
- **受限孙进程的管道 stdio 捕获不可用。** libuv 的管道 stdio 用的是 NAMED pipe，其 client 端打开所请求的写访问没有任何 restricting SID 被授予（是 Win32 层的默认 SD 模板，而非令牌默认 DACL），因此受限进程内 `spawn(..., { stdio: 'pipe' })` 以 EPERM 失败；继承与忽略 stdio 的 spawn 可用，匿名管道（PowerShell 的管道）因受限令牌默认 DACL 携带 restricting SID 全权 ACE 而可用。
- **授权物化是急切的全树传播。** 在带可继承 ACE 的目录上调用 `SetNamedSecurityInfoW` 会立即遍历每个后代（大型工作区树上以数十秒计）；按工作区身份每台机器每个工作区只付一次，精确 ACE 跳过让后续每次供给都很便宜。
- **读侧隔离与网络策略不在范围内**——`WRITE_RESTRICTED` 只交叉检查写访问；将此后端与读侧策略配对以获得更强隔离。
- **读取会被其他基于 AppContainer 的工具以包 SID 授权过的对象挡住。** 在本机上，当文件的 DACL 携带针对包 SID（`S-1-15-2-…`）的 ACE 时，Low 完整性的令牌无法访问它——即使同一份 DACL 同时向用户授予完全控制、向 Everyone 授予读取（已观测：只给新文件加这一条 ACE 即可复现拒绝，补授 Everyone 读取无法解除，而同样内容复制到别处仍可读）。其背后的内核规则尚未确证，也不由本包掌控；以 AppContainer 自我隔离的工具正是会写入这类 ACE，因此被它们标记过的目录树对本后端的子进程将不可读。移除外来 ACE（或重新安装受影响的目录树）即可恢复访问。
- **宽目录与 FAT 卷警告已推迟；FAT 类残留未经验证。** UI 侧警告尚未实现，FAT 卷作为授权根会大声失败，而授权根之外的 FAT 类目标不存储安全描述符；其有效完整性标签由系统分配而非记录在对象上，因此标签层在该处的行为未经测试。FAT 仍被视为遗留残留。
- **PowerShell 语言模式因受限模式而异。** 在 `read-only` 下，PowerShell 无法在临时目录中创建 AppLocker 探针文件，因此会保守地以 ConstrainedLanguage 启动（`Add-Type`、非核心 .NET 静态调用、COM 与反射失败）；交付的 `workspace-write` 路径可让探针完成，因此除非主机范围的 WDAC/AppLocker 策略另有规定，否则 pwsh 保持 FullLanguage，而直接使用 `AclSandbox` 并配置 `tempDir: null` 时则没有这一保证。这一区别属于 PowerShell 启动行为，不是 ACL 写入边界的一部分。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决方向与开放问题。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：警告与清理表面

对异常宽的目录与 FAT 类卷的仅警告立场已记录在上方限制中但尚未实现，回收改名工作区常驻 ACE 的清理命令也尚未决定。两者都是开放方向，不是已交付行为。

</details>

**运行时不变式：** 不发布伴生入口。本包没有独立事件序列或可变数据关系；fail-closed 约定在每个 Win32 调用处强制。
