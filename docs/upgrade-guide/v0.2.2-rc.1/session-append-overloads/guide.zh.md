---
kind: upgrade-guide
description: "替换 Session.append 的代码必须实现单事件和数组两种重载。"
---

# 更新 `Session.append` 的替代实现

[English](guide.md) | 中文

## 变更

在 v0.2.2-rc.1 中，`Session.append` 只有一个调用签名。现在它可接收一个带类型的事件调用，也可接收事件元组数组。普通单事件调用仍可编译。赋值给 `Session['append']` 的测试替身和包装函数必须支持两种重载。

## 迁移

1. 包装 `Session.append` 时，用 `Proxy` 包装原函数，在 `apply` 拦截器内用 `Reflect.apply` 转发，以保留两种重载。若测试替身只接收单个事件，给该辅助函数单独声明类型并在相应测试中调用。
2. 检查赋值给 `Session['append']` 的代码能通过类型检查。分别以 `append('turn/start', { turn: 1 })` 和 `append([['turn/start', { turn: 1 }]])` 调用替代实现，验证前者返回一个事件，后者返回数组。
