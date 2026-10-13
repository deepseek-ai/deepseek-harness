# Agent Note: 每个已认证浏览器共用 Host 偏好

Status: implemented

[English](2026-09-15-authenticated-browser-host-preferences.md) | 中文

## 问题

[通过 Host settings 持久化 Web 用户偏好](../../archived/bug-fix/2026-08-06-host-backed-web-preferences.md)按页面本地性选择偏好存储，因此非回环页面把 Appearance、Language、繁忙态 Enter 与欢迎提示的确认留在一份进程内副本中。可信远程主机，以及配置了公共 URL 的部署，因而在重新加载时丢失全部选择，尽管 Connection 认证完整的 settings API。这套第二种模式也割裂了共享运行时：主题、语言、设置外壳、Models 页面与欢迎提示各自都在渲染一行对远程页面永远无法持久化的界面。

## 决策

本地性不选择任何东西。一个 `settings.describe` 镜像、由它派生的逐 namespace `ctx.configForms.get(entryId)`，以及 `settings.mutate` 写入路径服务每个已认证浏览器。Connection API 的浏览器令牌认证是身份边界；固定的 `remote.$host` 本地性事实只是请求路由的依据，没有任何存储选择器会读取它。镜像的状态空间只有 `idle`、`loading` 与 `ready`，表单快照不携带 mode，表单也只有在 Host 未注册该 namespace 时才报告 `unavailable`。

settings 外壳保留唯一一个依赖本地性的 UI 元素：它依据 `ctx.remote.$host.isLoopback` 构造文档控制器，因此只有回环页面会渲染**打开配置文件**并发出其背后的 `hasDocument` 读取。`settings/openSettingsDocument` Remote 本身与其他 Host 方法一样保持浏览器认证；省略该操作是面向看不到 Host 原生编辑器的页面的展示选择，而非持久化规则。

## 曾考虑的替代方案

**保留内存分支的本地性门禁。** 已否决：浏览器令牌认证已覆盖远程页面的每个 Host 方法，该门禁保护不了任何东西，而本地性只是请求路由的依据而非身份。它还会让受信远程与公共部署上每一行依赖 Host 的界面失效。

## 后果

每个访问同一 Host 的已认证浏览器共用一份偏好文档。同一部署上的两个浏览器会看到彼此选择的 Appearance、Language、繁忙态 Enter 与欢迎提示确认，远程写入的值就是回环浏览器下一次加载的值。偏好可访问性由 API 认证与 `settings.describe.writable` 决定。

远程页面省略**打开配置文件**操作，这是仍依赖本地性的唯一 UI 元素。同一文档上的并发写入由各表单作为 `expectedRevision` 发送的 namespace revision 裁决。

## 测试

聚焦的单元测试固定当前契约：ui-settings 的镜像与配置表单测试在构造这两个对象时不传持久化选择器，主题 apply 测试从非回环 bench 持久化并断言 Host 写入，ui-settings-general 的 apply 测试在非回环下保留共享 describe 读取与 Host 写入路径、同时断言原生文档操作保持未注册，欢迎 store 则在 settings 插件重建后保留其确认。无密钥 Web settings 场景 `apps/web/tests/remote-settings.e2e.ts` 从可信远程页面确认欢迎通知、配置一个模型提供商并选择深色 Appearance，每步之后重新加载，并从 Host settings 文档重新确认欢迎提示、模型与 Appearance 状态。
