# Agent Note：插件详情页作为扩展点

状态：已实现

[English](2026-09-17-plugin-detail-page-extension-slots.md) | 中文

## 问题

插件页的详情页——组合包页、行页、官方插件页——只承载页面自绘的内容和对象自己的配置（[插件配置放在插件页](2026-09-16-plugin-configuration-on-the-plugins-page.zh.md)）。对不属于自己的组合包有话要说的插件——诊断插件的健康检查、市场插件的更新标签、文档插件的 README 区块——在那个组合包的页面上无处安放，而通过 import 页面来扩展它被客户端包纯净性规则禁止。

## 决策

**页面按区域而不是按对象声明三个 list slot。** `plugins.detail.actions` 渲染在页头，位于页面自己的开关和卸载之前；`plugins.detail.badge` 在标题旁，位于版本、Beta 和异常标签之后；`plugins.detail.section` 在页面自身内容之下——组合包页在组件列表之后，行页与官方插件页在配置之后。每个条目都以页面的 `subject` 渲染：`{ kind: 'bundle', pkg }`、`{ kind: 'row', pkg, row }` 或 `{ kind: 'item', id }`。条目根据 subject 决定是否渲染，否则返回 null；页面按 `order` 排列条目。

**subject 是投影，不是 store。** `PluginPackageRef` 与 `PluginRowRef` 携带包名、版本、是否已安装、是否启用以及行列表——贡献者据以判断的事实——不带页面自己的任何状态，因此页面的 store 保持私有，契约保持精简。

**行页仍然只为已配置的行存在。** list 条目无法预先说明它对哪些行有话要说，而一个空空如也的行页没有值得打开的内容，所以配置控件保留原规则：有 `plugins.row.config` 条目点名这一行时才可打开，对该行的贡献渲染在那个页面上。

## 考虑过的替代方案

**按对象和区域各开一个 slot（`plugins.bundle.section`、`plugins.row.section` 等）。** 否决：三个区域要九个 slot，而跨对象的贡献要注册三次。subject 判别式在三个 slot 里承载同样的信息。

**把页面的 `PackageView` 与 `PackageRow` 直接作为 subject。** 否决：这些类型携带 Host 的只读原因、错误、条目 id 与 fiber 阶段，这些是页面自己的事；暴露它们会让 store 内部成为公共契约。

**每一行都有页面，让行级贡献总有落脚处。** 推迟：没有配置的行，页面除了模块名和状态之外无可展示；等有贡献需要时再放宽这条规则。

## 后果

- 一个贡献就是一次 slot 注册，只需 `import type` `ui-plugin-manager` 的声明；页面从不点名任何贡献插件。
- e2e 夹具组合包（`@fixture/live-client`）通过三个 slot 向它自己的组合包页和行页贡献内容；它的浏览器半侧与其余注册一起完成，也一起离开。
- slot 目录与 slots 子系统层级树在 `main` 下列出这三个 slot。

## 测试

`packages/client/ui-plugin-manager/tests/components.client.spec.tsx` 在组合包页、行页和官方插件页上渲染贡献并核对各自的 subject，钉住投影；`browser-plugin.client.spec.tsx` 钉住声明。`apps/web/tests/plugin-config.e2e.ts` 打开夹具组合包，断言组合包页与行页上的操作、标签和区块、官方插件页上没有它们，并保留组合包页的 golden。
