---
kind: upgrade-guide
description: "Computer Use 应用授权从 profile 配置迁移到按 profile 隔离的持久存储。"
---

# Computer Use 授权存储

[English](guide.md) | 中文

## 变更

Computer Use 通过 `storageDomain` 保存应用授权。使用默认 JSON 后端时，每个 profile 的真实目录对应独立的 `$DSH_HOME/storages/cua_permissions_<sha256>.json`。“本会话允许”现在按对话 ID 跨 DSH 重启和 Computer Use 启停保留，不授权其他对话。无法验证签名的应用仍需匹配本机进程身份，应用重启后可能需要重新授权。

`allowedApps` 作为旧数据来源，只在首次访问存储时导入一次。此后修改配置不会授予或撤销访问权限，重新加载旧配置也不会恢复已撤销的许可。权限页继续提供授权管理和清除拒绝的操作。macOS 系统权限保持原样。

## 迁移

1. 保留 profile 的现有存储服务。随附 profile 已包含 `storageDomain` 和 JSON 后端，自定义 profile 需要挂载相同服务。有 profile 但没有域存储时，授权操作会被拒绝。
2. 启用 Computer Use 并打开详情页，初始化存储。确认始终允许的应用显示正确。
3. 确认后，从 profile 配置及其他覆盖层的 CUA 条目中删除 `allowedApps`，保留其他 CUA 配置。
4. 在权限页撤销应用授权或允许再次询问。旧进程内已有的会话许可无法恢复，升级后需要重新授予一次；新授予的会话许可随后可跨重启保留。
5. 将存储文件作为该 profile 的状态保留。把 profile 移到另一个真实目录后会使用不同存储。文件锁协调同一电脑上的进程，不支持多台电脑共用网络文件系统。
