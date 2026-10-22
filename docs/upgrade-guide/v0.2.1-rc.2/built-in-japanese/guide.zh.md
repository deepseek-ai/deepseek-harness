---
kind: upgrade-guide
description: "内置日语注册会与第三方日语语言包冲突。"
---

# 日语成为内置语言

[English](guide.md) | 中文

## 变更

locale 插件注册 `ja` 语言，以及 `common` 和 `settings.locale` 的日文字典。按此前 README 日语示例编写的第三方语言包会因语言或字典已注册而加载失败。

## 迁移

1. 在语言包的 client 入口中，删除 `ctx.locale.addLanguage({ id: 'ja', ... })`，以及 `common` 和 `settings.locale` 下的 `ja` 注册。删除其他已由内置插件提供的命名空间的日语字典注册；保留自己插件所拥有命名空间的翻译。
2. 如果语言包代表不同的语言变体，为语言定义及其字典注册独立的 BCP 47 风格 id，例如 `ja-JP`，代替 `ja`。
3. 启用语言包并重新加载应用。确认启动时没有重复注册错误，且选择目标语言后显示对应译文。
