---
kind: upgrade-guide
description: "自定义 Web 组合必须为会话操作提供右键菜单服务，导出弹窗在切换 Session 后仍保持显示。"
---

# 会话头部菜单与导出弹窗

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-log-export` 的浏览器半包需要 `contextMenus` 提供复制、下载和反馈操作。没有右键菜单提供者的自定义 Web 组合必须补充，否则这些客户端操作无法激活。默认 Web 组合已包含提供者。头部更多按钮由 `ui-conversation` 持有，因此移除导出插件不会移除其他已注册的头部操作，例如在应用中打开。没有注册任何头部菜单提供者时，按钮隐藏。

下载弹窗挂载于根级 `shell.overlay`，不再位于 Session Header。弹窗标明正在导出的 Session，切换 Session 后仍然显示。多个下载可以并行进行，但弹窗按发起顺序一次展示一个；关闭当前弹窗会展示下一个，不取消其下载。Host 导出路由及 `/export` 命令不变。

## 迁移

1. 自定义 Web 组合缺少提供者时，添加 `@deepseek-ai/dsh-client-ui-context-menu` 并提供菜单包要求的服务。参见[右键菜单组合](../../../../packages/client/ui-context-menu/README.zh.md#use-this-package)。保留 `ui-conversation` 以提供会话头部，以及 shell 的根级 overlay 以展示下载反馈。默认 Web profile 无需修改配置。
2. 使用 `SessionLogDownloadDialogProps` 的自定义客户端代码需改用根级 overlay runtime props，不再使用 Session Header props，并移除 `request` 注入。`SessionLogDownloadEntry` 包含 `order` 值；弹窗从 `bySession` 读取 Session 身份与顺序。
3. 重启 profile，确认头部更多菜单包含已注册的操作，禁用导出插件后仍可在应用中打开，并确认两个 Session 的下载弹窗按发起顺序显示，切换 Session 后仍然保留。
