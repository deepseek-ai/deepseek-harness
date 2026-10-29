---
description: "由安装方持有的官方 dsh 组合包列表（随附 profile 模板、默认列表，以及可选、按需和已退役的组合包），以及插件管理器保护和展示的包。"
kind: "package-library"
---

# @deepseek-ai/dsh-official-bundles

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-official-bundles` 保存由 dsh 安装决定的组合包名称：每个随附 profile 以哪些组合包启动、随附但默认关闭哪些组合包、哪些官方组合包按请求安装，哪些组合包曾由早期版本随附、现在要从 profile 中移除，以及插件管理器保护、隐藏、排序或标记为实验性的包。[`dsh-app-boot`](../../boot/app-boot/README.zh.md) 在加载 profile 时应用这些列表；插件管理器、CLI、Desktop、镜像打包器和仓库检查直接读取它们。本包只含数据，因此修改列表不会改动 app-boot 和插件管理器。请把它作为直接的库依赖使用，而不是通过 `cordis.yml` 使用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

安装的组合包选择或插件管理器保护、展示的包发生变化时编辑本包；凡是代码必须与启动器就该选择保持一致的地方，都读取本包。

### Profile 模板

`PROFILE_TEMPLATES` 把每个随附 profile 名称（`web`、`headless`、`acp`、`sdk`、`sdk-minimal`）映射到其有序的组合包层列表。App-boot 用模板初始化缺失的随附 profile，`dsh --profile <name> --from-default-profile <template>` 把某个模板复制为自定义 profile。`DEFAULT_PROFILE_BUNDLES` 是 `dsh plugin` 对没有模板的 profile 名称使用的列表。`INSTALLATION_OWNED_PROFILE_TUPLES` 列出早期版本写入随附 profile 的组合包列表；app-boot 把与之完全一致的列表替换为当前模板。

### 可选与已退役组合包

`OPTIONAL_BUNDLES` 列出安装随附、供用户开启的组合包。每一项都必须是 `dsh` 应用的运行时依赖，并声明 `dsh.bundle.patch`、图标和 `./locale/*.json` 显示元信息，且不能被任何模板选中；[`verify-default-product-isolation`](../../../scripts/verify-default-product-isolation.ts) 检查这些规则。[插件管理器](../../boot/plugin-manager/README.zh.md#use-this-package)把这些组合包报告为 `optional`。`RETIRED_BUNDLES` 列出安装不再携带的组合包；app-boot 在加载 profile 时将它们从该 profile 的组合包列表中移除。

<a id="plugin-manager-lists"></a>
### 插件管理器列表

`PROTECTED_PLUGINS` 列出[插件管理器](../../boot/plugin-manager/README.zh.md)因管理功能依赖而保持只读的插件包；包含其中任一插件的组合包是管理组合包。移除其中一项只解除这一条 `management-required` 拒绝；管理器自身的入口、随安装提供的组合包和不可寻址的行仍由各自的规则保护。[Web 插件页](../../client/ui-plugin-manager/README.zh.md)隐藏 `HIDDEN_BUNDLES`，把 `EXTENSION_BUNDLES` 按顺序排在最前，在 profile 启用 `MORE_BUNDLES` 之前不把它们放上主列表，并为 `EXPERIMENTAL_BUNDLES` 显示实验性标记。

### 按需组合包

`ON_DEMAND_BUNDLES` 列出只在请求时安装的官方公开包。`OFFICIAL_ON_DEMAND_CATALOG` 内嵌这些包自己持有的本地化元信息、图标和可选的 `dsh.bundle.platforms` 声明，用于离线发现与安装前的 Host 平台检查；`pnpm gen-official-bundle-catalog` 显式更新生成内容，`verify-official-bundle-catalog` 检查资源完整性与时效；构建使用已提交的目录，不导入提供方代码。目录不包含安装目标：插件管理器根据运行中的版本和安装推导目标，并使用普通的组合包安装器。[产品使用检查](../../../scripts/verify-product-use.ts)针对 Web 组合随附选择和按需选择，不执行提供方。 目录也保留 `listedByDefault`，使默认隐藏的组合包在用户显式安装或启用前保持隐藏。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

仓库检查把 `src/bundles.ts` 中的列表当作 TypeScript 字面量读取而不执行，因此每个列表都保持为由包名组成的静态数组或对象字面量。[`tsdown.client.ts`](../../client/tsdown.client.ts) 中的 `INLINE_SAFE` 允许 Client bundle 内联整个包，因此每个导出都保持为没有需要共享的运行时身份的数据。`ui-plugin-manager` 从包入口导入 Web 列表；只要没有 Client 代码导入 profile 模板和生成的目录，tree-shaking 就会让它们不进入该 bundle。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/bundles.ts`](src/bundles.ts) | Profile 模板，以及默认、安装持有、已退役、可选和按需组合包列表 |
| [`src/plugin-manager.ts`](src/plugin-manager.ts) | 受保护的插件包，以及 Web 插件页的隐藏、排序和实验性组合包列表 |
| [`src/catalog.generated.ts`](src/catalog.generated.ts) | 按需组合包的生成离线元信息 |
| [`src/index.ts`](src/index.ts) | 公开导出与目录条目类型 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-app-boot](../../boot/app-boot/README.zh.md)——应用模板和退役列表的 profile 加载。
- [随附可选组合包](../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.zh.md)——为什么由安装持有可选列表。
- [Official 按需组合包](../../../.agents/notes/implemented/architecture/2026-10-05-official-on-demand-bundles.zh.md)——离线目录的决策。

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **列表编译进安装**——修改列表需要发布新的 dsh 版本；profile 无法扩展可选或按需列表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
