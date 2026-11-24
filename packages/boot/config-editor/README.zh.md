---
description: "保存当前 profile 配置，并通过 Loader 应用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-config-editor

[English](README.md) | 中文

## 概述

将插件配置保存到当前 profile 的 patch 并立即应用。调用方还可以新增一行、移除该 patch 新增的行，并替换已停用或启动失败的行的配置。写入与 profile 更改及 HMR 串行执行。运行中的插件在文件改动前验证完整候选值，更高层覆盖不会改动文件。写入的行未能启动时，文件恢复为之前的内容。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

在具有 Loader 和 `profileContext` 的 profile 应用中挂载此服务。它没有配置字段。

```yaml
- id: config-editor
  name: '@deepseek-ai/dsh-config-editor'
```

使用 [settings](../../settings/settings/README.zh.md) 提供只编辑即时字段的表单。编辑完整配置的调用方可使用 `ctx.configEditor.edit()`；普通字段保留 Loader 的正常生命周期。

管理行的调用方还有三个操作。`insert()` 把一行追加到 profile patch 并启动它。`remove()` 删除 profile patch 插入的行，以及该 patch 对这一行的覆盖项；`configuration()` 用 `inserted` 标记这样的行，`remove()` 拒绝其他所有行。`editRow()` 与 `edit()` 一样替换一行的配置，并且接受已停用或启动失败的行：这样的行按原样保存配置，由其插件在下次启动时验证。

`insert()` 或 `editRow()` 写入的行在写入后必须处于激活状态，已停用的行除外。该行启动失败或等待服务时，调用以激活诊断拒绝，文件恢复为之前的内容。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[编辑器](src/index.ts) 在派生候选配置前应用外部更改，与其他 profile 操作共同锁定 profile manifest，并原子替换 profile patch。配置编辑替换该行的配置覆盖项。插入写在文件末尾：最后一个 patch 项插入顶层行时写入该项，否则写入新的 insert 项，因此已有的 profile patch 项都不作用于新行。编辑器保留替换值以外的 YAML 注释和 `!!js` 表达式；被删除的顶层 patch 项上方的注释保留在文件中，对第一项而言它就是文件头注释。应用失败时恢复之前的文档并重新加载之前的 patch，调用方收到自身写入的拒绝。

读取配置时，没有 profile config 覆盖项的条目共用一次组合结果。有覆盖项的条目分别组合，仅移除自身的覆盖项；profile 插入的条目和其他条目的覆盖项仍然生效。返回的配置为独立副本，组合结果不跨读取缓存。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Profile 加载](../app-boot/README.zh.md)——patch 组合。
- [HMR](../hmr/README.zh.md)——重载协调。
- [设置](../../settings/settings/README.zh.md)——schema 派生表单。

<a id="model-experience"></a>
## 模型体验

通过面向模型的插件读取的配置值间接影响模型。

#### KV Cache 影响

改变请求前缀的消费者决定缓存影响。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 编辑写入当前 profile patch。Home patch 和命令行 overlay 参与优先级解析，但不作为写入目标。
- 完整配置覆盖保留普通字段，但会在 profile 层固定其当前原始值。
- 仅可编辑 profile 根 Include 拥有且可唯一定位的条目。
- `remove()` 只接受 profile patch 的 `insert` 项直接列出的行。位于被插入的 group 内的行，以及由组合包或更高层添加的行，无法移除。移除被插入的 group 时，profile patch 中以其嵌套行为目标、或向该 group 插入行的项会留在文件中，这些项不再生效。
- `insert()` 与 `editRow()` 无法为等待服务的行保存配置，因为写入的行未停用时必须在写入后处于激活状态。
- 写入被拒绝后，编辑器应用之前的 patch。这次应用也被拒绝时，编辑器把它的拒绝记录为警告，其中指名的行保持未激活，调用方只收到自身写入的拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
