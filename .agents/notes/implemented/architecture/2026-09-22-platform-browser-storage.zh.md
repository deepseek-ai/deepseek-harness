# Agent Note: 按账号隔离的 Platform 浏览器存储

Status: implemented

[English](2026-09-22-platform-browser-storage.md) | 中文

## Problem

内嵌 Platform 通知将关闭状态写入 localStorage。一次性浏览器分区会在每次关闭视图后丢失该偏好。

## Decision

Desktop 使用 Platform 来源和稳定账号 ID 的 SHA-256 哈希划分浏览器存储。持久分区跨视图和应用生命周期保留 localStorage 页面偏好，包括退出登录后再次登录同一账号。分区名不包含原始账号 ID 或 token。在 Host 尚未从成功的资料读取获得账号 ID 期间，视图使用一次性分区，因此准备 Platform 会话不会等待资料请求。同一凭证下账号 ID 迟到时，已挂载的一次性文档保持不变；下次打开使用账号分区。

持久分区只保留 localStorage；打开持久分区会先清理 Cookie、文件系统、IndexedDB、Cache Storage、HTTP 与着色器缓存、Service Worker 及 HTTP 认证状态，而一次性分区会清理其全部存储。关闭视图会销毁文档、移除携带凭证的请求拦截器并安排相同的清理，因此异常退出遗留的认证会在下一个文档加载前被清除。下次打开和应用退出都会等待该清理完成，更新安装也会在安装器接管退出前等待；退出流程上报清理失败，而不阻塞退出。清理失败会使该次打开失败，并在后续清理成功前阻止同一账号再次打开，其他账号不受影响。仅限 Host 的凭证仍通过现有 preload 传入受信任页面，bridge 不会将其写入浏览器存储。

## Alternatives considered

共享分区会混用账号偏好。以 token 命名会在凭证变化时丢失偏好。专用于通知的原生 API 会重复承担 Platform 偏好管理职责，并要求前端同步修改。只在关闭视图时清理，会让异常退出遗留的认证被下一个文档读取。

## Consequences

偏好仅保存在此 Desktop 浏览器数据目录中，不跨设备同步。Platform 脚本仍须可信地处理收到的凭证；持久站点存储不是凭证保险库。已退出账号的存储会保留在磁盘上，直到该账号再次登录或浏览器数据目录被删除。真实 Electron 回归测试验证视图重建、账号切换和进程重启后的通知关闭状态，并断言 Cookie、Cache Storage 和 IndexedDB 已清理、页面 beforeunload 处理函数不会阻止关闭、一次性会话既不继承也不保留偏好，以及上一进程遗留的 Cookie 已清除。
