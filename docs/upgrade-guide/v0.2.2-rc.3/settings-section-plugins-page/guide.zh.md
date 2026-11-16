---
kind: upgrade-guide
description: "删除「设置 → 内置插件」、它的两个包和 `settings.plugins.tab` slot；插件设置页同时出现在插件页面。"
---

# 删除内置插件分区

[English](guide.md) | 中文

## 变更

「设置 → 内置插件」及其包 `@deepseek-ai/dsh-client-ui-settings-plugins` 和 `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` 已删除，`settings.plugins.tab` slot 和 `SettingsPluginsTabOwnerProps` 也一并删除。「设置 → 插件管理」改为打开插件页面。`settings.section` 条目仍显示在设置中。当模块与注册包相同的已列出 bundle 行、或该 bundle 本身没有注册自己的 `plugins.row.config` 或 `plugins.bundle.config` 时，插件页面也会在该行或该 bundle 页面上显示这个条目；在插件页面上，条目的 `close` 回到打开它的视图，而不是关闭设置。两处都通过 `settings.section.view` Factory 渲染条目，该 Factory 由 ui-settings-general 注册并声明 `settings.section`。

## 迁移

1. 从 profile manifest 和 `cordis.yml` 中删除指向这两个已删除包的条目。
2. 把 `settings.plugins.tab` 贡献改为 `settings.section` 页面，或 `plugins.bundle.config` 等插件页面 slot。
3. 调用 `close()` 后必须离开设置的 `settings.section` 页面（例如启动 Session 之后）需要自行导航，因为在插件页面上 `close()` 只回到上一个视图。
4. 在插件页面打开该插件的 bundle，确认其设置页出现在那里（该行或 bundle 注册了自己的配置时除外）和设置中。
