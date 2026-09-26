# Agent Note: 插件管理移到 Web 侧栏

Status: implemented

[English](2026-09-09-plugin-management-in-the-web-sidebar.md) | 中文

## 问题

已安装的包属于运行中的 profile，而设置是覆盖在 Session 上的弹窗。管理页面需要容纳包详情与安装输出。布局的[全局主面板](2026-09-08-global-main-panels.zh.md)提供对应的生命周期与空间。

## 决定

**管理位于侧栏。** `ui-plugin-manager` 在 `plugins` 下注册 `sidebar.panellist` 入口与它打开的 `main` 面板。页面通过[插件管理器](2026-09-14-current-profile-plugin-management.zh.md)的 Remote 管理 profile 的组合包及其行、展示安装输出，并确认卸载。它列出已安装的组合包与安装随附的可选组合包。设置保留只读插件清单，包括随安装提供的组合包（`dsh-base`、`dsh-web-app`）；清单的两个分组默认收起，且不带管理控件。配置的位置遵循[插件配置页决策](2026-09-16-plugin-configuration-on-the-plugins-page.zh.md)。

**一个 store 跟随 Host 状态。** 管理器控制器把 `listBundles` 与 `listPlugins` 合成每个组合包一份视图，按清单的 `managementAvailable` 判定可用性，在管理操作后、收到 `plugin-manager/changed` 时以及重连后刷新，并按所属 job 保存安装进度。配置表单使用原有全局 settings 绑定。

**安装结果属于一次请求。** 每次安装或重试都生成新的请求 ID，对话框按该 ID 筛选 Host 进度、日志和返回结果。取消确认可能先于原 add 响应到达，因此旧响应不能结束随后的重试。取消采用管理器的明确清理确认；本地 RPC 取消和断线均不表示 pnpm 已停止。进入配置应用阶段后关闭取消窗口。

## 考虑过的替代方案

**用一个设置分区打开管理页。** 否决：对话框盖住主列，这样的入口必须先关掉设置才能显示页面。

**配置的位置。** 该选择及其替代方案由[插件配置页决策](2026-09-16-plugin-configuration-on-the-plugins-page.zh.md)维护；侧栏导航与安装请求的归属独立于它。

## 后果

web bundle 的**插件**侧栏入口打开 profile 管理。设置提供只读清单，插件表单位于插件页。`apps/web/tests/plugin-manager.e2e.ts` 经侧栏到达管理器；`plugin-config` 与 `settings-chrome` 分别验证表单和只读清单。

## 测试

`packages/client/ui-plugin-manager/tests` 钉住同一 id 下的两处注册与页面的渲染；`packages/client/ui-settings-plugins/tests` 钉住没有标签条的单一贡献；上述 web e2e 场景在脚手架上驱动面板与分区。
