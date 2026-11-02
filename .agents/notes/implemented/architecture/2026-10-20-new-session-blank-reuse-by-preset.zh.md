# Agent Note: 新会话复用空白会话，指定预设时按预设匹配

Status: implemented

[English](2026-10-20-new-session-blank-reuse-by-preset.md) | 中文

## 问题

0.2.0-rc.2 中，新会话（左侧栏按钮、工作区“+”和快捷键，均调用不带选项的 `uiWorkspace.startSession`）复用工作区内第一个空白会话。PR #5775（首次发布于 `dsh-v0.2.1-alpha.2`）改为每次新建 Session 与 Agent，目的是在用户修改预设定义后，新会话按当前定义装配，而不是沿用复用空白会话的旧装配（[升级指南](../../../../docs/upgrade-guide/v0.2.1-alpha.1/new-session-generations/guide.zh.md)）。

空白会话不是当前会话时不在 Session 树中显示，返回它的唯一入口是新会话。改为每次新建后，用户在空白会话中写下草稿、切到其他会话再点新会话，会进入另一个空的 Session；原草稿仍按会话 id 保存在 localStorage，但没有界面入口可以回到它。0.2.1-rc.2 因此丢失新会话的未发送草稿。

此外，创造模式入口（`startSession(…, { agentPreset: 'cordis', prompt, clearPreviousDraft: false })`）复用第一个空白会话并把它切换到 Creator：已有普通草稿时，草稿留在 Creator 模式下，Creator 提示语不会填入；反之新会话也可能接管 Creator 的空白会话。

## 决策

只修改前端（`ui-workspace`），Host 不变：

- 不带选项的 `startSession` 重新走复用分支，与 `openWorkspace`、`connectWorkspace` 和带选项的 `startSession` 使用同一规则。
- `createInWorkspace` 在未开始、未归档、仍属于该工作区的空白会话中选第一个。请求指明预设时，跳过列出的预设（`projectionValues.agentPreset`）为其他值的空白会话，未列出预设的空白会话仍可用；请求未指明预设时任何空白会话都可用，由 Host 切换到默认预设。没有可用的空白会话时由 Host 新建。

结果：新会话回到原来的空白会话，未发送的草稿保留；创造模式等预设流程不会接管列出其他预设的空白会话，用户的普通草稿不会被切到 Creator 下。不新增持久化状态，前端也不读取预设名单。

## 考虑过的替代方案

**完全回退 PR #5775 的这项改动，所有请求都复用第一个空白会话。** 草稿可以回来，但创造模式等预设流程会接管用户普通草稿所在的空白会话，把它切到 Creator，草稿留在 Creator 下，提示语也填不进去。

**保持每次新建，把被丢下的空白会话中的草稿迁移到新会话。** 需要定义多个空白会话时迁移哪一个、附件如何处理、旧会话是否归档，改动和状态都比按预设复用多。

**未指明预设的请求只复用 Host 默认预设的空白会话。** 前端不知道默认预设，需要额外请求 `agentPresets.list()` 名单。

**在前端记录“来源 → 空白会话 id”的映射并持久化。** 与空白会话自身记录的预设重复，需要处理映射过期、按浏览器 origin 隔离等问题。

**预设变化时在原会话上清空草稿（`clearPreviousDraft: true`）。** 会删除用户在另一种模式下写到一半的草稿。

**同时修改 Host，让复用内存中的空白会话时总是调用 `presets.select`。** 能完整保留 #5775 的目的，但不在本次只修前端的范围内，见“推迟工作”。

## 验证

- `ui-workspace` 单元测试：不带选项的新会话回到已有空白会话；未指明预设时复用任何空白会话，指明预设时只复用列出相同预设的空白会话，没有时新建。`navigation.ts` 逐文件覆盖率 100%。
- 回归定位：在 PR #5775 中做出这项改动的提交及其父提交上运行同一单元探针，以及在两侧构建上用浏览器复现，确认草稿丢失由该改动引入。

## 后果

- 新会话不再保证使用当前预设定义：复用的空白会话若其 Agent 仍在 Host 内存中且预设 id 相同，沿用创建时的装配；Host 重启后恢复的空白会话按当前定义装配。
- 新会话可能复用创造模式等预设流程留下的空白会话，Host 把它切回默认预设，其中的草稿保留。
- 升级指南 [new-session-blank-reuse](../../../../docs/upgrade-guide/v0.2.1-rc.2/new-session-blank-reuse/guide.zh.md) 记录相对 0.2.1-rc.2 的行为变化。

## 推迟工作

- Host `reuseLive`（`packages/api/session-controller/src/agent.ts`）在预设 id 相同时直接返回内存中的 Agent，不调用 `presets.select`。`select` 用定义的 `Generation` 对象是否相同判断定义是否重新注册过：相同则不做任何事；不同则在同一会话 id 上按当前定义重新装配并记录 `agent-preset/selected`；会话已开始时抛出 `agent-preset/locked`，调用方改为新建。去掉 `target === current` 的提前返回、改为总是调用 `select`，可以在保留草稿的同时满足 #5775“新会话按当前定义装配”的目的；需要配套 Host 测试，并更新 `reuseLive` 的 JSDoc 和上述升级指南中“不再保证当前预设定义”的说明。
