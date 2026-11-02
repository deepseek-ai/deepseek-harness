---
description: "在完整回答末尾显示支持位置选择、保留和撤销的创建卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-creation-recommendations

[English](README.md) | 中文

## 概述

用户在完整回答下方看到一条创建建议。短方案完整显示，长方案约两行后折叠，可展开全文。下拉菜单提供右侧栏、会话 Tab、全局页面和自行撰写四项。消耗提示在用户收起前默认展开，本浏览器跨会话记住选择，信息按钮可重新打开。只有点击创建才启动后台任务，主对话可继续。进度显示在顶部，保留用于确认继续使用，撤销则移除插件，恢复会重新安装它。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启用[个性化推荐 Bundle](../personalized-recommendations/README.zh.md)。本浏览器组件没有配置字段；它为 `create_personalized_page` 卡片填充共享的[操作卡片框架](../client-ui-action-cards/README.zh.md)。

### 操作结果与恢复

尚未创建的卡片一直可用，直到同一会话里更新的方案替换它。被替换的卡片保留历史内容和“已替换”标签，没有创建和位置控件。提供的预填内容以折叠形式显示在方案下方，用户能看到交给 Creator 的内容。已开始的任务保留进度和重试操作。共享卡片投影拥有这个状态，所以刷新不会重新激活卡片。

创建、安装、保留和移除记录来自 Session 投影，重新连接后会在卡片中恢复。操作回复丢失时显示可采取行动的错误信息；重试以 Host 已记录的状态为准。请求处理中禁用重复操作。生成阶段可取消，等待子任务清理后才能重试；已接纳的安装不再取消。信息说明中包含源码目录，并明确撤销会保留这些文件。已移除的卡片提供“恢复”；保留的文件已不在时，提示需要重新提案。

自行撰写会显示位置输入框，最多 1,000 字，空白内容不能启动创建；改选预设位置后不提交自定义文字。已接受的请求将文字存入操作记录，供重连和重试恢复，并连同完整方案交给 Creator。编辑草稿、打开菜单或查看消耗说明都不会调用模型。收起提示或点击创建、暂不需要后，浏览器本地存储记住已读；更换浏览器、清除或无法使用存储时可能再次显示。历史已结束的卡片默认收起提示。

是否展开只取决于有没有省略内容，不取决于渲染高度。长方案预览合并空白，并保留组合 emoji 等字素边界；展开后恢复原始全文。短方案在任何窗口宽度都完整显示。文字自然换行，不固定三行，不读取 DOM 尺寸或使用 ResizeObserver。

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节 — 点击展开</summary>

插件把正文注册到共享卡片框架，由框架把卡片放在所属回合之后，并提供标题、折叠后的说明、折叠组件和绑定到卡片的操作。正文先校验卡片的 details 和已记录的数据，再渲染带消耗说明开关的标题栏、位置选择、手写位置、折叠的预填内容、进度，以及保留、撤销和恢复。消耗说明的偏好是插件自有的浏览器本地存储。共享 Menu 处理浮层定位、键盘选择和关闭。正文注册和语言字典使用同一插件生命周期。

- [源码](src/client/Card.tsx)
- [测试](tests/)

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [创建服务](../creation-recommendations/README.zh.md) — 创建任务与持久化。
- [操作卡片显示](../client-ui-action-cards/README.zh.md) — 本正文使用的框架、折叠和操作。
- [Slots](../../client/ui-slots/README.zh.md) — 回合末尾呈现.

<a id="model-experience"></a>
## 模型体验

间接影响来自用户接受的创建操作：Host 启动 Creator，传入完整方案和选定或手写的位置，不增加浏览器侧模型工具，也不恢复父模型执行。

#### KV Cache effect

渲染卡片和修改位置不会影响模型缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 展示方案由模型编写，所需已有数据通过方案的可选 `initialContent` 单独交接。
- 历史记录不会持续跟踪之后在插件页手动进行的修改。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
