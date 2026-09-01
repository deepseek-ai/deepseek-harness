---
description: "Web GUI 的模型选择：/model 弹窗与 composer 模型位共用一份按提供方分组的会话级目录；供模型路由的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

[English](README.md) | 中文

## 概述

本包提供 Web GUI 的模型选择：`/model` 弹窗命令与 composer 模型位，两者共用一份按提供方分组的会话级目录。选择模型会提交完整选择——提供方、模型与推理强度——宿主在下一次提示词组装边界对其快照，因此后续请求采用该选择，而运行中的步骤保留已组装选择。composer 位显示两级 Model/Effort 菜单：模型按提供方分组，所选具体模型提供其适配器持有的推理强度名称与默认值。当宿主报告没有适配器服务该会话的路由时，composer 输入停用，直到路由恢复可用。

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

与 `ui-conversation` 及命令包一起挂载本插件；composer 随即在待处理指示器旁显示模型位，`/model` 则以弹窗打开同一份目录。当确切提供方／模型对仍在已公布分组中时，两个表面都显示宿主报告的当前选择；目录行缺席时，可路由的选择保持不变，触发器提示 `Select model`。

### 模型与推理强度

模型按提供方分组。菜单只显示模型与推理强度名称；目录中的说明仍可供其他消费方使用。`/model` 弹窗应用所选模型的默认推理强度；composer 随后可以选择任一已公布的推理强度。适配器没有推理元数据时不显示 Effort 行；不存在任意推理强度输入。

### 不可路由的会话

当宿主报告没有适配器服务该会话的路由时，本插件注册一个 composer 阻塞块，输入随本插件自己的文案停用；恢复后无需重新加载即清除。首次加载之前或加载失败之后的 `null` 绝不阻断；目录成员关系同样不阻断——一条仍在服务、只是不公布该模型的路由不在分组里，却可用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

两个入口共用一份由 `ModelDirectoryResolver`（`ctx.modelDirectories`）持有的会话级目录：`/model` popupSelect 贡献项（经 `ctx.commandUi` 注册）与 composer 的具名 `conversation.input.model` 位都经 `session.models` 加载会话的建议目录、经 `session.selectModel` 通过同一个 `ModelDirectory` 实例提交，因此任一人口所做的切换正是另一个入口接下来显示的。目录加载与选择共享一个代次计数器，旧响应不会覆盖新结果；连接重置丢弃所有常驻投影，并在显示前重新拉取宿主恢复的选择。目录按会话惰性解析，随会话作用域一并释放；已寻址 subagent 会话不公开任一入口。每份常驻目录都会直接在转发的 `llm/adapters-updated` 与 `settings/document-updated` owner 事件上重拉。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当模型面不够用时阅读以下页面。它们从浏览器表面进入命令弹窗外壳与选择约定。

- [ui-commands](../ui-commands/README.zh.md)——`/model` 贡献项注册进的 popupSelect 外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 composer 的 `conversation.input.model` 位与 composer 阻塞块。
- [dsh-agent-default-model](../../core/agent-default-model/README.zh.md)——为从未选择的会话提供默认模型的默认模型服务。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接影响。两个入口都提交 `session.selectModel` 选择；宿主在下一次提示词组装边界对完整 `ModelSelection` 快照并拥有模型可见效果，而运行中的步骤保留已组装选择。

#### KV Cache 影响

切换路由可能减少提供方侧后续请求的缓存复用，或使其失效；提示词前缀本身不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前模型表面。它们是当前包约束，不是通用模型路由器对比或任务积压。

- **无创建期或已寻址 subagent 选择**——两个入口都要求既有普通会话的 agent；没有可纳入会话创建的草稿阶段模型选择，subagent 继续执行也有意不公开独立的模型选择约定。
- **目录名仅供呈现**——选择与持久化使用提供方／模型／推理强度 id；目录查询或确切模型元数据查询失败的提供方以不可选失败行列出，重新加载前保持原样。
- **不能任意输入推理强度**——composer 仅提供确切模型由适配器公布的推理强度；适配器没有推理元数据时不显示 Effort 行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 command contribution，HMR 测试覆盖释放；它不发出 Cordis 事件，也不持有跨插件可变状态。
