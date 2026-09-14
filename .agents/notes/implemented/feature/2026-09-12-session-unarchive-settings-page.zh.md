# Agent Note: Session unarchive Settings page

Status: implemented

[English](2026-09-12-session-unarchive-settings-page.md) | 中文

## 问题

归档会话会把它从每一个 Workspace 分组界面中移除，而没有任何东西能把它带回来。归档集合是持久的显示过滤器，因此被隐藏的会话保留其日志、Workspace 记账位置与所在位置，但唯一的恢复途径是手工编辑领域状态。归档功能记录把恢复界面预测为「一个 UI 界面加一个反向 RPC」；两者如今都已存在，而 Client 此前根本没有列出已归档会话的地方。

## 决策

`WorkspaceRegistry.unarchiveSession(sessionId)` 在一次持久化 `setState` 中把某个 id 从注册表全局的 `archivedSessionIds` 集合里移除，并与 archive、create、delete 跑在同一条操作链上。幂等的「先检查再写入」位于同一个链槽内，因此并发归档无法插入其间，输掉竞态的一方会解析为无操作。未被归档的 id 不写盘即解析完成。

取消归档不做会话存在性探测。归档会校验会话处于实时或已持久化状态，因为它加入的引用必须可解析；取消归档只是移除一个 id，因此不可能引入未知引用，会话已不存在的条目也仍然能恢复。`WorkspaceController` 上的 `@Remote('unarchiveSession')` 返回完整的 `WorkspaceArchiveValue`，与 `archiveSession` 一致，而 `IWorkspaces.unarchiveSession` 与 `UiWorkspace.unarchiveSession` 把该动词带到浏览器。两个动词都返回完整集合，因此 `ClientWorkspaceModel` 只在该应答仍是最新归档集合请求时安装它：更晚的请求或 follow 流推送的集合都会取代在途应答，让投影停留在更新的状态上。

新的 Web 设置页 `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` 拥有该界面。它注册一个 id 为 `archived-sessions`、导航顺序为 25 的本地化 `settings.section` 贡献，把来自 `useWorkspaces` 的归档集合与来自 `useSessions` 的已加载 Session 摘要合并，按归档时间由新到旧列出，并显示为其记账的 Workspace 标题或未分组标签，以及相对最近活动时间；它按标题或 Workspace 名称过滤，并为每行提供一个取消归档操作。写入被拒绝时会记录一条 console 诊断，并保留该行以便再次尝试。缺失 Session 摘要的归档条目不产生行，因此该页面绝不会渲染无法恢复任何东西的操作。

恢复操作所在的页面以已归档会话为主题，而已归档会话本身从每一个分组界面中隐藏，因此没有任何 Session 行能承载该操作。「已归档会话」页在设置导航中与「通用」「模型」「插件」并列，而该导航轨道本就带有本页在 `SettingsRoot` 中声明的归档字形。

`{ type: 'archived', archivedSessionIds }` follow 增量本就携带完整集合，因此恢复复用它：Remote 应答在本地安装，其他每个 Client 都通过同一个增量收敛。该动词不伴随任何帧类型、持久字段或 `SESSION_FORMAT_VERSION` 变更。

## 考虑过的替代方案

**在 Session 行菜单放一个取消归档操作。** 行菜单拥有 Archive，但被恢复的会话在恢复之前没有可见的行，因此该操作在真正需要它的状态里无处安放；给每一行加一个禁用条目只是没有主体的装饰。

**新增一种携带移除增量的帧类型。** 现有的 `archived` 增量是完整集合替换，因此移除增量会增加一种每个消费方都必须合并的冗余表示；正是全快照姿态让归档回声得以原样复用。

**把会话已不存在的归档条目渲染为禁用行。** 这样的行可以解释缺口，却无法恢复任何东西，而注册表与 Remote 仍然接受该 id，因此该页面只列出它能操作的条目，把遗留 id 留给未来的清理界面。

**像归档一样，在取消归档时做会话存在性探测。** 该检查的存在是为了让新增的引用保持可解析，而移除不可能破坏这一不变式；探测只会把恢复已删除的历史变成一次无从修复的失败。

## 后果

归档集合仍是恢复唯一重写的持久状态；`workspace` 领域版本、会话日志与 Workspace 记账位置都不受影响，被恢复的会话回到其记录的位置。归档与取消归档现在执行不同的会话校验，这是刻意的不对称，并记录在 [Workspace registry 的限制](../../../../packages/workspace/workspace/README.zh.md#known-limitations-and-deferred-work)中。

恢复界面受该页面能显示的内容限制：摘要未加载的已归档 id 没有行也没有取消归档操作，尽管注册表方法与 Remote 都接受它；因此页面报告没有可恢复条目，而不是把归档集合说成空的。通过自动化恢复仍然可用，未来的清理界面可以处理剩余的遗留条目。

## 测试

`packages/workspace/workspace/tests/workspace.spec.ts` 固定注册表方法：移除后幸存的归档顺序保持不变、记账位置仍在、重复取消归档与从未归档的 id 既不重写介质也不发出变更、会话已不存在的条目无需持久化列表即可解析、幸存集合在重启后重新加载。`packages/api/workspace-controller/tests/workspace-controller.host.spec.ts` 固定该动词幂等的完整集合应答与不变的 `archived` follow 增量，`packages/api/workspace-controller/tests/model.client.spec.ts` 固定 Client model 的回声及其拒绝安装失败应答的行为，以及四种过期应答竞态：归档或取消归档请求重叠且乱序返回，以及应答在途时到达的 follow 增量或 baseline。`packages/client/ui-settings-unarchive-sessions/tests/components.client.spec.tsx` 固定由新到旧的排序、未分组标签、会话已不存在条目的隐藏、读取与空状态、搜索，以及被拒绝时的 console 诊断，`tests/browser-plugin.client.spec.tsx` 则固定分区注册。

## 相关

- [会话归档（注册表全局集合）](../../archived/feature/2026-07-31-session-archive-global-set.md)——归档集合、follow 增量与被预测的恢复界面的冻结记录。
