---
description: "面向 Windows 上选择、配置或排查受限令牌进程隔离的用户与维护者的 Windows 写入限制沙箱后端。"
kind: "package-library"
---

# @deepseek-ai/dsh-sandbox-windows-acl

[English](README.md) | 中文

## 概述

`dsh-sandbox-windows-acl` 通过写入限制隔离 Windows 进程：子进程在受限令牌下运行，其写访问仅限于工作区与私有临时目录，因此 `workspace-write` 允许这些写入，`read-only` 则不允许任何写入。它作为 `dsh-sandbox-local` 的 win32 档交付：在 Windows 上挂载本地提供方，就能让每次受限 bash 或 pwsh 调用自动使用此后端。也可以通过 `AclSandbox` API 直接嵌入，以捕获 stdio 的方式 spawn 受限子进程。每个 Win32 调用都有检查，失败即抛出异常，因此子进程绝不会不受限制地 spawn。强制执行按设计为部分实现——受限令牌必须为进程初始化保留 Everyone，且 NTFS 硬链接可以把同一文件对象别名为多个路径——因此后端报告 `partial`，需要绝对边界的调用方可以向上暴露它。

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

sandbox.dispose() // revokes the revocable (temp) grant, keeps the standing workspace ACE; reports every cleanup failure
rmSync(tempDir, { recursive: true, force: true })
```

工作区 ACE 以常驻方式授予——`dispose()` 保留它们，因为它们是跨实例的复用缓存——而不同的临时 SID 以可回收方式授予。服务端对应物是 `AclWriteGrant` 类：每个目录一次 `add(path, standing)`，`dispose()` 撤销可回收路径并释放 SID。

### 隔离给你带来什么

在 `workspace-write` 下，子进程可以写入工作区及其私有临时目录；受 ACL 管辖的其他写入都会被拒绝，已记录的 Everyone 与硬链接边界除外。在 `read-only` 下不存在显式写入授权，因此写入会被拒绝，同样带有已记录的边界。

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

调用者令牌被复制为 `WRITE_RESTRICTED` 受限令牌，其 restricting SIDs 携带彼此独立的工作区与私有临时目录能力。Windows 执行两次访问检查——先对正常 SID，再对 restricting SID——并且只在两次检查都通过时才授予写类访问。工作区 SID 由规范工作区路径确定性派生（`workspaceWriteSid`），因此工作区根目录 ACE 每台机器每个工作区只物化一次，之后每次会话、调用或重启都命中精确 ACE 跳过。每个活跃的会话/工作区对则获得一个随机私有临时目录，以及一个从该路径派生的 SID（`tempWriteSid`），因此各会话共享预期的工作区权限，却不会继承彼此的临时目录权限。每个策略专用 Win32 调用和 [`dsh-win32-process`](../../subprocess/win32-process/README.zh.md) 提供的进程原语都有检查；失败抛出携带 API 名、精确错误码、系统文本与失败上下文的 `Win32Error`——从构造上 fail-closed。

### 模式与令牌列表

`workspace-write`（登录 SID、Everyone、工作区 SID、临时 SID）为工作区与会话的私有临时子目录分别授予 Write；`read-only`（登录 SID、Everyone——不含写入 SID）不授予任何内容。保活组（登录 SID + Everyone）在两种模式下都存在：没有它，早期 DLL 初始化会以 `0xC0000142` 死亡、CNG 会让 pwsh 以 `0xE0434352` 崩溃。写入 SID 有意留在 read-only 列表之外：先前 workspace-write 时期留下的常驻授权 ACE 仍然失效，因为 write-restricted 的 pass-2 检查只授予 restricting 列表所携带的内容，而常驻 ACE 让重新升级免于重新传播。

NUL 写入是环境性的、不是被授权的：设备 DACL 授予 Everyone 读+写+执行（`0x1201BF`），因此访问掩码落在其内的打开者（cmd 的 `> NUL`、node 的 `\\.\NUL`）在两种模式下都能写。`Set-Content NUL` 在两种模式下都失败（PowerShell/.NET 层效应，非设备 DACL 所致），而 PowerShell 的 `> $null` 重定向不受影响。

Authenticated Users 在两种列表中都不存在——WMI 命名空间安全检查失败（`0x80041003`），因此 CIM cmdlet 与 `Get-ComputerInfo` 在所有受限模式下都不可用，且 C:\-root 树创建逃逸被关闭。INTERACTIVE/LOCAL 同样不存在：宿主的 Public 树向 INTERACTIVE 授予写权限，因此 Public 写入被拒绝。

### 隔离 runner

面向 seam 的形态是 runner 入口（`./runner`）：`dsh-sandbox-local` 在调用者命令的位置 spawn 的 argv 前缀包装——与 bwrap/landlock-run/sandbox-exec 同一架构。runner 创建受限令牌，在它之下 spawn 包装后的 argv，调用者的 stdio 直接透传，把子进程包进 `KILL_ON_JOB_CLOSE` job，镜像子进程的退出码，并在退出时撤销其自行管理的临时授权。每个 runner 侧失败都会向 stderr 打印 `windows-acl-run: <detail>` 并以 127 退出——seam 的 runner 失败规则匹配该签名。

```sh
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> [--write-sid <S-1-4-…> --temp-write-sid <S-1-4-…>] -- <argv...>
```

seam 先把确定性工作区 SID 的 ACE 常驻物化（每个工作区每服务器生命周期一次——复用缓存），再为每个活跃的会话/工作区对创建随机私有临时目录和不同的可回收 SID，把两种身份作为必须成对出现的 `--write-sid`/`--temp-write-sid` 传入；runner 对照各自所属路径验证二者，既不授权也不撤销（`manageDacls: false`）。fork 获得不同的临时能力；即使恢复的是同一会话，新的提供方也会给出新的路径和 SID，因此崩溃残留只是失效垃圾。如果不带这一对标志，`--temp` 指定的是根目录：无 agent（智能体）/独立的 workspace-write runner 会创建随机私有子目录，自行管理其临时 SID，重写 TMP/TEMP，并在退出时移除该子目录。重启后重新授权常驻工作区 ACE 是幂等的：`grantWrite` 读取当前 DACL，当完全相同的 ACE 已存在时跳过重新传播。工作区若等于或包含临时根目录，会在任何授权前被拒绝。

### 已验证边界

- **Everyone 授权仍是环境中的写权限来源。** Everyone 必须保留在两种 restricting 列表中（移除它会破坏早期 DLL 初始化与 CNG）；外部 NTFS 对象若其 DACL 向 Everyone 授予所请求的写权限，就会同时通过两次检查，并在两种模式下保持可写。
- **硬链接是文件对象别名，而非路径别名。** 传播到已有硬链接上的可继承工作区 ACE 会修改底层同一文件的安全描述符，因此同一对象也可通过外部别名写入；拒绝工作区中的所有多链接文件不具可行性，因为普通 pnpm 安装会使用硬链接。
- **写入受限；读取、网络与进程可见性不受限。** `WRITE_RESTRICTED` 只交叉检查写访问，因此受限子进程可以读取调用者可读的任何文件并打开套接字；`read-only` 因而需要读侧策略才能表达。
- **控制台隔离不可用。** 以 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 创建的子进程在 DLL 初始化期间以 `STATUS_DLL_INIT_FAILED`（`0xC0000142`）死亡；子进程共享宿主控制台，基于管道的 stdio 重定向不受影响。
- **ACL 授权是对真实目录的驻留改动。** 工作区 ACE 按设计常驻（复用缓存，绝不撤销）；临时 ACE 由 `dispose()` 撤销；手工 `icacls` 清理无法在本平台回收它们（`ERROR_NONE_MAPPED` 1332），请通过本模块回收。
- **被授权目录必须由调用者拥有。** 所有者的隐式 `WRITE_DAC` 是沙箱无需提权即可编辑 DACL 的原因。
- **环境临时根目录绝不会被隐式授权。** 直接调用方必须提供已存在的私有 `tempDir` 及其不同的 `tempWriteSid`，或用 `tempDir: null` 禁用临时写入；实际临时目录不得与任何可写根目录重叠。
- **受限子进程的临时能力按每个活跃的会话/工作区对私有。** runner 在 spawn 之前把 TMP/TEMP 改写为该私有目录；共享同一工作区 SID 的两个令牌无法写入彼此的临时目录。
- **受限令牌下 `whoami` 与令牌检查 cmdlet 会失败。** 子进程对复制令牌的 `GetTokenInformation` 部分不可用，这是诊断噪音而非运行故障。

### 头部验证与源码地图

沙箱拥有的 SID、ACL、令牌、文件与锁声明由 [`verify/abi-probe.cpp`](verify/abi-probe.cpp) 对照 Windows 头文件检查。共享进程、stdio 与 Job ABI 由 [`@deepseek-ai/dsh-win32-process`](../../subprocess/win32-process/README.zh.md#header-verification) 归属并验证。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `AclSandbox`：受限令牌策略、DACL 授权、故障关闭的 spawn 与 dispose |
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
- **宽目录与 FAT 卷警告已推迟；FAT 类目标保持可写。** UI 侧警告尚未实现，FAT 卷作为授权根会大声失败，而授权根之外的 FAT 类目标没有安全描述符，因此在两种受限模式下都可写；FAT 被视为遗留残留。
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
