# Agent Note: 新会话的权限 Settings 默认值

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-permission-default-for-new-sessions.md) | 中文

## 问题

Web「通用」设置页将「权限」显示为禁用的骨架控件，尽管 `dsh-permission-presets` 已经拥有 preset 表和当前会话的切换路径。Settings seam 可以持久化由插件拥有的值，但 Web Settings API 只暴露可配置 LLM（大语言模型）提供方的 namespace。更重要的是，如果把用户偏好当成实时生效的全局权限，现有会话的执行策略就会在其持久日志之外发生变化。

## 决策

`dsh-permission-presets` 拥有一个 `permission` Settings namespace，其中只有 `defaultPreset` 字段。它的基础值是 `Config.defaultPreset`；省略该配置时，则使用与组合后的沙箱和审批默认值匹配的 preset。schema 的 enum 从已配置的 preset 表派生，因此 Settings 既能校验已存储的值，Web 客户端也能发现部署中的实际选项，而无需重复定义。

服务会在 `session/created` 时同步读取当前 Settings 值。真正的新会话会收到三个显式事件：`permission/preset`、`sandbox/mode` 和 `approval/policy`。这些事实将创建时选中的权限固定下来，因此后续 Settings 变更只影响之后的会话。带 seed 或只完成部分初始化的会话会保留其有效调节项，只补齐缺失的事实；恢复时绝不会采用最新的用户默认值。`Session` 甚至会用 `session/end-seed` 标记显式为空的构造器 seed，因此不能把空的持久化日志误认为新会话。`permissions` 投影把该边界与三个权限事实一同折叠，使会话固定只读一份增量状态，无需重扫日志。

现有 `/permission` 命令和 `permissions` 投影仍是当前会话的操作路径。浏览器插件现在向 `settings.general.item` 贡献「权限」行，从脱敏后的 Settings 描述符读取动态 enum，并只通过经过 revision 校验的 `settings.mutate` 写入 `defaultPreset`。该行通过 slot 的 `hooks` 格注入 observable，而不是绑定渲染器专用钩子；权限服务挂载时会遍历并固定所有已存活会话，因此 HMR（热模块替换）不会遗留未固定的会话。无归属的「通用」设置包不贡献任何占位行。

Settings Controller 通过脱敏的 Remote 视图暴露已注册的 `permission` namespace。这是局部的呈现决策，而不是通用注册标志或 `local-client` 访问模型。权限变更通过转发的 `settings/document-updated` 到达客户端（[转发的 Remote 事件](../architecture/2026-08-10-remote-event-delivery.zh.md)），不会宣告模型拓扑。

## 后果

在 Settings 中更改「权限」会立即更新 `settings.yaml` 和选择器，但不会改变已打开的会话。之后的每个会话都可以从三个已固定的权限事实中重建，即使用户再次更改默认值或进程重启也不受影响。如果部署中组合后的沙箱和审批默认值与任何 preset 都不匹配，则必须显式配置 `defaultPreset`。

组装后的 Web 快照包含功能完整的「权限」选择器。其无密钥浏览器场景会写入 `read-only`，验证现有的 `workspace-write` 会话保持不变，并验证随后创建的会话以 read-only 事件三元组启动。

## 曾考虑的替代方案

**将 Settings 值实时应用于每个会话。** 不予采纳，因为执行策略会在没有会话事件的情况下改变，回放也无法重建先前工具调用采用了哪种权限。

**创建时只记录 `permission/preset`。** 不予采纳，因为沙箱和审批是由不同组件独立拥有的全量值调节项；固定全部三个事实，可以让其消费方不依赖未来的组合默认值变化。

**暴露所有 Settings 注册，或增加通用的 `local-client` 声明。** 本次变更不予采纳，因为这会扩大安全边界，并使 Settings 约定超出所请求的单项偏好。显式加入 `permission` allowlist 已足够，未来的 namespace 可以各自决定是否暴露。

**恢复带 seed 的会话时应用最新默认值。** 不予采纳，因为恢复操作必须保留会话先前的有效执行策略；缺失的旧版事实应从该策略中补齐。
