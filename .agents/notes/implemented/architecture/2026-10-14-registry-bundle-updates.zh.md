# Agent Note: 注册表与 Git 组合包更新

Status: implemented

[English](2026-10-14-registry-bundle-updates.md) | 中文

## 问题

从注册表安装的第三方组合包没有更新途径。插件页只为官方组合包提供 **更新**，其目标是当前运行的 DSH 版本，因此用户只能在 DSH 之外得知第三方新版本，并通过卸载再安装来替换。有 HMR 时，安装到已安装的包之上会被拒绝；手动移除后安装失败，插件就处于未安装状态。从 Git 安装的组合包同样没有更新途径：Git 仓库不发布版本列表；从插件索引把较新的提交安装到已安装副本之上时，包会解析到另一个目录，HMR 无法在运行中替换，因此改动要等到重启，安装失败时也没有任何机制重新安装旧提交。

## 决策

**版本通过在 profile 目录中运行 `pnpm view` 读取。** `listVersions` 按与 `inspect` 相同的注册表计划运行 `pnpm view <name> versions time dist-tags`，因此安装所用的 `.npmrc` 链、代理与认证同样决定列表显示什么，连不上的注册表会使查询转向下一个。pnpm 对范围查询只打印最高的匹配版本，因此每个列出的版本在作答的注册表上单独运行一次 `pnpm view <name>@<version> name version engines peerDependencies deprecated dsh`。`versionListLimit` 限制读取的新版本个数，`versionLookupConcurrency` 限制同时运行的子进程个数。兼容性复用 `evaluatePluginCompatibility` 与 profile 的豁免，因此列表与安装以同样方式判断 peer。

**更新及其恢复由 Host 负责。** 对注册表副本，`updateBundle` 先查询目标版本，在任何改动之前拒绝不存在的版本、未声明组合包的版本，以及 `engines.dsh` 或 DSH peer 拒绝当前运行版本的版本。有 HMR 时，它随后调用 `removeBundle` 与 `installBundle(name@version, { saveExact, registry, enabled, expected })`，其中 `expected` 让安装在装入的不是 `version` 版本的 `name` 时连同模块一起撤销自身；该安装失败、被取消，或已安装但无法启动时，先移除仍留下的目标版本，再从被移除版本原来的注册表重新安装它，没有记录时按配置的计划安装。重新安装不带请求 id，因此取消更新无法中止它。没有 HMR 时，它直接安装在运行中的版本之上，`installBundle` 在这种情况下允许这样做并报告 `restart-required`。`plugin-manager/update-state` 通告每一步，供对话框的进度列表使用。

**更新资格是列出的事实。** 以自身包名、按注册表 spec 保存（不是 `npm:` 别名）的第三方 profile 依赖，其 `BundleInfo.update` 为 `registry`；按固定到完整提交的 Git spec 保存的为 `git`，其重新安装能恢复被移除的版本；两者都要求 semver 版本且不承载插件管理。页面只为 `registry` 组合包显示版本区块，`listVersions` 拒绝其他所有组合包，`updateBundle` 拒绝所有没有 `update` 的组合包。没有更新操作的 `plugin_manager` 工具省略该字段。

**Git 副本从其来源的仓库目录更新到插件索引列出的版本。** Git 仓库没有版本列表，而插件索引把每个 Git 版本固定到一个提交和一个包目录。版本比 `git` 副本新、且固定到同一仓库与 `path:` 目录中的一个提交时，`pluginMarket` Host 服务为其标上 `update`；「发现」为其提供 **更新**，并把包、版本和 spec 交给插件页，由插件页的更新对话框调用 `updateBundle(name, version, { spec })`。Host 要求 `git` 副本提供这样的 spec，并拒绝为 `registry` 副本提供的 spec；两个服务都从 `@deepseek-ai/dsh-plugin-manager` 导入 `pinnedGitOrigin`，它比较仓库来源时不考虑 pnpm 保存的形式，因为 profile 会为它无法读取的 HTTPS 仓库保存 SSH 形式，并为 GitHub URL 保存 `github:` 简写。pnpm 只在安装时读取 Git 包，因此 Host 在移除之前只检查网络能否到达目标仓库所在的主机；主机不可达时，目标的安装与重新安装同样会失败。Git 无法运行的检查，或因需要凭据而被拒绝的检查，交给 pnpm 处理，pnpm 无需 Git 即可将公开托管仓库中的提交作为 tarball 安装。其余检查在安装过程中进行：兼容性的检查与每次安装相同，`expected` 在组合包加载前撤销安装了另一个包或版本、或不含组合包的目标，并以 `unexpected-package` 或 `not-bundle` 失败。被移除的副本从 profile 保存的 spec 重新安装，「发现」从不在已安装副本之上安装。

**更新只向前。** 页面只列出比已安装版本新的版本，`updateBundle` 拒绝其他版本，因此更新不会让插件读取更新版本写入的数据。

## 考虑过的替代方案

**通过 HTTP 获取精简 packument。** 一次请求即可返回每个版本的 `peerDependencies` 与 `deprecated`，但 Host 必须自行从 `.npmrc` 链解析注册表、scope、认证与代理设置，并保持与 pnpm 的解析一致。来自 pnpm 不会从中安装的注册表的列表，会显示无法安装的版本。

**`pnpm outdated`。** 它只报告 current、wanted 与 latest，不判断 DSH peer，而在确切版本保存下 wanted 等于 current。

**在浏览器中编排移除与安装。** 官方组合包的更新就是这样做的。浏览器在两次调用之间关闭或断开连接时，包已被移除且无人重新安装，而移除前的目标检查会成为 Host 规则的第二份、可被绕过的副本。

**在读取组合包时列出版本。** `listBundles` 不联网；加入注册表查询会让打开插件页变成网络操作，且每个版本一个子进程。

**由 Host 从仓库 tag 读取 Git 版本。** 在 monorepo 中，tag 不指明包目录，也不说明索引审核过哪个版本；插件索引已经固定了提交、目录与版本。

**把较新的提交安装到已安装副本之上。** 这样无需移除，但有 HMR 时包会解析到另一个目录，因此运行中替换会被拒绝，直到重启；安装失败时也不会重新安装任何版本。

**在移除已安装副本之前检查包名。** pnpm 只有拉取 Git spec 才能读取其 manifest（元数据清单），在安装前再拉取一次会使下载量翻倍；在本次运行中检查安装的包只需拉取一次，目标不对时由重新安装恢复。

**在安装之后移除安装了另一个包的目标。** 那时其组合包已经加载并运行；若另一个包是已有依赖，`pnpm add` 已将其替换，移除它会卸载用户保留的插件。连同锁文件撤销本次运行，也会恢复该依赖。

**接受来自其他仓库的目标。** 索引内容没有签名，更新对话框也不带自己的信任提示，因此任何已配置的索引都能用来自用户从未选择的来源的代码替换插件的代码；迁移到另一个仓库的插件需要先卸载再安装，并经过安装确认。

## 后果

- 检查一个包需要一次 `pnpm view`，再加上每个列出版本一次，每次都受 `inspectTimeoutMs` 限制。
- 更新保存的注册表目标版本，以及失败后重新安装的版本，都是确切版本，即使 profile 原先保存的是范围；有 HMR 时，组合包排到选中列表末尾。
- 移除与安装分别获取 profile 锁，其他操作可能在两者之间运行；安装被拒绝（例如锁等待超时）时，同样会触发重新安装。
- 依赖需要新的构建脚本批准的版本会安装失败，并重新安装为原版本；其脚本通过普通安装批准。
- 重新安装也失败时，包处于未安装状态，对话框会如实说明。
- 提交不存在、未声明组合包、拒绝当前运行 DSH，或安装了另一个包或版本的 Git 目标，只有在已安装副本被移除之后才会被发现；重新安装可以恢复，代价是插件停止一次并多安装一次。
- URL 中带凭据保存的 Git 副本，从已保存的 spec 重新安装时不带这些凭据，因此私有仓库需要 Git 凭据助手。
- 以分支、标签或范围保存的 Git 副本，或其插件已迁移到另一个仓库的 Git 副本，只能通过先卸载再安装来更新。

## 验证

| 覆盖 | 位置 |
|---|---|
| 列表、注册表回退、拒绝、兼容性、预发布、弃用与版本上限 | `packages/boot/plugin-manager/tests/manager.spec.ts` |
| 经移除与安装的更新、目标失败、取消或被拒绝后的重新安装、重新安装失败、改动前的拒绝、移除失败与无 HMR 路径 | `packages/boot/plugin-manager/tests/manager.spec.ts` |
| `pnpm view` 答复解析 | `packages/boot/plugin-manager/tests/versions.spec.ts` |
| Git 更新资格、经同一目录中某个提交的更新、从已保存 spec 重新安装、安装另一个包或版本的目标、目标不含组合包时的无 HMR 路径、不可达的仓库主机，以及对 spec 的拒绝 | `packages/boot/plugin-manager/tests/manager.spec.ts` |
| pnpm 保存的各种形式下的 Git 来源 | `packages/boot/plugin-manager/tests/install-spec.spec.ts` |
| 安装了另一个包、另一个版本，或缺少预期的组合包时，连同模块一起撤销的运行 | `packages/boot/plugin-manager/tests/operations.spec.ts` |
| 对任意主机上 Git 仓库的连接检查 | `packages/boot/plugin-manager/tests/github-connection.spec.ts` |
| 索引列表中被标为更新的、已安装副本所在目录的 Git 版本 | `packages/boot/plugin-market/tests/market.spec.ts` |
| store 中的版本检查、更新状态与步骤进度，包括另一个标签页指定的 Git 更新 | `packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts` |
| 版本区块、工具栏检查、每种更新结果，以及对话框中 Git 目标的仓库 | `packages/client/ui-plugin-manager/tests/components.client.spec.tsx` |
| 「发现」卡片和版本行上的 **更新**，以及不在已安装副本之上安装 | `packages/client/ui-plugin-market/tests/discover.client.spec.tsx` |
