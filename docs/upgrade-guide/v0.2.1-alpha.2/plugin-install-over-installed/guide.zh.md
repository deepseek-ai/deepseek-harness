---
kind: upgrade-guide
description: "启用 HMR 时，安装已安装的包会以 already-installed 失败；升级需要先移除该包。"
---

# 启用 HMR 时拒绝在已安装的插件包上再次安装

[English](guide.md) | 中文

## 变更

在运行 HMR（热模块替换）的 profile 中（随附的 profile 都运行 HMR），`pluginManager.installBundle(spec)` 此前会对 profile 已依赖的包运行 pnpm，并在旧版本继续运行时报告 `restart-required`。现在当 spec 指向已安装的包时，它会在运行 pnpm 之前失败，返回 `application: 'failed'` 和 `error.code: 'already-installed'`，且不修改任何 profile 文件。这里的 spec 包括带或不带版本的注册表包名、本地目录，以及保存依赖时使用的 git 或 tarball spec。重复安装同一个 spec 也会以同样方式失败，不再报告 `changed: false`。

受影响的调用方包括：通过 Host API 调用 `installBundle()` 的代码、`@deepseek-ai/dsh-api-remotes/client` 中的远端客户端，以及 agent 的 `plugin_manager` 工具（`install_bundle`）。启用 HMR 时，不能再在无法移除的已安装包（例如带有插件管理的组合包）上安装。Web 页面上官方插件的“更新”操作会自行移除该包并安装新版本。未启用 HMR 时，在已安装的包上安装仍会运行 pnpm 并报告 `restart-required`。

## 迁移

1. 要安装已安装包的其他版本或其他位置，先调用 `removeBundle(name)`，再调用 `installBundle(spec)`。使用 agent 工具时，先调用 `remove_bundle`，再调用 `install_bundle`。移除操作会停止该 bundle 的插件，并删除其各个包的映射，因此新版本会重新建立映射，无需重启即可启动。
2. 如果代码对 `ManagementError['code']` 做穷尽 switch，需要处理 `already-installed`。
3. 确认迁移结果：再次安装该包返回 `already-installed`；执行 `removeBundle` 后，同样的 `installBundle` 调用返回 `applied` 和新的 `version`。
