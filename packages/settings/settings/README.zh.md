---
description: "面向插件作者与维护者的用户设置服务：注册可配置 namespace、读取解析值或接入配置界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-settings

[English](README.md) | 中文

## 概述

当用户需要在运行时修改插件配置，而无需重启或重新读取 `cordis.yml` 时，请使用本包。每个 namespace 合并 schema 默认值、部署配置与用户覆盖；读取方会得到深冻结的解析值快照，并可观察已提交的变更。写入只影响用户覆盖、按 namespace 串行执行，并可拒绝陈旧 revision，避免覆盖较新的变更。持久化运行时编辑需要先配置设置存储；否则插件仍可继续使用组合配置。

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

插件与配置界面通过 `ctx.settings` 在运行时读取并修改配置。常用路径：挂载提供方、用 schema 注册 namespace、读取并观察解析值，并通过 owner scope 写入。

### 何时选择

当插件的配置需要在运行时可变——用户编辑文档或配置界面修改——且无需重启或重读 `cordis.yml` 时，选择设置服务。它适合多个插件各拥有一个配置 namespace、以及配置界面需要渲染 schema、标记用户覆盖字段并持久化编辑的场景。当配置在加载时固定则没有必要：没有挂载提供方时一切照旧，配置保持组合原样。

### 挂载提供方

服务本身不存储任何内容；请挂载一个提供方，例如随附的文件型提供方：

```yaml
- name: '@deepseek-ai/dsh-settings-file'
  config:
    path: /absolute/path/to/settings.yaml
```

提供方上线后 `ctx.settings` 即出现。完整配置面由提供方 README 负责；生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-settings-file)列出每个受支持字段。

### 注册 namespace

插件用 schemastery schema 注册自己的 namespace，并可选地把组合配置作为 `base` 层传入，让解析值从部署已配置的内容起步：

```text
const scope = ctx.settings.register('ui-theme', ThemeSchema, {
  base: config,   // composition entry config; the user layer resolves above it
})
const theme = scope.get()              // deep-frozen resolved snapshot
scope.update({ density: 'compact' })   // merges into the user section and persists
```

TypeScript 会按小写字母、数字与连字符文法检查字面量 namespace 参数；运行时动态传入的字符串接受相同校验。`ctx.settings.installSection(owner, ns, schema, entry, hooks)` 为消费方插件封装可选服务接线：只要设置服务存在，它就用插件的组合配置作为 `base` 注册 namespace；服务消失时插件回退到组合配置，行为与原先完全一致。

### 读取与观察值

`get(ns)` 以深冻结快照返回解析值，namespace 未注册时为 `undefined`。`watch(callback)` 在每次已提交变更后以 `(next, prev)` 调用回调：同一回调的调用按提交顺序逐个执行，异常被隔离并记入日志，因此慢或抛错的观察者绝不会阻塞或破坏其他观察者。

### 写入值

`update(ns, patch)` 把普通对象 patch 深合并进用户分节——绝不进 `base`——校验解析候选值、经提供方持久化后提交。`replace(ns, section)` 整体替换用户分节，是删除/重置路径：`replace({})` 重新继承 `base` 与 schema 默认值。`mutate(ns, ops)` 在写入排到队首那一刻的分节上按序施加 `{ op: 'set' | 'unset', path }` 编辑——这是持有不完整（例如脱敏后）视图的调用方的删除路径，因为按协议接口返回的内容重建分节再整体替换，会删掉协议从未回传的每个字段。

每次写入都会拒绝与 JSON 不兼容的数据（`Date`、`Map`、`BigInt`、非有限数或循环引用会在任何内容持久化前以 `$` 为根的路径报错）、拒绝只读提供方上的写入，并可接受可选的 `expectedRevision`：把 descriptor 中的 `revision` 传回，namespace 已越过该值时写入会被 `SettingsConflictError` 拒绝，而不是覆盖先完成写入的一方。

### 配置界面

`describe()` 为每个已注册 namespace 返回一条 descriptor：序列化 schema、解析值、分离的 `base` 与 `user` 层（字段出现在 `user` 中即标记为用户覆盖）、生效时机与 namespace 的 revision。每个协议接口都必须传入 `redactSecrets: true`：它从每一层剥离 `role('secret')` 字段，并把它们枚举为 `{ path, set }` slot，让页面可以渲染只写输入而不接触任何机密。`documentPath` 与 `prepareDocument()` 在提供方拥有用户可编辑文件时把它暴露给原生编辑器。

### 事件与失败

`settings/updated (ns, next, prev, source)` 在每次已提交变更后触发——进程内写入（`source: 'update'`）或外部观察到的编辑（`source: 'provider'`）——解析值深相等时绝不触发。`settings/document-updated (ns, revision)` 在原始用户分节发生变化时触发，即使解析值没有变——已打开的编辑器正需要它来得知字段从继承变为覆盖。schema 拒绝的存量分节在重载时保留该 namespace 的最后可用值并告警；注册时同样的失败会直接拒绝注册。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **分层解析，单一用户层。** namespace 的值依次为 schema 默认值、注册方的组合 `base`、用户文档分节；写入只触碰用户层，因此 `replace({})` 是真正的重置。
- **提交以深相等为门槛。** 只有解析值变化时 `settings/updated` 才触发；原始分节事件独立存在，因为配置界面还必须得知「继承变成了覆盖」。
- **写入排队并做 revision 检查。** 每个 namespace 的写队列按调用顺序串行，`expectedRevision` 在队首判断——那里服务才能分辨持有新鲜快照的写入方与持有陈旧快照的写入方。
- **观察者与监听器异常被隔离。** watcher 调用与事件扇出隔离同步抛出与异步拒绝，一个坏掉的观察者不会卡死提交或提供方的重载循环；`INVARIANT` 编码的失败在所有监听器执行完后重新抛出。
- **注册是 fiber 上的 effect。** 注册 namespace 是调用方插件 fiber 上的 effect：dispose（资源释放）该 fiber 即移除 namespace 及其观察者。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition：namespace 校验、注册、解析、写队列、describe/脱敏、事件、`installSection` |
| [`src/redact.ts`](src/redact.ts) | `redactSecrets` 遍历器：剥离 `role('secret')` 字段并枚举其 slot |
| [`src/types.ts`](src/types.ts) | 客户端安全类型面：事件声明、`SettingsNamespace`、`SettingsUpdateSource` |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：`settings/updated` 只对已注册 namespace、只在解析值变化时、且携带权威值触发 |

### 解析与写入路径

每次写入都在调用时对输入做快照（分离并校验 JSON 形状的数据），然后排上该 namespace 的串行链。在队首，服务按当前状态重读分节、检查 `expectedRevision`、合并/替换/编辑、经 schema 与 owner 的可选 `validate` 解析并校验候选值、经提供方持久化，然后才提交并发出事件。registrant fiber 在写入途中被 dispose 的写入仍到达存储，但不会提交、也不会通知任何人；卸载先拒绝新写入，并排干排队写入与已启动的 watcher 调用后才完成。

### 变更检测与事件

`commit` 用 seam 的 `deepEqualJson` 谓词比较解析值，并逐监听器扇出 `settings/updated`。`bumpRevision` 比较原始分节并携带新 revision 发出 `settings/document-updated`；它与解析值检查相互独立。两个扇出以相同方式隔离监听器异常。

### 客户端安全类型

`./types` 子路径出口持有事件声明及其签名点名的 `SettingsNamespace`、`SettingsUpdateSource` 类型，包根继续 re-export 这些类型。于是 Host 编译面之外的消费方读到的正是 Host 发射的那一份签名，而不必再写一遍。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当服务级约定不够用时阅读以下页面。它们从共享子系统词汇逐步进入随附提供方与能力架构。

- [设置子系统参考](../../../docs/subsystems/settings.zh.md)——namespace、注册、owner scope、descriptor、变更提交与生成的 cordis 接口面。
- [文件型设置提供方](../settings-file/README.zh.md)——随附的 YAML/JSON 提供方：配置、热重载、保留注释的写入。
- [设置包映射](../README.zh.md)——用户设置能力的两个包及其角色。
- [能力 seam](../../../docs/capability-seams.zh.md)——本服务遵循的 Service Definition / Service Provider / Consumer 拆分。

-----

<a id="model-experience"></a>
## 模型体验

间接生效：由设置值提供的所有面向模型的内容均由消费方插件负责；本服务只存储并解析用户设置，自身不注册任何面向模型的内容。

#### KV Cache 影响

无直接失效；把设置值纳入请求前缀的消费方负责该变更。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本服务何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **单一用户层**——解析只认识 schema 默认值、一个组合 `base` 与一个用户文档；它不记录每个解析值由哪一层提供。
- **`redactSecrets` 并非一条可被证明的协议边界**——遍历器只跟随 `object`/`dict`/`array` 容器，因此只能经由 union、intersection 或 transform 抵达的 `role('secret')` 字段会被原样返回，且 `secrets` 列表为空；序列化 schema 还会把 secret 字段的默认值带给每个客户端。两种情况都不会被拒绝；机密无法经由被遍历的容器抵达的 schema，绝不可注册到暴露于协议的 namespace 上。fail-closed 的 `describeForWire()`——拒绝自己无法证明安全的 schema，并对序列化封装与错误文本做净化——是暂缓的答案。
- **跨进程并发由提供方定义**——服务仅在进程内按 namespace 串行写入；跨进程并发按提供方行为收敛（文件提供方在写锁下读-改-写，因此并发写入者不会丢掉彼此的 namespace，同 namespace 冲突按后写胜出解决）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的开放设计方向。它明确非权威——已发布的行为、限制与已接受的理由见上文各节与包代码。代码 TODO 中记录的开放方向：把公开的 `ns` 参数更名为 `namespace`（API、提供方约定、实现、测试与消费方同步）；释放注册项时停用所有 watcher 并等待其调用链完成，确保回调不会在 registrant fiber 释放后继续运行；替换注册从持久化分节重新解析，让进行中的旧写入不会把它留成陈旧值；改用属性安全的对象构造，让 `__proto__` 这类合法 JSON 键保持为自有数据。fail-closed 的 `describeForWire()` 净化器是上文脱敏限制的暂缓答案。

</details>
