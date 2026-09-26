---
description: "Web GUI 的客户端命令 API：/ 命令 source、三类派发、会话级命令目录，以及面向业务包的 popupSelect 与 action 注册；供斜杠命令的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-commands

[English](README.md) | 中文

## 概述

键入 `/` 命令会打开已注册的弹窗、运行客户端动作、进入宿主命令的输入或直接执行，命令行不会被静默降级为普通提示词。业务包通过 `ctx.commandUi` 注册 popupSelect（`/model`、`/permission`）或 action，也可用这两种方式装饰既有宿主命令，同时保留其目录行与参数声明。空格与回车根据会话目录解析命令行：带 `input` 的宿主描述符是 `leadingInput`，注册了 `CommandUiSpec` 的是 `popupSelect` 或 `action`，其余是 `execute`。

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

与 `ui-input-trigger` 及 `ui-conversation` 一起挂载本插件；`/` source 随即出现在触发菜单中，业务包经 `ctx.commandUi` 注册自己的命令表面。键入 `/model` 打开已注册的弹窗；带参数声明的宿主命令打开其输入或直接执行。弹窗持有 composer 焦点：键入即在已加载的行上本地筛选，`↑`／`↓` 在行间移动，回车与 `Tab` 接受高亮行，Escape 与 `Shift+Tab` 把焦点还给 composer。高亮落在选项标记为会话当前值的行上，因此在刚打开的弹窗上接受即确认当前值。composer 的 `+` 按钮与键入的 `/` 打开同一个菜单：「添加」小节（文件、目标、计划、反馈）与「指令」小节（压缩、权限、模型、下载日志）按使用频次排列，每行带图标、本地化的标题与说明，本地化标题与命令名不同时还显示命令名作为别名。

### 种类与装饰

贡献项是客户端自有命令，与宿主命令同名会明确报错。它的 UI 是 popupSelect 规格或动作：裸调用消费触发 token 后运行回调，不提交消息。业务包负责自己的动作及可用性，输入框通过同一 API 注册「文件」。装饰为已有宿主命令添加裸调用弹窗或动作，并保留其目录行、参数认领与生命周期记录；没有匹配的宿主行时不触发。菜单查询按顺序、不区分大小写地模糊匹配命令名与标题的子序列，前缀优先，不显示小节标题。

### 内置行的展示面

内置命令定义携带稳定的 `definitionId`。客户端按标识选择本地化标题、说明、图标和输入写法，修改宿主说明不会改变选择结果。没有匹配标识的同名覆盖保留自己的文案，也不获得内置别名。在任何界面语言下，中英文写法都通过同一个会话有效目录解析，草稿保留手输写法，提交使用宿主注册名。贡献项提供自己的 `label`、`description` 和 `icon`，每次生成候选项时读取。空查询按名称确定小节顺序，未列出的行排在「指令」末尾。

### 带附件提交

composer 携带图片或通用文件提交时，只有声明了 `input.attachments` 的宿主命令继续。其余命令路径都会抛出本地化的 `attachmentsUnsupported` 拒绝，以瞬态 toast 呈现，草稿与附件卡保持原位。处理器出错时保留相同草稿状态供用户重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

菜单采用共享 `MenuSurface` 材质，包括用于背景模糊的 macOS 底层；自定义内容遵循[菜单规则](../../../docs/web-styling.zh.md#component-rules)。

<details>
<summary>实现细节——点击展开</summary>

`src/client/contract.ts` 定义贡献项和装饰的注册接口，以及 `dismiss(name)`：它关闭该命令已打开的弹窗与确认对话框，中止待完成的选项加载，阻止晚到结果重新打开弹窗，并保留 composer 草稿。`CommandDirectory` 负责会话级协议缓存，并通过 `resolution.ts` 解析输入命令；该模块负责内置命令标识匹配和本地化输入写法。`matchSpace` 同步读取就绪缓存，`matchEnter` 等待缓存就绪，预热失败或取消时拒绝。转发的目录和连接事件使缓存失效。宿主执行匹配的命令后，本浏览器发布 `command/executed`，其他客户端只观察持久命令事件。`PopupSelectController` 负责弹窗状态，`PopupSelectView` 占据输入浮层。`presentation.ts` 负责行标题、图标和分节，展示与解析辅助函数均留在插件内部。

每次命令目录拉取都要求客户端已持有该会话，并等待首次历史打开成功后才发送 `commands.list`。临时的 `commandCatalog` 引用持续持有会话，直到拉取结束。未被持有的会话或打开失败会直接拒绝，不发送 RPC，因此后台目录刷新不会重新打开已关闭的会话。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

如果仅了解命令交互还不够，请阅读以下页面。它们从命令 API 进入触发流水线与宿主命令注册表。

- [ui-input-trigger](../ui-input-trigger/README.zh.md)——`/` source 注册进的流水线。
- [ui-conversation](../ui-conversation/README.zh.md)——声明输入浮层 slot 并拥有 composer。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

派发路径通过其触发的宿主 `command.execute` RPC 间接影响模型：每个命令 handler 的宿主包拥有任何模型可见效果（`/plan` 的 handler 翻转 plan 模式，其归属包注入 policy 段），而命令行、分离结果与所有菜单和 notice 渲染都留在客户端，永不进入会话日志。

#### KV Cache 影响

无直接影响；该包既不组装也不发送提供方请求。它触发的命令 handler 可能改变归属宿主包对下一个请求系统提示词的贡献——某个 section 的出现或消失会替换较早的请求 token，并使提供方前缀从该点起失效——但这一影响由各命令的宿主包拥有并记录。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前命令交互方式。它们是当前包约束，不是通用命令行对比或任务积压。

- **脱离会话后，分离结果 notice 回退到 console**——fire-and-forget 路径经 `SessionInput.notify` 把结果送到触发会话的 composer；会话销毁后，console 输出行是仅剩的呈现面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是基于 wire 命令目录的浏览器侧 source，不发出 Cordis 事件，也不持有跨插件可变状态；dispatch 与 cache 行为由包测试覆盖。
