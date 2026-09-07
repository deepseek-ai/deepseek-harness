# Agent Note: 已交付界面的 workspace-write 默认值

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-workspace-write-surface-default.md) | 中文

## 问题

已交付的终端和浏览器界面在两套不同的无约束组合下暴露相同的编码工具。Web 挂载了沙箱与权限服务，却选择 `danger-full-access`；TUI 则直接挂载不受限的本地 bash 与文件系统提供方。因此，在用户主动选择这类权限之前，全新的编码会话就能修改其同 UID 进程可达的任意路径。

## 决策

[`base.cordis.yml`](../../../../packages/bundle/base/cordis.patch.yml) 为所有已交付的 TUI、Web 以及由浏览器支撑的无头会话统一持有一套沙箱与权限栈：`dsh-sandbox-local`、`dsh-sandbox-policy`、`dsh-bash-sandbox`、`dsh-fs-sandbox`、`dsh-user-approval` 和 `dsh-permission-presets`。组合回退值为 `workspace-write` preset，其中包含 `workspace-write` 文件效果模式与 `ask` 审批策略。`DSH_PERMISSION_MODE` 仍是显式的进程级覆盖；已存储的 `permission.defaultPreset` 仍是面向后续会话的用户偏好，并通过 Settings seam 优先于该回退值。

真正的新会话会在执行前固定 `permission/preset: workspace-write`、`sandbox/mode: workspace-write` 和 `approval/policy: ask`。现有会话和恢复的会话保留日志中记录的权限，更改「通用」设置中的默认值只影响之后创建的会话。浏览器保留 Access 选择器、可应答的审批卡片，以及选择 Full access 时的风险确认。共享 Permission 服务在 TUI 中激活其命令子件，因此 TUI 会获得现有的 `/permission` 命令。

该模式只管辖文件效果。受沙箱约束的 bash 与文件系统修改只允许写入会话工作区和平台临时根目录；读取、网络访问与进程可见性仍不受该策略约束。若没有平台 runner 能强制执行受限的 bash 调用，执行会以拒绝告终，不会退回不受限命令。

## 测试

已交付 TUI 的无密钥伪终端冒烟测试会启动真实 Loader 树，读取已持久化的首个请求，并断言 bash schema 中的 `sandbox_permissions`／`justification`，以及初始的 workspace-write 事件三元组。已交付 Web 组合的冒烟测试断言相同的策略、审批与 Permission 默认值。组装后的浏览器 Settings 快照打开时选中 Workspace Write，在更改后续会话默认值时保持现有 `workspace-write` 会话不变，并仍然验证经确认后选择 Full access 的路径。

## 曾考虑的替代方案

**将沙箱栈留在 `web.cordis.yml`，并在 `tui.cordis.yml` 中复制一份。** 不予采纳，因为插件标识、preset、回退值与执行器替换完全相同。两份副本会让安全默认值依赖两个界面覆盖层持续同步；共享 base 才是它们的唯一归属。

**保留不受限的 TUI，只更改浏览器回退值。** 不予采纳，因为这会保留无法解释的界面差异，并让全新的终端会话继续拥有本决策要移除的权限。

**在同一次变更中添加终端审批对话框。** 不予采纳，因为这是另一个交互与生命周期决策。TUI 没有 `approval/request` 应答者，因此一次性自动升权当前会落定为不可用并以拒绝告终；需要更宽权限的用户可以通过 `/permission` 主动选择其他 preset。

## 后果

全新的会话无需额外提示即可修改当前工作区与临时根目录，尝试修改其他位置则会在触及目标前被拒绝。Full access 仍可通过显式选择获得，浏览器选择时也仍会显示确认对话框。系统不会重写已存储的用户默认值和会话日志中记录的权限。

由浏览器支撑的无头入口继承 Web 组合，因此默认值相同。TUI 缺少审批应答者是本次变更的明确限制：自动请求更宽权限的重试会在那里以拒绝告终，而不会显示权限询问。
