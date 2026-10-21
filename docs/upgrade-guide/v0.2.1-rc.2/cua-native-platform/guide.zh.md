---
kind: upgrade-guide
description: "自定义原生 CUA helper 的权限响应必须带平台标记，提供方集成必须移除 CuaBackend.description。"
---

# 原生 CUA 平台接口

[English](guide.md) | 中文

## 变更

原生 CUA 的 `permissionStatus` 和 `requestPermission` 响应必须带 `platform` 判别字段。macOS 响应使用 `darwin`，并保留权限和进程字段。Windows 响应使用 `win32`，包含 `sessionLocked`、`captureAvailable`、`elevated` 和 `helper`。自定义 `helperPath` 返回未标记的响应会被拒绝。面向模型的 `getCapabilities.platform` 名称保持不变。

导出的 `CuaBackend` 不再接受 `description`。共享执行器负责操作工具说明；提供方仍通过 `guidance` 提供平台指引。

对象 API 的 `getApp` 和 `getWindow` 现在静默读取初始 AX 状态。选择应用或窗口不再自动输出 AX 树。

## 迁移

1. 使用随包原生 helper 时，一起升级 CUA 包，无需编辑 profile。
2. 设置了 `helperPath` 时，按当前协议重新构建该 helper。在 macOS 权限响应中添加 `platform: "darwin"`，或实现 [`CuaSystemPermissionState`](../../../../packages/experimental/cua/src/access-types.ts) 中的 Windows 响应字段。
3. 在自定义提供方集成中，从传给 `installCua` 的对象中移除 `description`，把平台指引保留在 `guidance` 中。
4. 如果脚本依赖选择操作输出 AX 树，请随后显式调用 `await app.getAXState()` 或 `await window.getAXState()`。选择操作仍会初始化元素索引。
5. 重启提供方并打开 Computer Use 详情，确认状态查询成功且显示对应平台的访问控件；重新构建自定义 TypeScript 消费者，检查更新后的接口。
