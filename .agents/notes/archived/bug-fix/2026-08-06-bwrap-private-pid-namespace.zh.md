# Agent Note: 将 bwrap 与宿主 PID 命名空间隔离

Status: implemented
Archived: 2026-09-30

[English](2026-08-06-bwrap-private-pid-namespace.md) | 中文

## 问题

bwrap 后端挂载了全新的 `/proc`，但保留宿主 PID 命名空间。因此，受约束命令可以看到宿主进程，并沿 `/proc/<pid>/root`、`/proc/<pid>/fd`、`/proc/<pid>/cwd` 等 procfs 魔法链接进入宿主进程的挂载视图。当访问控制允许跟随其中某条链接时，该路径便可越过 profile 对宿主根目录的只读绑定挂载，以及 `workspace-write` 的 allow-list。宿主的 ptrace 限制有时会阻断该路径，但这类取决于部署环境的权限并不构成约束边界。

最初的[沙箱决策](../feature/2026-07-06-sandbox.zh.md)有意维持进程可见性不变，因为 `SandboxMode` 承诺的是文件影响，而不是一般性的进程隔离。对 bwrap 而言，procfs 魔法链接使宿主进程可见性成为文件影响边界的一部分，因此该选择无法维持这些模式承诺的边界。

## 决策

每个 bwrap profile 都使用 `--unshare-pid`，并为该私有命名空间挂载 `/proc`。受约束命令可以观察和控制自己的后代进程，但宿主进程及其 procfs 魔法链接不会出现。Bubblewrap 提供该命名空间的 PID 1 进程，用于回收后代进程。

bwrap 功能探测与实际包装使用同一个 profile builder。因此，无法创建 PID 命名空间的宿主会在选择阶段拒绝 bwrap 并回退到 Landlock，而不是让较弱的探测通过，随后才失败。

这是 bwrap 后端不变式，不是 `SandboxMode` 的新承诺。Landlock 与 Seatbelt 仍保持进程可见性不变，且没有后端限制网络访问。

## 曾考虑的替代方案

- **在保留宿主进程可见性的同时屏蔽部分 procfs 链接。** 每个进程的条目都会动态变化，只覆盖 `root` 仍会留下可通过 `fd`、`cwd`、`exe` 及未来魔法链接进行的等效越界路径。阻止列表无法建立该边界。
- **依赖 ptrace 与 procfs 所有权检查。** 其行为取决于内核设置、容器配置、进程凭据，以及进程是否可转储。同一用户的进程可能仍可访问，因此这些检查只属于纵深防御，不能取代由 profile 建立的权威边界。
- **完全移除 `/proc`。** 常规进程工具和后代进程管理依赖 procfs。私有 PID 命名空间配合对应的 procfs，既能保留这些机制，又不会暴露宿主进程。

## 验证

profile 单元测试固定两个受约束模式均取消共享 PID 命名空间。真实 bwrap 测试验证：两个模式报告的 PID 命名空间标识都与 harness 不同，拒绝通过 `/proc/1/root` 写入，确保宿主目标文件仍不存在，同时仍允许命令观察、终止并等待自己的后代进程。

## 后果

- 受 bwrap 约束的命令无法再检查宿主进程或向其发送信号，包括同一用户的进程。
- `read-only` 与 `workspace-write` 无需再依赖宿主 procfs 访问策略来防止绕过挂载 profile。
- 无法使用 PID 命名空间的宿主会通过现有的失败关闭阶梯，选择下一个受支持的 Linux 后端。
- 此次改变的是内核约束保证，不是模型可见输出、协议或 transcript（文本记录）内容；因此，真实后端 e2e 是组装应用的验收路径，无需修改快照。
