# Agent Note: Ship optional bundles with the installation

Status: implemented

[English](2026-09-15-shipped-optional-bundles.md) | 中文

## 问题

Web 插件页只管理用户装进 profile 的组合包。像 Agent Teams 这样的官方实验层，用户得先去 npm 找到包名并按名安装才能开启；而[默认产品隔离](2026-09-12-default-product-experimental-isolation.zh.md)又把所有实验包挡在安装的运行时依赖之外，所以随 dsh 一起交付的东西没有办法把它提供出来。

## 决策

启动器在 `OPTIONAL_BUNDLES`（`packages/boot/app-boot/src/profile.ts`，与 profile 模板并列）里点名安装随附、供用户开启的组合包。每一个都必须是 `apps/cli` 声明了 `dsh.bundle.patch` 的运行时依赖，且不被任何随附 profile 模板选中。插件管理器的 `listBundles` 把这类组合包报告为 `optional`：选中前保持关闭、永不可卸载、像其他安装提供的组合包一样从安装目录解析。Web 插件页以可选组合包开启「官方」分组，属于 beta 功能的带 beta 标签，排在 profile 自己已安装的组合包之前。

默认产品隔离的规则保持不变，只声明一个例外：可选组合包的依赖图在默认产品之外。静态门禁跳过从 `@deepseek-ai/dsh` 到列表中组合包的 `dependencies` 边，仍然拒绝运行时 import、随附组合、preset 或默认模板对它的引用，拒绝列表没有点名的实验依赖，也拒绝不是运行时依赖或不是组合包的列表项。workspace 约束检查接受同样的 `dependencies` 边而不接受其他运行时依赖段；发布时的 packed-install 检查对已安装入口包跳过这些边，并要求列表中的每个组合包都已安装。

[单组合包决策](../architecture/2026-09-18-agent-teams-single-bundle.zh.md)将两个 Agent Teams 选项替换为一个 `@deepseek-ai/dsh-experimental-agent-team-profile` 选项。本记录保留由安装方决定可选组合包的策略；[实验能力的可选 bundle 决策](../architecture/2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)列出当前名单以及每一项携带的显示元数据。

## 考虑过的替代方案

**可安装官方组合包目录。** 页面按需提供从注册表安装的包名。安装本身不变，但开启那一刻需要网络，并且每次发布都要钉一个版本。

**组合包自身的标记。** `dsh.bundle.optional` 声明会让任何已发布的组合包都能自称随安装提供；由启动器自己的列表来决定，选择权留在产品手里。

**放在安装 manifest 里的列表。** `apps/cli/package.json` 的 `dsh.optionalBundles` 是最初的形式；维护者把产品决定放在代码里，列表有类型、只读一次，管理器与门禁共用。

## 影响

可选组合包随产品一起下载，选中前保持不活动；运行时隔离 smoke 在默认组合中仍观察不到任何实验模块。开启一个可选 Web 层会通过实时客户端模块图加载它的客户端插件。
