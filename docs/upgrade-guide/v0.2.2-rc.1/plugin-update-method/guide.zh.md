---
kind: upgrade-guide
description: "BundleInfo.updatable 由 BundleInfo.update 取代，ManagementError 新增 unexpected-package 错误码。"
---

# `BundleInfo.update` 取代 `BundleInfo.updatable`

[English](guide.md) | 中文

## 变更

`pluginManager.listBundles()` 不再返回 `BundleInfo.updatable: boolean`，改为返回可选的 `BundleInfo.update`：`listVersions` 能读取其较新版本的组合包为 `'registry'`，从固定到完整提交的 Git spec 安装的组合包为 `'git'`，`updateBundle` 无法替换的组合包不含此字段。此前标记为 `updatable: true` 的组合包现在为 `update: 'registry'`。当 `options.spec` 指向同一仓库目录的较新提交时，`updateBundle` 也接受 `'git'` 组合包。

`ManagementError['code']` 新增 `unexpected-package`：带 `InstallBundleOptions.expected` 运行的安装（`updateBundle` 总会传入该选项）在 spec 安装了其他包或其他版本时以此错误码失败。

受影响的代码包括：通过 Host API、`@deepseek-ai/dsh-plugin-manager/types` 或 `@deepseek-ai/dsh-api-remotes/client` 中的远端客户端读取 `listBundles()` 的代码，以及对 `ManagementError['code']` 做穷尽 switch 的代码。`plugin_manager` 工具从未返回该字段，保持不变。

## 迁移

1. 替换每一处对 `updatable` 的读取。要判断 `listVersions` 能否列出组合包的版本，检查 `bundle.update === 'registry'`；要判断 `updateBundle` 是否能以任何方式替换它，检查 `bundle.update !== undefined`。
2. 如果代码对 `ManagementError['code']` 做穷尽 switch，需要处理 `unexpected-package`。
3. 运行类型检查；当不再有对 `updatable` 的读取，也没有未处理的 `ManagementError` 错误码时，类型检查通过。
