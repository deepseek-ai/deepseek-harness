---
kind: upgrade-guide
description: "子代理服务移除 drainChildren、listChildren 和 list。"
---

# 子代理服务方法移除

[English](guide.md) | 中文

## 变更

`ctx.subagents` 移除 `drainChildren(parent, childIds)`、`listChildren(parentSessionId, signal?)` 和 `list()`。这会影响按 id 释放驻留子代理、通过服务读取直接子级目录或枚举已注册 provider 名称的插件。

## 迁移

1. 保留 `startActivation()` 返回的 activation，并等待其 `dispose()` 完成以释放那一次执行。旧 activation 不能释放同一 Session 后来恢复的执行。按 id 释放当前驻留子代理没有替代方法；仅在关闭整棵树时使用 `drainDescendants([root])`。`interrupt()` 停止当前工作，但保留本地 Activation。
2. 读取直接子级条目时，使用 `ctx.sessionQuery.observeSession(parentSessionId, { signal })`，读取 `observation.projections?.values.subagentCatalog`，并通过 `using` 释放观察对象。加载 Session Query 和子代理服务，并将缺失的目录投影视为不可用。递归发现继续使用 `listDescendants()`；它返回的行与直接目录条目不同。
3. 使用 `getProvider(name)` 检查已知 provider 名称。服务不再枚举全部已注册名称。
4. 根据更新后的服务声明重新构建插件，验证注册和卸载检查、指定 activation 的释放以及目录观察对象的清理。
