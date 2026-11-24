---
description: "注册可选脚本环境提供方，并创建由调用者持有的 Realm 实例。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-script-realm

[English](README.md) | 中文

## 概述

当 Client 扩展需要具名脚本环境提供方时使用本包。注册不会创建环境；创建返回由调用者负责清理的实例。默认 Web 名册把注册表作为普通 entry 加载，只有在某个包请求脚本隔离时，应用启动才等待它。模块加载器保留自己的 Main 执行环境，只为请求脚本隔离的包使用已注册的提供方。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

普通 Client 插件提供 `ctx.scriptRealms`。提供方插件注入 `scriptRealms`，通过绑定 effect 生命周期的 `register()` 操作登记工厂。返回的 disposer 是异步的；提前移除注册的调用者需等待它完成，插件退出则负责自动移除。本包不声明配置；默认 Web 名册包含本包。

<a id="understand-the-implementation"></a>
## 理解实现

注册表插件激活时，如果 `loader.internal` 上已挂载实现本包 `ScriptRealmRegistryHost` 接口的页面模块系统，插件就调用 `modules.installRealmRegistry(this)` 将自身安装到该系统。插件卸载时只撤下自己的注册表，不会移除已接替它的实例。如果激活时没有这样的模块系统，`ctx.scriptRealms` 仍可作为独立的 Cordis 服务使用；之后再挂载 Loader 不会触发安装。

`create()` 按名称解析已注册提供方，并传入调用者提供的身份与取消信号。移除提供方后不能通过该注册继续创建实例，但不会销毁已经返回的实例。注册表不负责给模块分配环境；[Client 模块](../modules/README.zh.md)为脚本隔离的包选择环境。

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

- 能力匹配、环境复用以及把多个包放入同一环境尚未实现。Script Realm 保留直接引用，不是安全沙箱。

<a id="dev-note"></a>
### 开发备注

无。
