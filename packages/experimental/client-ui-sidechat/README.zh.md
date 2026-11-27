---
description: "/side 命令在对话最后一个已完成回合处分支出侧栏对话并在右侧栏打开，作为可选的实验插件。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-sidechat

[English](README.md) | 中文

## 概述

为输入框添加 **/side** 命令。它通过普通的 Session fork 在最后一个已完成回合处创建分支，并在当前屏幕上对话的右侧栏中以 tab 打开子对话，包含 Chat 视图、输入框和消息操作。子对话 Session 记录 `origin: 'side'`，因此左侧栏不列出它。默认 profile 不安装此插件。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将插件加入已初始化的 Web profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-client-ui-sidechat
```

[补丁](cordis.patch.yml)在 Web 各层之后加入 `ui-sidechat` 行；没有配置项。用 `dsh plugin --profile web remove @deepseek-ai/dsh-client-ui-sidechat` 移除；已创建的 Session 仍可通过普通历史访问。

**/side** 出现在输入框的命令菜单中，并且始终作为命令被消费，因此输入的 `/side` 不会作为消息发给模型。它像普通 fork 省略切点一样分支，由 Host 选取最后一个已完成的回合及其后的独立事件；正在运行的回合留在来源中。Host 拒绝没有已完成回合的对话（例如空会话或仍在第一个回合中的会话），插件提示当前会话没有已结束的轮次。子智能体会话会提示不能创建侧栏对话：它的子对话会继承委派的审批策略和 preset，却没有委派关系本身。每次 `/side` 都创建各自的侧栏对话。侧栏对话作为 tab 在屏幕上对话的右侧栏中打开；在侧栏对话中执行 `/side` 会把新的子对话加到它旁边，而不是嵌套在里面。**分支到新对话**保持原有行为，并把主区域导航到子对话。

侧栏 tab 以分支图标显示子对话的实时标题，并像 subagent 侧栏聊天一样渲染 Chat 视图、输入框和消息操作；没有 Session 头部和视图切换。子对话像普通 fork 一样获得带编号的标题。关闭 tab 只关闭当前窗口的 tab；Session 及其历史仍然保存，但左侧栏不列出它们。已保存的 tab 在重新加载后重新打开；无法再保留其 Session 的 tab 会就地显示失败信息。

创建失败时在窗口顶部显示短暂通知；来源对话保持不变。编号标题设置失败的子对话仍会打开。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts) 是惰性的 Host 发现入口；插件不添加 Host 服务、Remote 或 Session 事件。[Client 入口](src/client/index.ts)通过 `commandUi` 注册 `/side` 命令、`shell.overlay` 中的根失败通知、`sidechat` 资源提供者、`sidechat` 侧栏 tab 类型及其正文和标题。[控制器](src/client/control.ts)不传切点、以 `increaseTitle` 调用 `sessions.fork`，然后对用户操作时屏幕上的 Session 调用 `sidebarRight.openResourceIn`；若该主 Session 的 store 已释放，打开操作不做任何事，子对话仍保留在列表中。[资源提供者](src/client/resource.ts)在 tab 生命周期内带 `conversation` facet 保留子 Session，并对格式错误的地址或获取失败产生失败帧。[tab 正文](src/client/views.tsx)通过 `SessionProvider` 绑定保留的引用，并以 `embedded` 变体、固定 Chat 视图且不显示 Hero 渲染 [`ui-conversation`](../../client/ui-conversation/README.zh.md) 的 `conversation.content` Factory。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [实验包](../README.zh.md) — 发布与隔离策略。
- [Conversation UI](../../client/ui-conversation/README.zh.md) — 侧栏 tab 渲染的 `conversation.content` Factory。
- [右侧栏](../../client/ui-sidebar-right/README.zh.md) — tab 类型、资源地址与保存的窗口布局。

-----

<a id="model-experience"></a>
## 模型体验

无，此插件不添加面向模型的输入：子对话是普通 fork，其继承前缀已由 Session fork 记录。

#### KV Cache 影响

无；此包不修改模型请求。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

- **窗口本地 tab** — 打开的侧栏 tab 属于当前窗口保存的侧栏布局；连接同一 Host 的另一个窗口不显示子对话。
- **左侧栏没有入口** — 子对话 header 把来源记录为 `parentSession`，但左侧栏不列出侧栏对话；关闭其 tab 后，那里没有重新打开它的入口。
- **fork 响应丢失** — 如果 Host 创建子对话后响应丢失，子对话仍然保存，但没有打开的 tab 和左侧栏行，通知会报告失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
