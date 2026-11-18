---
description: "通过 Realm 注册表提供可选的同源 iframe 脚本环境。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-script-realm-iframe

[English](README.md) | 中文

## 概述

当框架代码明确需要拥有独立浏览器全局对象、同时保留直接对象引用的环境时使用此提供方。加载插件只注册 `iframe` 工厂，不分配 frame。它不会迁移应用插件，也不会改变插件的默认执行环境。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

普通 Client 插件注入 `scriptRealms` 并注册工厂。组合必须提供[注册表](../script-realm/README.zh.md)；两个包都不是默认应用条目。提供方不接受配置。

<a id="understand-the-implementation"></a>
## 理解实现

每次请求创建一个隐藏的同源 iframe。`expose()` 安装直接引用，不替换已有或保留的全局对象。`execute()` 加载外部 classic script，并相对提供方页面解析 URL。取消或销毁会拒绝进行中的执行并移除 frame。调用者负责销毁已创建实例。

<a id="further-exploration"></a>
## 进一步探索

- [Client 模块](../modules/README.zh.md)
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)
- [Client 入口](src/client/index.ts)

<a id="model-experience"></a>
## 模型体验

无；本包是可选的浏览器基础设施，不注册面向模型的工具或提示词。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 同源访问不提供恶意代码隔离。原生 `window`、`document`、视口、计时器和 DOM 构造器属于 iframe；本包不透明模拟主页面。模块放置、池化和 Shadow DOM 留待后续设计。

<a id="dev-note"></a>
### 开发备注

无。
