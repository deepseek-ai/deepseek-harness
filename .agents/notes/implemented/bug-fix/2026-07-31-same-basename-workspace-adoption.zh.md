# Agent Note: 接纳 basename 相同的 Workspace

Status: implemented

[English](2026-07-31-same-basename-workspace-adoption.md) | 中文

## 问题

Workspace 的身份由其稳定 id 和规范目录路径确定，标题则是可变的显示元数据。然而，只要新规范路径按目录名称派生出的标题与另一个 Workspace 相同，注册表就会拒绝该路径。因此，`/a/xx` 和 `/b/xx` 等常见目录布局无法同时出现在 Web UI 中，尽管[领域设计](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)早已允许标题重复，而且每项客户端操作都通过 id 定位 Workspace。

## 决策

`ctx.workspaceRegistry.create(path, title?)` 仅以规范路径作为唯一性键。重复传入同一路径仍保持幂等，并保留已注册的标题。不同的规范路径会创建不同的 Workspace 记录，且可以共用标题；未提供标题时，每条记录从最终路径段派生标题，该路径段为空时回退到根路径拼写。[Workspace 完全限定路径决策](2026-09-03-fully-qualified-workspace-paths.zh.md)负责规定路径准入和标题回退。

Host 的 `workspace.create({ path })` 接纳入口沿用该规则。Workspace 管理器、选择器、分组树、选择、重命名、删除和 Session 创建仍使用 `WorkspaceId`，因此相同标签既不会合并记录，也不会把操作指向其他记录。需要区分相同标签时，侧边栏悬停详情卡会显示各自的规范路径。

显式命名仍采用更严格的规则。`workspace.rename` 仍会拒绝已注册的标题，具体见[手动 Workspace 命名](../feature/2026-07-25-session-list-browsing-and-manual-order.zh.md)。这既防止用户主动引入另一个难以区分的标签，又允许既有目录名称造成的重名。路径接纳规则仅取代 [Workspace 产品流](../feature/2026-07-25-workspace-ui-product-flow.zh.md)和[原生目录选择器](../feature/2026-07-27-native-workspace-directory-picker.zh.md)中的标题冲突条款。

持久化 schema 未变：Workspace 记录本就分别存储 id、path 和 title，引导初始化可以派生出相同的 basename，启动校验检查的是重复路径而非重复标题。

## 验证

Workspace 注册表与 Host API 测试会在不同父目录下创建两个末级名称相同的真实目录，并断言其 id 和路径互不相同，且持久化顺序正确。选择器组件将相同标签渲染为按 id 区分的独立条目。无密钥 Web 浏览器场景通过组合而成的目录流程接纳这两个目录，并观察到两个 Workspace 均已注册且完成渲染。

## 考虑过的替代方案

**保持标题唯一，并拒绝第二个目录。** 显示标签仍会意外充当身份键，普通的多根目录布局仍无法注册。

**自动为冲突标题添加后缀。** 像 `xx (2)` 这样的生成标签将不再是从目录派生的标题；系统还需要制定跨删除与重载保持稳定的分配规则，并且只为掩盖身份判定错误而增加状态。

**将完整路径用作每个 Workspace 的标题。** 这会消除冲突，却使主导航标签不必要地过长。完整路径仍可在悬停详情中查看，而简洁的 basename 仍有价值。

**也允许显式重命名操作产生重名。** 注册表支持这种状态，但该操作本就是明确要求用户选择显示名称。保留冲突响应可维持现有命名防护，同时不阻止从文件系统选取的路径。

## 后果

两个 Workspace 行可能显示相同的可见标题。id 负责身份，因此两行仍可独立选择和操作；用户可以查看路径或重命名任一行以作区分。显式重命名不能采用另一个行当前使用的标题，即使该标题源自 basename 相同的目录接纳。无需存储迁移或兼容路径。
