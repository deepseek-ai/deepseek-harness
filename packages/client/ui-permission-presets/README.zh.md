---
description: "Web GUI 的权限预设界面：通用设置中的默认行与切换当前会话的 /permission 选择器；供权限策略的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-permission-presets

[English](README.md) | 中文

## 概述

为当前 Web 会话或未来会话选择权限预设。通用设置行只更改之后创建会话所用的默认值；composer 与 `/permission` 选择器切换当前会话。默认 Web 提供仅可查看、工作区内修改与完全权限。显式加载实验 Auto integration 后，当前会话选择器会增加带 `EXP` 标记的 Auto review。通过可见选项选择完全权限或 Auto 时，需要分别确认对应风险；完整的 `/permission <preset>` 命令直接执行。宿主通过 Session 投影确认每次变更。

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

将本插件与 settings、commands 和 conversation 包一同挂载。通用设置获得未来默认值行；composer 获得 `conversation.input.permission` 控件，裸 `/permission` 打开 slash 选择器。当前会话控件同时要求 Session 投影和完整目录快照。不提供权限功能的装配既不公开当前会话控件，也不公开设置行。

### 选择器

选中即提交 `/permission <preset>` 命令行。带参形式（直接键入 `/permission <preset>`）仍直接切换；装饰只替换裸调用。内置标签在英文界面中是 `Read Only`、`Workspace Write`、`Full access` 和 `Auto review`，在中文界面中是「仅可查看」「工作区内修改」「完全权限」和 `Auto review`。显式 host 标签保持原样，未知 kebab-case 名称渲染为 Title Case；`auto` 带有 `EXP` badge，并在可见选择时要求实验风险确认。`custom` 只是显示状态，绝非目标。

实时目录撤销某个预设时，composer 关闭对应的待确认对话框，并用 Session 的当前值替代已不可用的乐观选择。每次目录失效（无 payload 的通知或连接代际变更）会关闭已打开的 slash 选择器或其确认对话框，不消费草稿；而发布某个 picker 正在等待的读取结果时，该 picker 保持打开并保留失败与重试状态；重新打开时读取当前目录。已经提交的命令在响应结束前继续保持忙碌状态。

### 设置行

该行从宿主动态的 `defaultPreset` enum 推导选项，使用与当前会话选择器相同的本地化内置标签，并写入一条设置变更操作。`auto` 等仅限当前会话的 contribution 不会出现。该值只在之后创建会话时生效；改变它绝不会切换或改写当前会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

General Settings 行经 `ctx.settingsScope` 读取显式暴露的 `permission` Settings 描述符，并携带描述符 revision 写入一条 `settings.mutate` 路径操作；其 observable 经 slot 系统的 `hooks` compartment 传递，因此 React 钩子绑定归渲染器，推送失效通知会重新获取描述符。该值只在之后创建会话时读取。当前会话界面是挂在宿主 `/permission` 命令上的 popupSelect 装饰（`ctx.commandUi.decorate`）：宿主命令保留斜杠菜单行、带参形式与持久生命周期记账，装饰只把裸调用替换为选择器。一个进程级目录会在首次 Remote 读取前订阅无 payload 的目录通知，并且只发布当前连接代际中最新的完整成功结果。胜出的读取失败或连接 reset 会清空旧快照：composer seat 因此隐藏，直到后续既有触发重试，而 slash 选择器保持可用并在弹窗内显示失败与重试；旧连接代际与 dispose 后才返回的结果会被忽略。它的公共 observable 是 `{ value }` 与 `invalidations`（每次目录通知或连接代际变更打一个点）；失败仅供命令式加载内部使用。slash popup 与 composer seat 共用这份目录，而 Session `permissions` 投影只提供 `currentValue`。Full access 与 Auto review 各自携带本地化确认文案；Auto 还携带由共享 popup 外壳渲染的 badge。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

需要了解权限界面以外的内容时，请阅读以下页面。这些页面从浏览器界面进一步介绍宿主策略与命令外壳。

- [dsh-permission-presets](../../interaction/permission-presets/README.zh.md)——这些界面写入的宿主侧权限预设策略。
- [ui-commands](../ui-commands/README.zh.md)——`/permission` 装饰注册进的 popupSelect 外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——把这份共享目录与 Session 当前值合并的 composer seat。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接影响。它的两个界面写入权限事实：设置行使未来会话带着全量值旋钮事件启动，而 `/permission` 选择器追加选中的当前会话预设。沙箱与审批消费方各自解析自己的旋钮事件；选择 `auto` 还会启用宿主 Auto integration 的独立逐调用 reviewer。

#### KV Cache 影响

无直接失效；请求前缀的变化由旋钮消费方自行承担。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前权限界面。它们是当前包约束，不是通用策略对比或任务积压。

- **设置行仅限 Web**——非 Web 客户端仍可经 `/permission` 切换当前会话，但不会获得这项浏览器贡献。
- **Auto review 仅限当前会话**——General Settings 行有意省略它，且只有通过可见选择器选择时才显示实验确认；显式键入 `/permission auto` 已经构成明确同意。
- **预设描述来自宿主**——本地化的内置标签旁边可能显示另一种语言编写的描述。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。命令与 slot 贡献的生命周期由 HMR（热模块替换）安全性测试验证；浏览器侧设置控制器不持有宿主事件或跨插件可变状态。
