# Agent Note: pwsh 工具与 bash 对齐

Status: implemented

[English](2026-08-02-pwsh-tool-bash-parity.md) | 中文

## 问题

首个 Windows 原生基础交付的 `dsh-tool-pwsh` 是刻意最小的画像——仅前台（每次调用都启动新进程；无持久 PTY 会话）、受管环境只有三个硬编码 `DSH_*` 键、以及一个未声明就偏离 bash 工具的 marker 故事（「恒打 `[exit code: N]`」）。模型可见约定曾与实现脱节：描述承诺了渲染器从未执行的 spill 路径报告，README 宣称了不存在的导出与工具未做的渲染，工具自己的测试还钉死了有损行为。最小画像还让 `DSH_*` contributor seam 因缺席而重复：向 `ctx.shellEnv` 贡献环境事实的插件对 pwsh 调用毫无作用。

## 决策

`dsh-tool-pwsh` 现在逐调用镜像 `dsh-tool-bash`，其模型可见文本精确描述这一行为：

- **渲染行为与 bash 完全一致**：stdout、带标记的 `[stderr]` 段、带 spill 路径的截断通知、空体渲染 `(no output)`、退出 marker 仅限非零退出——干净退出不产生 marker。描述与 `tool:pwsh` 提示词部分精确陈述这一点（「Non-zero exits are reported as `[exit code: N]` markers」），刻意不复制 bash 提示词中与其自身渲染矛盾的「every result」措辞。
- **`run_in_background` 经通用任务运行时接线**，与 bash 工具完全一致：预检、owner 注册、`job_output`/`job_kill` 控制与相同的结果映射。其背后是 `pwsh-local` 早已镜像好的 `start()` 句柄。
- **`DSH_*` 环境共享而非复制**：`ShellEnvRegistry` 从 `dsh-tool-bash` 迁入新的工具无关包 `@deepseek-ai/dsh-shell-env`（`ctx.shellEnv` + 内置事实 + 会话持久化贡献方），两个 shell 工具都注入它。contributor 对 pwsh 调用与 bash 调用一视同仁；因此，共享环境的所有权不属于任何一个面向模型的 shell 工具。
- **Windows 现实在 bash 无对应处钉死**：每条命令都在 UTF-8 输出前置代码下运行，使 Windows PowerShell 5.1 兜底无法经 UTF-8 解码的 collector 破坏非 ASCII 输出；提示词说明 Windows 强制终止以 exit 1 结算，不产生 signal marker。
- **范围外，不变**：持久 PTY shell（后端仅限 Linux/macOS；ConPTY 属路线图）。沙箱升级随 [Windows ACL 沙箱决策](2026-08-08-windows-acl-restricted-token-sandbox.zh.md) 稍后交付——pwsh 工具现在携带沙箱拒绝渲染与同轮次 `sandbox_permissions` 升级面，外加其描述中的 Windows ConstrainedLanguage 约定。带退出 pill 的 pwsh 专属 terminal 卡已随 [pwsh UI 呈现与 bash 对齐](../../archived/feature/2026-08-05-pwsh-ui-bash-parity.md) 决策另行交付。

## 备选方案

**保留最小画像，只修声明。** 否决：从 bash 复制的文本约定在缺少对应实现时会漂移；最小工具加准确声明仍让 pwsh 调用没有后台执行、没有 contributor 对等、并留下一个必须永远重新辩护的偏离 marker 故事。

**在加载时拒绝不匹配的执行器方言。** 合并前尝试过并撤回：在 `ShellExecutor` 上加 `ShellDialect` 标记（`bash` | `powershell`），两个 shell 工具在挂载的执行器说另一种方言时抛错。它迫使每个执行器实现——包括每个测试与示例的 fake——都要声明 dialect，为一道仓内及合理部署中都没有目标可拦的护栏（交付组合总是把 tool-pwsh 配 `dsh-pwsh-local`、tool-bash 配 `dsh-bash-local`）给每个 shell 工具测试添噪。配对约定改由各工具 README 记录。

**提取完全共享的工具实现基座（抽象 shell 方言，两个薄叶子）。** 考虑后推迟：shell-env 提取与结构镜像（`render.ts`/`background.ts` 孪生）是它要立足的基础；在出现第三种方言或持久 PTY 孪生、让抽象的形态可观察之前，不做完整基座。

## 后果

- bash 与 pwsh 工具在前台、后台与沙箱化 shell 工作上行为可互换（沙箱表层由 Windows ACL 沙箱决策负责），渲染器覆盖固定了每一句 pwsh 提示词与描述。
- 对齐也反向发生过一次：pwsh 工具的结构化前台中止（`HarnessError('tool call aborted', TOOL_ABORTED)`，name 为 `AbortError`）被回移到 bash 工具，取代其无码的 `Error('command aborted')`——这是模型可见/入日志的变更，由两侧的精确形状测试与 cancel-tool-calls fixture（测试前置数据）钉住。
- `@deepseek-ai/dsh-shell-env` 成为新的交付包；`dsh-tool-bash` 的 `dshHome` 配置迁往那里，因此挂载 shell 工具的组合也必须挂载 `shell-env`（主干组合包已如此）。
- Windows 专属语义（CRLF 归一化、强制终止 exit-1/signal-null、仅 POSIX 的自信号）一如既往由测试钉住。
- pwsh 工具的逐文件覆盖率门禁由可脚本化的 fake 执行器套件（`tests/tools.spec.ts`）承担；真实 pwsh 的集成与 Loader 组合套件在无 `pwsh` 的宿主自跳过，与 bash 套件的分工一致。
- 路线图提案的 parity 阶段已交付；terminal 卡呈现阶段随 [pwsh UI 呈现与 bash 对齐](../../archived/feature/2026-08-05-pwsh-ui-bash-parity.md) 决策交付（TUI 本身已移除），剩余阶段是 Windows 默认组合。
