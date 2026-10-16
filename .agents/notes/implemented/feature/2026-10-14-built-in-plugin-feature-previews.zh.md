# Agent Note: 内置插件功能配图

Status: implemented

[English](2026-10-14-built-in-plugin-feature-previews.md) | 中文

## 问题

一行插件描述不一定能说明插件产生什么结果。用户决定是否启用官方组合包时，一张展示其结果的图片会有帮助，例如一份以 DSH badge skill 添加的徽章结尾的文档。这类图片需要所有者、本地化规则和发送到 Client 的途径。

## 决策

在本记录中，内置插件指随 DSH 发布的官方组合包。插件管理拥有这些组合包的所有功能配图。[PluginManagerPage.tsx](../../../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) 把包名映射到 `{ en, zh }` 图片；该映射与定义其可选组合包列表的代码位于同一文件，并采用相同的硬编码方式。图片放在 `packages/client/ui-plugin-manager/src/client/assets/` 下。共享的 [client tsdown preset](../../../../packages/client/tsdown.client.ts) 把图片以 data URL 嵌入插件管理 client bundle。组合包详情页在描述和状态提示下方显示当前 UI 语言对应的图片，无论组合包是否启用。

每个内置功能配图都是这个映射中的一项。包不能声明配图，因此该映射不是面向插件作者的接口，修改时不需要兼容路径。

## 考虑过的替代方案

**在包 manifest 中增加 `preview` 字段。** 在 `DshPackageManifest` 和 `PluginLocalizedMeta` 中声明 `preview`，通过 app-boot 包元数据读取，并由发布和目录检查校验，会在任何第三方插件需要之前，使图片路径、语言映射、大小限制和设计规则成为所有插件作者都要遵守的公开约定。只有一个官方组合包有配图，不足以支持一个公开格式。

**把图片留在各组合包中，从 Host 获取。** 这样配图与功能放在一起，但仍需要 Host 读取路径以及组合包与插件管理之间的资源接口。

## 后果

内置功能配图不需要元数据读取器、manifest 校验、发布规则或目录字段。增加一张配图意味着在插件管理中添加图片和映射项。每张配图都会把其编码后的大小加到插件管理 client bundle 中；badge skill 的图片约增加 207 KB。

第三方插件在启用前无法显示配图或其他介绍内容；组合包自身的 `plugins.bundle.config` 内容仅在其 Client 部分加载时显示。长期计划是提供一种方式，让第三方插件在插件管理中展示其 README。该设计将定义自己的格式和信任规则，届时内置功能配图可能迁移过去。
