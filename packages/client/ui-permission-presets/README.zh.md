---
description: "Web GUI 的权限预设表面：通用设置中的默认行与切换当前会话的 /permission 选择器；供权限策略的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-permission-presets

[English](README.md) | 中文

## 概述

本包为 Web GUI 中两种生命周期提供权限预设表面：通用设置中的一行选择之后创建会话所用的默认值，但不会切换当前会话。挂在宿主 `/permission` 命令上的选择器通过一张扁平预设列表切换当前会话，并标记 active 值。规范内置名称渲染为 locale 所有的产品标签，显式 host 标签保持原样，未知 kebab-case 名称渲染为 Title Case。选择完全权限时，该行或选择器写入前必须先显式确认风险。两个表面读取同一份宿主计算的投影、经同一条路径写入，因此推送的投影帧是两者共同跟随的唯一确认。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与设置与命令包一起挂载本插件；权限行随即出现在通用设置中，`/permission` 选择器替换裸命令调用。当前会话选择器恰在投影 key 存在时可用；无权限组合既不显示选择器，也不显示设置行。

### 选择器

选中即提交 `/permission <preset>` 命令行。带参路径（直接键入 `/permission <preset>`）仍直接切换；装饰只替换裸调用。内置标签在英文界面中是 `Read Only`、`Workspace Write` 和 `Full access`，在中文界面中是「仅可查看」「工作区内修改」和「完全权限」；`custom` 只是显示状态，绝非目标。

### 设置行

该行从宿主动态的 `defaultPreset` enum 推导选项，使用与当前会话选择器相同的本地化标签，并写入一条设置变更操作。该值只在之后创建会话时生效；改变它绝不会切换或改写当前会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

通用行经 `ctx.settingsScope` 读取显式暴露的 `permission` Settings 描述符，并携带描述符 revision 写入一条 `settings.mutate` 路径操作；其 observable 经槽位系统的 `hooks` 格传递，因此 React 钩子绑定归渲染器，推送失效通知会重新获取描述符。该值只在之后创建会话时读取。当前会话表面是挂在宿主 `/permission` 命令上的 popupSelect 装饰（`ctx.commandUi.decorate`）：宿主命令保留斜杠菜单行、带参路径与持久生命周期记账，装饰只把裸调用替换为选择器。选项与 active 标记读取会话的 `permissions` 投影——与 composer chip 渲染的同一份宿主计算 select。完全权限选项携带 `confirmation` 载荷，由共享弹窗外壳渲染为页内风险门。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当权限面不够用时阅读以下页面。它们从浏览器表面进入宿主策略与命令外壳。

- [dsh-permission-presets](../../interaction/permission-presets/README.zh.md)——这些表面写入的宿主侧权限预设策略。
- [ui-commands](../ui-commands/README.zh.md)——`/permission` 装饰注册进的 popupSelect 外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——渲染同一份权限投影的 composer chip。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接影响。它的两个表面写入权限事实：设置行使未来会话带着全量值旋钮事件启动，而 `/permission` 选择器切换当前会话时追加相同的事实；这些事件决定后续工具调用解析到的沙箱模式与审批策略。

#### KV Cache 影响

无直接失效；请求前缀的变化由旋钮消费方自行承担。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前权限表面。它们是当前包约束，不是通用策略对比或任务积压。

- **设置行仅限 Web**——非 Web 客户端仍可经 `/permission` 切换当前会话，但不会获得这项浏览器贡献。
- **预设描述来自宿主**——本地化的内置标签旁边可能显示另一种语言编写的描述。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。command 与 slot contribution 的生命周期由 HMR 测试覆盖；浏览器侧 Settings controller 不持有 Host 事件或跨插件可变状态。
