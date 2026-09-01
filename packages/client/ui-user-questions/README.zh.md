---
description: "dsh Web 客户端的 ask_user_question 功能：接管编辑器的提问 UI 与 plan-review 审批卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-user-questions

[English](README.md) | 中文

## 概述

`dsh-client-ui-user-questions` 是 Web 提问功能插件：其浏览器侧把 `question` 条目注册到会话拥有的 `conversation.composer` chain 中，因此当 agent 向用户提问时，编辑器会被提问 UI 接管。组件每次渲染一个问题，提供进度导航、单选与多选选项、推荐徽标与自定义答案，并为整个请求提交一批结构化答案。若某个请求的唯一问题声明了呈现意图，则改为渲染该意图自己的界面——最典型的是 `plan-review` 等待审批卡片，带 `Chat about it` / `Refuse` / `Approve`。其主机侧刻意为空：在那里挂载 `dsh-tool-ask-user` 会把工具放进注册表的全局层，并把它并入每一个 agent，无论它由哪个 preset 组装。

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

当 agent 提问时，编辑器变成提问界面：回答每个问题、用翻页器导航，或跳过它。选择单选选项后会立即前进；Enter 继续流程，并在所有问题均已回答或跳过后提交，而 Shift+Enter 改为换行（IME 组合输入期间按 Enter 只会确认输入候选，不会前进）。

### 作答

用户打开或编辑自定义答案时，多选题草稿会保留已选中的标签，因此提交项可以同时携带 `selected` 与 `custom`；单选题的自定义答案仍保持互斥。问题详情复用助手输出的 `MarkdownText` 原语，包括其 GFM 渲染与不受信任内容策略。限高卡片保持标题、导航与提交动作固定，超长的详情与选项共享内部滚动区。「跳过此问题」会保留其他草稿，并为该项发出既有的空 `{ selected: [] }` 结果；关闭则以 `ASK_CANCELLED` 拒绝整个等待。

### plan-review 卡片

`plan-review` 意图——由 `dsh-plan-mode` 在 `exit_plan_mode` 审阅上设置——渲染等待审批卡片的布局：一条 `Plan review` 条带、计划作为可滚动的 markdown 主体，以及一行 `Chat about it` / `Refuse` / `Approve` 的决定操作。Approve 与 Refuse 用提问方自己的选项标签回答；`Chat about it` 以 `ASK_CANCELLED` 拒绝该等待，让编辑器归位，用户可以直接说出他想说的话。

### 失败与恢复

通用提问流程把当前题号、已选标签、自定义文本和显式跳过状态保存在非持久化 Slot store 中；该 store 归属对应 Session，并以待处理请求的本地渲染标识为 key。从 Session A 切换到 B 会重新挂载严格 Session 级编辑器条目，但返回 A 时会复用 A 的 store 并恢复未完成草稿。不同的请求标识读取空草稿，并在首次编辑时替换旧值；成功回答或取消会清除相符的值。请求是否仍在等待由主机保持权威。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包是一条归属规则：渲染提问是宿主的 UI 能力，拥有该工具则是 agent 的能力，因此 `tool-ask-user` 行属于需要它的各个 preset（以及没有 preset 的 TUI 组装）。

### 意图表面选举

卡片只在能够发出该请求允许的每一个答案时才接管：只有一个问题、声明了意图、计划以 `detail` 存在、提供了被指名的批准标签，且是二元单选（除批准外最多一个选项，且非多选）。其他任何情形都留在能够表达它的通用流程上。意图改变的只是布局，从不改变可达的答案。

### 文案与 locale

编辑器外框文案（翻页器、按钮、占位符、校验提示）是双语的：插件在 `dsh-client-locale` 的 `question` 命名空间下注册 zh/en 词典，并通过 inject face 把绑定的翻译函数和 locale 快照源交给该条目，因此切换语言会重新渲染已挂载的编辑器。问题与选项文本来自模型并原样渲染；载体失败消息也不经翻译直接显示。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖编辑器宿主、工具 seam 与 plan-mode 消费方。

- [ui-conversation](../ui-conversation/README.zh.md)——拥有 `conversation.composer` 链的聊天界面。
- [tool-ask-user](../../interaction/tool-ask-user/README.zh.md)——本 UI 所渲染其 schema 与答案的面向模型工具。
- [ui-plan](../ui-plan/README.zh.md)——设置 `plan-review` 意图的 plan-mode 界面。
- [user-questions](../../interaction/user-questions/README.zh.md)——Host 侧提问 seam 及其 answerer waterfall。

-----

<a id="model-experience"></a>
## 模型体验

间接影响模型体验：本包在 Web 客户端呈现 `dsh-tool-ask-user` 所拥有的模型可见 schema 与答案渲染。

#### KV Cache 影响

不会直接失效；模型可见的工具调用与结果由 `dsh-tool-ask-user` 拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义草稿持久性与编辑器归属；它们是当前包约束。

- **未提交草稿的生命周期限于当前页面与 Session**：只要该 Session scope 仍留在页面内，Session 导航就会保留草稿；完整刷新页面、Session 被裁剪，或待处理请求以新的本地标识重新交付时，则从空草稿开始。store 从不把草稿写入主机、`localStorage` 或磁盘。
- **每次只有一个请求拥有编辑器**：后续待处理请求仍留在会话快照中，并在较早请求落定后显示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。tool 与 slot 注册都是由各自 registry 持有和观察的 effect；Host pending table 通过公开 wire protocol 测试。
