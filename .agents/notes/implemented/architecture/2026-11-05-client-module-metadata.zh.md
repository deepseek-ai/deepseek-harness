# Agent Note: Client 元信息与 Renderer 持有的样式安装

Status: implemented

[English](2026-11-05-client-module-metadata.md) | 中文

## Problem

脚本执行环境不一定是其呈现文档。JavaScript factory 内的 CSS 注入把两者耦合，并让模块加载负责 DOM 清理。从 React 组件推断样式归属会增加组件级跟踪，却无法获得可靠的源文件对应关系。

## Decision

Client 产物包含 `id` 和 `factory`，可选带有 `meta`，动态包内 chunk 另带 `chunk` 名称。`meta()` 返回资源描述；可选的 `stylesheets` 是以路径为键的字典，每个值提供独立求值的 `text(context)` 函数。资源路径标识样式表，而不是组件。当前没有样式表依赖字段。

Modules 拥有 JavaScript 导出、模块身份、owner id 和观察到的依赖边。它保存元信息函数而不求值，发布通用的模块记录变化。Renderer 拥有元信息／文本缓存、依赖有序的样式集合、路径去重与主文档节点。它在 React 挂载前显式安装已有资源，随模块变化更新，并在根卸载后释放样式。组件生命周期不拥有样式。

静态库构建把 index 产物保持为普通 ESM，保留所有 import 与动态 import 交给最终外壳组装，并增加携带相同 manifest 的 `__$dsh_client_module_manifest` 导出。启动外壳本身保持普通 ESM。Modules 用内建 Main 环境包装原有载体加载 hook；可选 Realm 提供方不改变默认启动，也不选择插件放置。

本决定细化[加载模型](2026-07-23-client-plugin-loading-model.zh.md)中的资源处理，以及[外壳分层](2026-08-15-client-shells-and-dynamic-packages.zh.md)中的产物描述。两份记录的模块身份、自举和依赖分离仍然有效，没有完全被取代。

## Alternatives considered

**每个 factory 内操作 CSS DOM。** 这会使用脚本的全局对象，并把呈现副作用藏在模块求值中；元信息将数据生成与安装分离。

**组件分析、Hook 或 Slot 来源元信息。** 所需生命周期是模块级，精确组件跟踪会增加分配和清理，却没有对应的必要能力。

**静态库复用动态插件的私有依赖打包。** 这会把第三方惰性拆包和字体交付移到包构建，改变既有外壳依赖策略。静态库因此保留原策略。

**Document Scope 与提前 Realm 激活阶段。** 所有模块使用原 Main 载体、所有样式装到主文档时，不需要这两者。隔离请求、环境分配和多个呈现目的地属于独立工作。

## Consequences

Modules 没有样式查询或订阅 API。样式失败由 renderer 消费方报告，不是 JavaScript factory 失败：renderer 不安装失败的样式，报告一次，并安装其余样式，因此单个模块不会阻止应用挂载，也不会影响之后加载的模块的样式。实时替换期间，旧记录保留在 `activeRecords()` 中，直到被替换的运行时完成卸载，因此下载未完成或失败时，运行中的插件仍保有样式。已物化但当前不可见组件的样式保留到模块失效或 renderer 销毁。源码业务 import 仍通过 factory 支持的 `require` 取得原有导出。
