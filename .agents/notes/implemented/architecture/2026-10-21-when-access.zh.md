# Agent Note: 按访问状态注册的 whenAccess

Status: implemented

[English](2026-10-21-when-access.md) | 中文

## 问题

Client 插件需要按当前 Peer 的访问状态开关自己的注册：侧栏入口、主面板、浮层、数据流。现有 Client 访问面只覆盖渲染：

| 位置 | 现有能力 | 缺口 |
|---|---|---|
| 组件 | `useRemoteAccess(action)`（global）、`useSessionAccess(sessionId, action)`、`useWorkspaceAccess(workspaceId, action)`、会话作用域的 `useAccess(action)` | 只能在渲染时读，答案变化时自动重渲染 |
| JS（`apply`、服务） | `ctx.remoteAccess.source(kind, id, action)` 返回 `HostObservable<boolean>` | 插件要自己读 `getSnapshot`、订阅变化，再手动注册与撤销 |

没有 JS 侧入口时，插件只能在 `apply` 时按身份一次性决定注册与否，授权变化后注册不跟随。

## 决策

### whenAccess

JS 侧有与三个访问 Hook 一一对应的 `whenAccess`，由各自 Hook 的发布者提供：

| 接口 | 提供者 | 对应 Hook |
|---|---|---|
| `ctx.remoteAccess.whenAccess(action, callback)` | remote-access | `useRemoteAccess(action)` |
| `ctx.uiSession.whenAccess(sessionId, action, callback)` | ui-session | `useSessionAccess(sessionId, action)` |
| `ctx.uiWorkspace.whenAccess(workspaceId, action, callback)` | ui-workspace | `useWorkspaceAccess(workspaceId, action)` |

```ts ignore-check
import type { AccessEffect, RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'

/** The global-resource member; the Session and Workspace versions take the resource id first. */
export interface WhenAccess {
  /**
   * Keep `callback`'s effects installed while the current Peer may call `action`
   * on the resource: run it when the answer becomes true, dispose its effects in
   * reverse order when it becomes false, and run it again on the next true.
   * @returns disposer for the observation and any installed effects.
   */
  whenAccess(action: RemoteEndpoint, callback: () => AccessEffect): () => void
}
```

`AccessEffect` 为 `(() => void) | Iterable<() => void, void, void>`。

| 规则 | 内容 |
|---|---|
| 语义 | 与 `ctx.slots.inject` 相同：回调返回一个 disposer 或一组 disposer；一组时按事务安装、逆序撤销；控制器属于调用方 fiber，插件卸载时撤销 |
| 同步执行 | 调用时答案为 true 则回调同步执行；owner 的答案恒为 true，注册顺序与直接注册相同 |
| 快照流失败 | 非 owner 的答案变为 false，已安装的效果撤销 |
| 回调失败 | 调用时安装失败同步抛出；之后重新授权时安装失败，控制器停止并在微任务中抛出 |
| 分层 | remote-access 只认识 global；会话版与工作区版经 remote-access 的底层方法 `whenResourceAccess(kind, id, action, callback)` 实现，与它们用 `source(kind, id, action)` 构造 Hook 相同。`source` 与 `whenResourceAccess` 只由拥有该资源种类的包调用，其他插件只用访问 Hook 与 `whenAccess`，不传 kind。四个入口共用 [`when-allowed.ts`](../../../../packages/api/remote-access/src/client/when-allowed.ts) |

### 插件迁移

| 插件 | 改法 | action |
|---|---|---|
| ui-schedule | 任务列表数据源、删除提示浮层、右栏任务 tab 与标题、主面板、侧栏入口、turn 尾部卡片、会话头部提醒、会话行标记与悬浮列表包进 `remoteAccess.whenAccess`；会话头部提醒读取按会话判定的 `schedule.list`，组件另在会话作用域里用 `useAccess` 决定是否渲染；任务 tab 类型与 turn 定义的注册留在外面 | `schedule/catalog`、`schedule/list` |
| ui-plugin-manager | Host 变更订阅、刷新提示浮层、主面板（含 `pluginNavigation`）、侧栏入口包进 `remoteAccess.whenAccess`，每次授权时刷新已加载过的列表；controller 与 `pluginChanges` 留在外面，撤权期间 `pluginChanges` 不更新。依赖 `pluginNavigation` 的 ui-entry-customization 与 voice-input 改为可选使用：服务不在时隐藏「浏览插件」与「打开 / 查看详情」按钮，插件照常启动 | `pluginManager/listBundles` |
| ui-settings-general | 设置外壳 `sidebar.settings` 与 `settings.open` 快捷键包进 `remoteAccess.whenAccess` | `settings/describe` |
| ui-settings-account | 账号状态流（含默认模型初始化）、额度提醒、设置启动器、账号设置分区与 `settings.models.sign-in` 包进 `remoteAccess.whenAccess`。撤权时账号流的 disposer 同步作废这一轮发出的账号读取，关闭待授权的浏览器标签页，清空账号视图、详情、头像与登录对话框状态，结束本轮奖励提示（提示由该流的帧开始），再关闭流；撤权前已交付但尚未处理的帧被丢弃。提示控制器留在外面，下次授权时重新开始；账号分区等新流的第一帧到达后才出现 | `account/watch` |
| ui-directory-picker-native | 两个目录选择流程包进 `remoteAccess.whenAccess` | `directoryPicker/pick` |
| ui-message-feedback | 消息反馈按钮照常注册，组件在会话作用域里用 `useAccess` 判断是否渲染；`messageFeedback/*` 的请求带 `sessionId`，Gateway 按 `session` 资源的默认字段自动解析为该 Session，无需声明。`/feedback` 装饰不做前端判断：装饰注册表是全局的，而 `sessionFeedback/record` 按会话判定；没有权限时对话框照常打开，提交被 Host 拒绝并显示失败码 | `messageFeedback/put` |
| ui-deliverables、ui-open-in-app | 不动：owner 专用 HTTP 路由读不到时走已有回退 | — |

## 考虑过的替代方案

**插件 `apply` 开头判断 owner 后 return（#6486 的做法）**：按身份写死，授权变化后不跟随。

**按连接裁剪插件列表**：授权变化后插件无法立即重新加载。

**插件包清单声明访问性**：在包清单上定义访问控制概念。

**一个带资源参数的通用方法，或三个版本都挂在 remote-access 上**：业务代码要传 kind，且 remote-access 会出现会话、工作区的资源种类名。

## 后果

| 后果 | 说明 |
|---|---|
| 注册跟随授权变化 | 迁移的插件在非 owner 无授权时不注册相应入口，授予后出现，撤销后消失；owner 的答案恒为 true，注册与直接注册相同 |
| 回调必须交还 disposer | 回调里经插件 `ctx` 注册的效果也挂在插件 fiber 上；不 yield 其 disposer 的注册在失权时不会撤销，只在插件卸载时撤销 |
| 读者拿到全部插件代码 | 插件照常加载；访问由 Gateway 逐次判定，界面由 `whenAccess` 与 Hook 控制 |
| 测试替身 | [`dsh-client-test-runtime`](../../../../packages/test-support/client-runtime/README.zh.md) 的 `StaticRemoteAccess`、`staticAccessPlugin` 与 `TestClientOptions.access` 以固定答案替换 remote-access，供插件测试无权限路径 |

## 相关

- [Peer、principal 与 remote-access](2026-10-12-peer-principal-and-remote-access.zh.md)：本 Note 扩展其 Client 访问面。
