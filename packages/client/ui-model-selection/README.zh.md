---
description: "Web GUI 的模型选择：/model 弹窗与 composer 模型位共用一份按提供方分组的会话级目录；供模型路由的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)，不包含普通 Web 交互。

## 概述

Web GUI 允许用户通过 `/model` 弹窗或 composer 模型控件切换既有会话使用的模型与推理（reasoning）强度。两个界面呈现同一组按提供方分组的选择；所选模型决定可用的推理强度名称与默认值。完整选择从下一次请求开始生效；运行中的步骤保留其启动时的模型与推理强度。所选模型不可用时，composer 保持停用，直到用户选择可用模型或同一模型恢复可用。

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

DeepSeek 账号和 API Key 路由显示为独立提供方分组，各自展示相同的已配置模型目录。

未选模型文案与可用模型名使用相同的常规字重，并在既有会话与新会话中保留已保存的推理强度显示；调整推理强度需要先选择可用模型。点击未选模型控件直接打开模型列表，Escape 关闭列表。

与 `ui-conversation` 及命令包一起挂载本插件；composer 随即在待处理指示器旁显示模型位，`/model` 则以弹窗打开同一份目录。模型位菜单打开期间，`↑`／`↓` 在根菜单和推理等级行间移动焦点，或在模型列表中移动高亮并让焦点保留在搜索框。Enter 和 Tab 选定高亮模型或聚焦行；Escape 与 `Shift+Tab` 先退出已下钻的面板，否则关闭并回到触发器。下钻时若显示模型搜索框则聚焦搜索框，否则聚焦当前模型或推理强度行，返回则落在打开该面板的格子上。所选模型可用时，composer 显示目录中的模型名称；模型或提供方被删除时（包括账号退登），改为显示已保存的 `provider/model` ID。保存的提供方、模型和推理强度均保持不变。

鼠标选择沿用浏览器原生点击及其取消行为；仅按下按钮不会选定。打开根菜单时聚焦触发按钮，再次点击触发按钮会关闭菜单并把焦点还给它。根菜单行和搜索清除按钮的键盘焦点与悬停使用相同底色，不显示原生焦点轮廓。选定模型或推理等级后，焦点返回触发按钮但不显示焦点环；焦点离开按钮或重新打开菜单后恢复正常焦点提示。等待任一入口发起的选择结果时，焦点停在触发按钮，触发按钮以加载图标代替下拉箭头，该选择包含的值所在行以加载图标代替勾选标记；选择被拒绝后菜单保持打开。显示模型搜索框时，Tab 返回搜索框并高亮当前模型，否则返回当前选中行。

### 模型与推理强度

按钮模型菜单仅在完整目录超过四个模型时显示搜索框；较小目录聚焦当前模型或首行，直接支持键盘导航。`/model` 命令始终保留搜索框。两个搜索框均按模型名称进行不区分大小写的匹配，支持按顺序输入不连续字符，并忽略首尾空格。每个提供方内的结果优先按前缀匹配、其次按匹配得分、最后按目录顺序排列。没有匹配项的分组会隐藏。空目录和无匹配结果均通过状态区域通知屏幕阅读器。方向键在各提供方分组的结果间循环移动高亮，焦点保留在搜索框；Enter 或 Tab 选定高亮项。左右方向键仍用于移动输入光标。打开时高亮当前模型或首个可用选项，修改搜索内容后高亮首个结果。重新打开模型面板会清空搜索内容。

composer 菜单中的模型名称和推理等级均使用 400（regular）字重，包括选中项。搜索框沿用 command 弹窗的紧凑样式，在浅／深色主题下均保持背景和边框透明，不显示前置图标，占位文字使用 caption 色。搜索内容非空时显示清除按钮；点击后恢复完整列表，并将焦点留在搜索框。

两个入口均按提供方分组，DeepSeek 账号排第一，DeepSeek 排第二，第三方提供方保持目录原有顺序。两者采用 [ui-primitives](../ui-primitives/README.zh.md#understand-the-implementation) 异步观察的共享吸顶标题：原位透明，仅吸顶时使用主题的 94% 不透明填充，macOS 桌面端以外使用 `md` 圆角。composer 菜单只显示模型与推理强度名称。导航箭头使用 `--dsw-alias-menu-icon` 文本色。`/model` 弹窗以提供方名称作为分组标题、模型名称作为选项行，不在每行重复提供方，也不显示目录说明。搜索占位文字、无匹配提示和空目录提示与 composer 模型菜单共用同一组本地化文案。弹窗应用所选模型的默认推理强度；composer 随后可以选择任一已公布的推理强度。适配器没有推理元数据时不显示 Effort 行；不存在任意推理强度输入。

展开的控件无法排在同一行时，composer 将模型与推理强度文字替换为模型图标；空间足够后恢复文字。触发器的无障碍名称、提示和菜单仍提供完整选择。

### 不可路由的会话

目录可用性不会阻止使用已保存选择发送消息；请求执行负责报告凭据缺失或模型不可用。刷新及刷新失败期间保留上次显示的选择和分组。Host 重置时清空这些显示。退登后选择器隐藏账号提供方，同时保留已保存的提供方／模型 ID 和推理强度。再次登录且该模型可用时恢复目录名称。既有会话日志保持不变。

### 选择失败

当会话被其他写句柄占用时，模型选择失败提示用户退出其他正在运行的 DSH 后重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

菜单采用共享 `MenuSurface` 材质，包括用于背景模糊的 macOS 底层；自定义内容遵循[菜单规则](../../../docs/web-styling.zh.md#component-rules)。

<details>
<summary>实现细节——点击展开</summary>

composer 的 `ModelSelect` 与 `/model` 选项构建器共用[提供方排序](src/client/provider-order.ts)，两个搜索框均在每个提供方内使用 `rankByName`。命令通过 [popupSelect API](../ui-commands/README.zh.md#use-this-package) 提供可选分组与 `searchMode: 'fuzzy-label'`；两个入口均使用 `MenuGroup`，并在渲染分组变化时重建其吸顶观察器。命令弹窗撑满 composer 浮层，按钮则保留紧凑菜单。

两个入口共用一份由 `ModelDirectoryResolver`（`ctx.modelDirectories`）持有的会话级目录：`/model` popupSelect 贡献项（经 `ctx.commandUi` 注册）与 composer 的具名 `conversation.input.model` 位都经 `session.models` 加载会话的可用目录、经 `session.selectModel` 通过同一个 `ModelDirectory` 实例提交，因此任一入口所做的切换正是另一个入口接下来显示的。目录加载与选择共享一个代次计数器，旧响应不会覆盖新结果。目录把最近一次提交的选择发布为 `pending`，直到它完成或被连接重置作废；连接重置丢弃所有常驻投影，并在显示前重新拉取 Host 恢复的选择。目录按会话惰性解析，随会话作用域一并 dispose（资源释放）；已寻址 subagent 会话不公开任一入口。每份常驻目录都会直接在转发的 `llm/adapters-updated`、`settings/document-updated` 与凭据更新事件上重拉。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当仅了解模型界面还不够时，请阅读以下页面。这些页面从浏览器界面逐步深入到命令弹窗外壳与选择约定。

- [ui-commands](../ui-commands/README.zh.md)——`/model` 贡献项注册进的 popupSelect 外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 composer 的 `conversation.input.model` 位。
- [dsh-agent-default-model](../../core/agent-default-model/README.zh.md)——为从未选择的会话提供默认模型的默认模型服务。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

两个入口提交的 `session.selectModel` 选择会间接影响模型：Host 会在下一次提示词组装边界为完整的 `ModelSelection` 创建快照，并负责使其对模型生效；运行中的步骤则保留已组装的选择。

#### KV Cache 影响

切换路由可能减少提供方侧后续请求的缓存复用，或使其失效；提示词前缀本身不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了当前模型选择界面。它们是当前包约束，不是通用模型路由器对比或任务积压。

- **无创建期或已寻址 subagent 选择**——两个入口都要求既有普通会话的 agent（智能体）；没有可纳入会话创建的草稿阶段模型选择，subagent 继续执行也有意不公开独立的模型选择约定。
- **目录名仅供呈现**——选择与持久化使用提供方／模型／推理强度 id；目录查询或确切模型元数据查询失败的提供方以不可选失败行列出，重新加载前保持原样。
- **不能任意输入推理强度**——composer 仅提供确切模型由适配器公布的推理强度；适配器没有推理元数据时不显示 Effort 行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
