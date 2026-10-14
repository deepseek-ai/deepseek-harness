---
description: "对展开的思考内容进行机器翻译，同时保留原文和已保存结果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-cot-translation

[English](README.md) | 中文

## 概述

以其他语言阅读展开的模型思考内容，并随时切回原文。在插件面板中选择翻译服务和目标语言。翻译会将显示的思考内容发送给所选外部服务，其中可能包含私有代码或对话细节。Session 和模型上下文保留原始思考内容。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在插件中启用[思考过程翻译组合包](../cot-translation-bundle/README.zh.md)，然后展开思考内容。启用组合包之前，此功能不会出现。组合包详情页提供暂存的翻译服务和目标语言设置；保存后两项选择一起生效。默认翻译服务为 Bing，`auto` 跟随当前界面语言。填写 `zh`、`en` 或 `ja` 等语言代码可指定目标语言。

“查看原文”和“查看译文”复用译文正文上方插件工具栏内的一个常显入口。插件自行维护此操作及其状态，思考标题只控制展开与折叠。两种视图复用同一个紧凑 Markdown 组件和排版，不改变思考预览，也不重复发送请求。完整段落和流式长段落中达到请求长度的前缀异步翻译，未完成的末尾片段保留原文。失败时保留原始正文，并提供重试；开始重试前，“查看译文”保持禁用。关闭思考内容或停用组合包会取消对应请求。

自定义组合可将本插件与[翻译服务](../translator/README.zh.md)和普通 Web GUI 一起挂载。本插件的配置字段是 `provider` 和 `targetLanguage`；完整定义见生成的[配置目录](../../../docs/config-catalog.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节 — 点击展开</summary>

浏览器向 Chat 的 `conversation.chat.reasoning.body` single Slot 注册包装组件，通过官方 `conversation.chat.reasoning.content` Factory 渲染原文或译文。包装组件自行维护工具栏与视图状态，将自己的本地化 Markdown labels 传入 Factory；Factory 负责排版。Host 暴露可取消的翻译 Remote 方法。Host 在浏览器启用翻译前提供已接受的翻译服务和语言偏好。设置更新及重新连接会刷新这些偏好和 translator 的请求长度限制。限制变化时，展开内容的请求被取消并重新分片。每个展开区域的生命周期控制器串行处理完整片段，在挂载期间缓存译文，在拆分长段落时保留空白和 Unicode 代理对，并忽略取消后的结果。

浏览器将每个请求绑定到展开区域的 Session。Host 要求请求使用已接受的提供方以及配置中显式指定的目标语言；`auto` 使用浏览器区域语言。已认证的 Client 提供原文与 Session 身份，Host 不校验原文是否属于该 Session。translator 持久化与 Provider 无关的请求／结果记录，在折叠、重载或重新打开 Session 后复用已完成结果。浏览器缓存只优化当前展示。

已保存结果无需激活 Session。未激活 Session 缓存未命中时，Host 等待普通 Session controller 的激活流程，再通过现有写入器重试一次翻译。此过程使用正常的 preset 启动钩子、恢复标记和中断轮次修复。取消会结束当前调用者的等待，并阻止随后派发翻译；共享激活仍可为其他读者继续完成。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [翻译服务](../translator/README.zh.md) — 服务接口和网络限制。
- [Chat 渲染](../../client/ui-chat/README.zh.md) — 思考内容展开和显示扩展。
- [Web Client Slots](../../../docs/subsystems/slots.zh.md) — 渲染贡献的生命周期。

-----

<a id="model-experience"></a>
## 模型体验

间接影响来自可选的独立付费 Flash 请求，以及缓存未命中时的正常 Session 激活；translator 负责翻译提示词，Session 的 preset 负责启动上下文。

#### KV Cache 效果

翻译记录不替换模型输入。正常激活可能追加上下文或修复中断轮次，其缓存影响与打开对话相同。独立付费查询的 token 和缓存影响由 [translator](../translator/README.zh.md#model-experience) 负责。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Google 和 Bing 匿名接口可能拒绝请求或不可用；请求不会回退到其他服务。
- 翻译可能改变 Markdown 格式或代码示例，原文始终可查看。
- 未激活的子代理 Session 若没有已保存译文，会保留原文并显示翻译失败；普通 Session 激活无法恢复子代理所有权。
- 折叠的预览保留原文。已保存结果属于 Session；未来格式迁移以尽力而为的方式保留实验性记录。
- 中国大陆的服务可达性需要在对应网络中验证。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
