---
kind: upgrade-guide
description: "手写 InputActions 或实现 SessionInput 的 Client 代码必须提供必选方法 prefill。"
---

# 输入操作上的 Composer 预填方法

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-conversation/client` 中的 `InputActions` 和 `SessionInput` 现在要求提供 `prefill(text, options?)`，该包同时导出 `ComposerPrefillMode` 和 `ComposerPrefillOptions`。Slot 组件与 Session 作用域插件从 Harness 读取预填操作，调用方无需改动即可编译。构造 `InputActions` 值或实现 `SessionInput` 的代码（包括传给 Client 组件的测试替身）必须新增该成员才能满足接口。该方法返回草稿是否接受写入；不支持预填的替身可以返回 `false`。

## 迁移

1. 在所有手写的 `InputActions` 或 `SessionInput` 对象中加入 `prefill`。转发到 Harness 提供的操作，或在替身不支持写入时返回 `false`。
2. 签名需要时，从 `@deepseek-ai/dsh-client-ui-conversation/client` 导入 `ComposerPrefillOptions` 或 `ComposerPrefillMode`。
3. 重新构建自定义 Client 插件及其测试，然后运行类型检查。检查通过即表示接口已满足；当对象转发该操作时，可从 Slot 组件调用 `inputActions.prefill('text')` 验证 Harness 路径。
