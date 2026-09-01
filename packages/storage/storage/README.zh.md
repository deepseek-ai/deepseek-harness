---
description: "存储枢纽（ctx.storage）：面向选择、挂载或排查具名存储后端与数据形式设施的组合方与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-storage

[English](README.md) | 中文

## 概述

挂载 `dsh-storage` 即可为组合提供持久的非会话存储：它是后端与数据形式交汇的枢纽（hub），宿主包因此可以通过 `ctx.storageDomain` 读写类型化记录。枢纽自身不执行任何 IO——后端拥有介质（一个文件树根目录、一个数据库文件），数据形式拥有语义——因此组合会把它与一个或多个后端以及领域数据形式一起挂载。它是可选项，且只面向宿主侧：不注册工具、不注入提示词，也不写入会话事件，因此模型与 agent loop（智能体循环）永远不会看到它。只要组合中任何包需要会话事件日志以外的持久数据就选择它；没有任何此类数据的组合可以省略整个组。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

使用本包为组合提供持久的非会话存储：把它与后端和数据形式包一起挂载，宿主包即可通过 `ctx.storageDomain` 读写经过校验的记录。枢纽自身不增加任何可观察行为——它是让整个家族运转起来的交汇点——以下内容就是组合从它得到的一切。

### 何时使用

当组合中任何包需要持久化会话事件日志以外的数据——工作区记录、会话伴随数据——时就挂载枢纽。领域数据形式与两个内置后端都依赖它，因此组合的存储行是 `storage` 加一个后端加 `storage-domain`。没有任何此类数据的组合可以省略整个组；agent loop 永远不需要它。

### 最小组合

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: /var/lib/dsh/data
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

这些行加载后，`json` 后端注册自身、`domain` 数据形式挂载；诸如 `dsh-workspace` 之类的消费方随后在已路由后端上打开自己的领域，并通过 `ctx.storageDomain` 读写记录。多个后端可以并排保持挂载；哪个后端服务哪个领域由领域数据形式的配置决定，绝非枢纽的全局选择。

### 你能得到什么

- 已挂载的后端按名称解析，因此同时挂载两个内置后端的组合可以把每个领域按配置路由到任一种介质。
- 已挂载的数据形式解析为 `ctx.storage.<form>`；领域数据形式还直接以 `ctx.storageDomain` 对外服务。
- 错误配置会以稳定的 `StorageError` 代码明确报错，而不是静默推迟：未知的后端名称、在其所有者挂载前读取数据形式、或重复注册都会抛出异常。

### 失败与恢复

- `backend-not-found`——领域数据形式路由到未挂载的后端；请添加后端包。数据形式会等待所有已配置后端注册，因此行序不会造成失败。
- `form-not-mounted`——消费方在 `dsh-storage-domain` 加载前读取 `ctx.storage.domain`；请把领域行放在消费方之前。
- `duplicate-backend`／`duplicate-mount`——同一名称或形式注册了两次；这是组合错误，会明确报错。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

枢纽是一张纯注册表，拥有两个面，设计目标是后端与数据形式可以独立替换，而枢纽无需了解它们的内部实现。

### 设计理念

- **后端拥有介质，数据形式拥有语义。** 枢纽从不执行 IO；它只持有名称 → 后端表和形式名 → 设施表。后端包注册其介质所有者，数据形式包挂载其设施，双方都不需要对方的细节。
- **多个后端并排共存。** 哪个后端服务哪个消费方由消费方自身的配置决定（领域数据形式的路由表），绝非枢纽全局的二选一。
- **注册与挂载都是 effect。** `register()` 与 `mount()` 返回资源释放函数；释放只移除该次注册的贡献，且不会关闭后端——由所属插件在注销后关闭。
- **激活不会与注册竞争。** 每个后端插件还会发布一个仅用于生命周期的服务键（`storage.backend.<name>`）；数据形式提供方注入这些键，因此领域数据形式只在所有已配置后端注册后激活，而调用方仍通过枢纽按名称解析后端。

### 后端约定

[`src/backend.ts`](src/backend.ts) 是后端实现者的规范性约定，由 `tests/contract.ts` 中的共享一致性套件逐条款检查。一个后端只拥有一种介质，并暴露可选的数据形状分面；`kv` 是唯一的分面，打开单元即可获得一个带版本、全局单例的 schema 句柄，其每次单独调用都是原子的，且 resolve 后即已持久。单元名与表名必须匹配 `UNIT_NAME_RE`；记录键是任意字符串，绝不进入文件路径。单元不对并发写入做串行化——顺序由调用方负责——介质上记录的版本与描述符不同时拒绝 `version-mismatch`（不做迁移）。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Storage` 服务、数据形式挂载、`StorageForms` 表 |
| [`src/registry.ts`](src/registry.ts) | `BackendRegistry`：名称 → 后端表、注册资源释放函数 |
| [`src/backend.ts`](src/backend.ts) | 后端约定：分面、单元、`UNIT_NAME_RE` |
| [`src/error.ts`](src/error.ts) | 枢纽与每个后端共享的 `StorageError` 代码 |
| — | 不发布运行时不变式伴生入口；纯注册表。 |
| [`tests/contract.ts`](tests/contract.ts) | 针对每个后端运行的共享一致性套件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当枢纽视角不够用时阅读以下页面：子系统参考是权威约定，Agent Note 记录了家族设计与延期工作。

- [存储子系统](../../../docs/subsystems/storage.zh.md)——后端约定、领域语义、变更事件与生成的 API。
- [存储包映射](../README.zh.md)——家族的各包及其在仓库中的位置。
- [领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)——枢纽、领域数据形式与会话后端迁移背后的设计。

-----

<a id="model-experience"></a>
## 模型体验

### 后端与形式注册

#### 模型看到什么

无。`ctx.storage` 是宿主侧注册表：枢纽不注册工具、不注入提示词，也不写入会话事件，因此任何请求字段都不会携带本包的数据。

#### Token 影响

每次请求都不会直接增加 token。

#### KV Cache 影响

与实时请求相互独立：枢纽绝不触碰请求前缀，因此无法使提供方缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了枢纽不能做什么。它们是当前包约束，不是任务积压。

- **`kv` 是唯一的数据形状**——后端只实现一个分面；面向会话事件日志的 `log` 分面被推迟到会话后端迁移（[Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)）。
- **数据形式按需解析**——在领域插件挂载前读取 `ctx.storage.domain` 会抛出 `form-not-mounted`；组装会按相应顺序排列插件，而不是静默推迟。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
