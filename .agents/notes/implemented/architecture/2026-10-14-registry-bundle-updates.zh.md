# Agent Note: 注册表组合包更新

Status: implemented

[English](2026-10-14-registry-bundle-updates.md) | 中文

## 问题

从注册表安装的第三方组合包没有更新途径。插件页只为官方组合包提供 **更新**，其目标是当前运行的 DSH 版本，因此用户只能在 DSH 之外得知第三方新版本，并通过卸载再安装来替换。有 HMR 时，安装到已安装的包之上会被拒绝；手动移除后安装失败，插件就处于未安装状态。

## 决策

**版本通过在 profile 目录中运行 `pnpm view` 读取。** `listVersions` 按与 `inspect` 相同的注册表计划运行 `pnpm view <name> versions time dist-tags`，因此安装所用的 `.npmrc` 链、代理与认证同样决定列表显示什么，连不上的注册表会使查询转向下一个。pnpm 对范围查询只打印最高的匹配版本，因此每个列出的版本在作答的注册表上单独运行一次 `pnpm view <name>@<version> name version engines peerDependencies deprecated dsh`。`versionListLimit` 限制读取的新版本个数，`versionLookupConcurrency` 限制同时运行的子进程个数。兼容性复用 `evaluatePluginCompatibility` 与 profile 的豁免，因此列表与安装以同样方式判断 peer。

**更新及其恢复由 Host 负责。** `updateBundle` 先查询目标版本，在任何改动之前拒绝不存在的版本、未声明组合包的版本，以及 `engines.dsh` 或 DSH peer 拒绝当前运行版本的版本。有 HMR 时，它随后调用 `removeBundle` 与 `installBundle(name@version, { saveExact, registry, enabled })`；该安装失败、被取消，或已安装但无法启动时，先移除仍留下的目标版本，再从被移除版本原来的注册表重新安装它，没有记录时按配置的计划安装。重新安装不带请求 id，因此取消更新无法中止它。没有 HMR 时，它直接安装在运行中的版本之上，`installBundle` 在这种情况下允许这样做并报告 `restart-required`。`plugin-manager/update-state` 通告每一步，供对话框的进度列表使用。

**更新资格是列出的事实。** `BundleInfo.updatable` 标记以自身包名、按注册表 spec 保存（不是 `npm:` 别名）、带 semver 版本且不承载插件管理的第三方 profile 依赖；页面只为这些组合包显示版本区块，两个方法都拒绝其他组合包。没有更新操作的 `plugin_manager` 工具省略该字段。

**更新只向前。** 页面只列出比已安装版本新的版本，`updateBundle` 拒绝其他版本，因此更新不会让插件读取更新版本写入的数据。

## 考虑过的替代方案

**通过 HTTP 获取精简 packument。** 一次请求即可返回每个版本的 `peerDependencies` 与 `deprecated`，但 Host 必须自行从 `.npmrc` 链解析注册表、scope、认证与代理设置，并保持与 pnpm 的解析一致。来自 pnpm 不会从中安装的注册表的列表，会显示无法安装的版本。

**`pnpm outdated`。** 它只报告 current、wanted 与 latest，不判断 DSH peer，而在确切版本保存下 wanted 等于 current。

**在浏览器中编排移除与安装。** 官方组合包的更新就是这样做的。浏览器在两次调用之间关闭或断开连接时，包已被移除且无人重新安装，而移除前的目标检查会成为 Host 规则的第二份、可被绕过的副本。

**在读取组合包时列出版本。** `listBundles` 不联网；加入注册表查询会让打开插件页变成网络操作，且每个版本一个子进程。

## 后果

- 检查一个包需要一次 `pnpm view`，再加上每个列出版本一次，每次都受 `inspectTimeoutMs` 限制。
- 更新保存的目标版本，以及失败后重新安装的版本，都是确切版本，即使 profile 原先保存的是范围；有 HMR 时，组合包排到选中列表末尾。
- 移除与安装分别获取 profile 锁，其他操作可能在两者之间运行；安装被拒绝（例如锁等待超时）时，同样会触发重新安装。
- 依赖需要新的构建脚本批准的版本会安装失败，并重新安装为原版本；其脚本通过普通安装批准。
- 重新安装也失败时，包处于未安装状态，对话框会如实说明。

## 验证

| 覆盖 | 位置 |
|---|---|
| 列表、注册表回退、拒绝、兼容性、预发布、弃用与版本上限 | `packages/boot/plugin-manager/tests/manager.spec.ts` |
| 经移除与安装的更新、目标失败、取消或被拒绝后的重新安装、重新安装失败、改动前的拒绝、移除失败与无 HMR 路径 | `packages/boot/plugin-manager/tests/manager.spec.ts` |
| `pnpm view` 答复解析 | `packages/boot/plugin-manager/tests/versions.spec.ts` |
| store 中的版本检查、更新状态与步骤进度 | `packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts` |
| 版本区块、工具栏检查与每种更新结果 | `packages/client/ui-plugin-manager/tests/components.client.spec.tsx` |
