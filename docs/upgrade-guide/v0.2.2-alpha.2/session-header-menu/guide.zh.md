---
kind: upgrade-guide
description: "使用 session-log-export 的自定义 Web 组合必须提供右键菜单服务。"
---

# 会话导出需要右键菜单服务

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-log-export` 的浏览器半包需要 `contextMenus` 来渲染头部更多菜单。此前挂载 session-log-export 但没有右键菜单提供者的自定义 Web 组合必须补充该提供者，否则浏览器插件会等待缺失的服务。默认 Web 组合已包含提供者。Host 导出路由及 `/export` 命令不变。

## 迁移

1. 自定义 Web 组合缺少提供者时，将 `@deepseek-ai/dsh-client-ui-context-menu` 加入 session-log-export 所在的客户端插件树，并提供菜单包要求的服务。参见[右键菜单组合](../../../../packages/client/ui-context-menu/README.zh.md#use-this-package)。默认 Web profile 无需修改配置。
2. 重启 profile，打开会话头部更多菜单，确认复制会话为 Markdown 与下载会话日志可用，并确认下载仍显示会话范围的弹窗。
