# Agent Note: Windows 持久 PTY 使用 node-pty 自带的控制台宿主

Status: implemented

[English](2026-09-28-pty-bundled-console-host.md) | 中文

## 问题

master 的 `serial / windows (self-hosted standby)` 演练自 2026-09-15 起一直红：`test:coverage` gate 在 `packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` 上失败，形态要么是 `settleReasons` 报出六次 `inferred_idle` 结算里只有一次 `stdin_read`，要么是用例耗尽 120 s 预算。同一个用例在 Blacksmith 的 Windows 镜像上 5.3 s 通过。

Windows 没有精确的 stdin-wait 档：`WindowsProcessInspector.isStdinWaiting()` 恒为 false、`foregroundPgid()` 返回 shell pid，因此 `inspectForeground()` 只能报 `inputWaiting: false`。持久 pwsh 的就绪路径只有在同时看到 OSC `133;D;` 标记与同一次 prompt 渲染写出的可打印 `dsh> ` 尾部之后，才结算 `stdin_read`（`terminal-bash/src/session.ts`）。

直接在池机器上探测（node-pty 1.2.0-beta.15、`pwsh -NoLogo -NoProfile`、160x40、`TERM=dumb`）说明了那个尾部为何在池上匹配不上：命令输出把视口滚动一次之后，Windows 自带的控制台宿主把提示符行重绘成 `\ndsh>\x1b[1C`——一个前导换行、去掉尾随空格的提示符文本，以及代替那个空格的 cursor-forward 转义。`TerminalSanitizer` 累积标记之后的非转义文本，于是尾部成了 `\ndsh>`，既不等于 `dsh> ` 也不构成它的前缀，此后每次 send 都要等满静默档。池机器上七个提示符里有五个是这个形态；同一串命令在 Windows 11 25H2（conhost 10.0.26100.1）上原样渲染出 `dsh> `。[已见标记的尾部宽限](2026-09-27-pwsh-prompt-tail-grace.zh.md)把同一个红信号记为尾部迟到，并为此交付了 `promptTailGraceMs`；本次测量取代了该归因在这类宿主上的适用范围——已经以非前缀形态到达的尾部永远不满足宽限所延长的那个条件。

## 决策

`subprocess-local` 分配 Windows 终端时传 node-pty 的 `useConptyDll: true`，PTY 因此由 node-pty 包自带的 OpenConsole 承载，而不是操作系统提供的控制台宿主。该选项仅在运行时平台为 `win32` 时设置；POSIX 分配不变。

同一串命令在池机器上经由自带控制台宿主时，七个提示符全部渲染出 `dsh> `。

## 备选方案

**依赖为迟到尾部交付的 `promptTailGraceMs`。** 否决：延长的上界只在已到达的尾部仍构成 `dsh> ` 前缀时生效（`terminal-bash/src/session.ts` 的 `tailPending`）。池上的提示符渲染成 `\ndsh>`，在这个比较里不构成任何前缀，因此宽限永远到不了，send 继续按普通静默上界结算。

**让 `TerminalSanitizer` 容忍操作系统控制台宿主的渲染形态。** 否决：把前导换行与 `CSI nC` 归一进尾部能让就绪路径继续工作，但它把一个控制台宿主的怪癖写进 sanitizer，之后任何别的重绘形态都会重新引入同一类偏离。控制台宿主是可替换组件，而包里已经带了当前版本。

**保留操作系统控制台宿主并接受演练长期红。** 否决：这条演练是「自有 Windows 池能接管必需 lane」的唯一持续证据，它已经红了两周。

**升级池机器的 Windows。** 作为本仓库的修法否决：它需要重建生产 CI 主机（Server 2022、Windows 10 22H2），而且任何非最新宿主上这个渲染差异都会回来。

## 后果

Windows PTY 分配现在依赖 node-pty 自带的 OpenConsole 二进制。桌面端运行时文件策略已经保留 `node-pty/prebuilds/win32-x64/conpty/conpty.dll` 与 `OpenConsole.exe`，且包按自身 addon 位置解析它们，因此打包后的桌面运行时仍然可用；该策略现在对终端分配是承重的，不只是为了保留源码分发内容。

控制台信号保持文档化的行为：SIGINT 仍以 `\x03` 输入写入投递、由控制台宿主转成控制台级 CTRL_C 事件，Windows inspector 未变。分配到的进程 id 仍然指向 shell：在池机器上 `pty.pid` 解析为 `pwsh.exe`，且与 shell 自己的 `$PID` 在两种控制台宿主下都相等。node-pty 把 `useConptyDll` 标为实验性，因此 node-pty 升级可能改变它；一条单测钉住该选项：`win32` 上存在、其它平台不存在。两种拆卸路径在池机器上、自带控制台宿主下都会发出 node-pty 的退出事件（`taskkill` 树杀与裸 `kill()` 各约 1.1 s）；解析不到 `conpty/conpty.dll` 时是硬失败——node-pty 直接抛错，不会回退到操作系统控制台宿主。

## 测试

`packages/subprocess/subprocess-local/tests/local.spec.ts` 按平台钉住该选项：`win32` 上存在、POSIX 平台上不存在。池侧的端到端信号是下一次 master push 的 `serial / windows (self-hosted standby)` run——它的 send 将按提示符路径结算，而不是等满静默上界。e2e、snapshot、sandbox 三类不适用：本改动只选择 PTY 后端，本身不产生模型可见或产品用户可见的输出。打包运行时保留了该选项要解析的资产，由 `apps/desktop/tests/runtime-file-policy.spec.ts` 的保留清单断言钉住；Electron payload smoke 在 Windows 上从该树分配 PTY 时也传该选项，因此打包路径与单独钉住的保留清单都会被覆盖。
