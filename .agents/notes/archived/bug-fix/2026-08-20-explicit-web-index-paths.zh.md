# Agent Note: 显式 Web index 路径与静态资源未命中的 404

Status: implemented
Archived: 2026-09-04

[English](2026-08-20-explicit-web-index-paths.md) | 中文

## 问题

无条件 SPA 回退会让每个未匹配的 GET 或 HEAD 请求看起来都成功。失效的普通链接，以及缺失的 JavaScript、样式表、source map 或 manifest，都会收到状态码为 200 的 HTML 外壳，导致浏览器、缓存与监控无法区分有效页面入口和缺失资源。

## 决策

`dsh-host-frontend-static` 只在规范化目标为 dist 根目录或配置的 index 路径时渲染 `index.html`。当前 Web 客户端没有 History API pathname 路由；查询字符串不会改变 pathname 匹配，URL 片段也不会到达服务器。现有文件照常提供，而 `ENOENT`、`EISDIR` 和 `ENOTDIR` 读取产生不带内容类型的空 404 响应。其他文件系统失败会重新抛给 webserver 的请求失败处理，不会被错误标记为缺失。

GET 与 HEAD 对 index 入口、文件和未命中项使用相同的状态码与内容类型。具名路由仍先于回退匹配，越出 dist 根目录的遍历仍返回 403，到达回退的非 GET/HEAD 请求仍返回 405。

## 曾考虑的替代方案

**根据路径没有文件扩展名来推断页面路由。** 文件扩展名不会声明客户端路由：这种做法仍会把未知普通路径变成成功页面，会拒绝未来任何带点号的客户端路由，也会在缺少无扩展名静态文件时错误处理该请求。

**把 `Accept: text/html` 请求头作为回退规则。** 该请求头表达的是内容表示偏好，而不是 pathname 是否为已声明的客户端路由。浏览器 fetch、机器人和监控都可能为无效路径请求 HTML，因此仍会产生同样的假成功行为。

**添加可配置的 pathname 允许列表。** 当前没有客户端路由消费这项配置。未来的 History API 路由可以在引入所需路由时，同时添加显式服务器规则或配置字段，无需保留推测性的公开选项。

## 后果

失效链接与缺失资源具有可供缓存和监控观察的独立 HTTP 状态，资源加载器也不会把 HTML 外壳当作 JavaScript 执行。未来基于 pathname 的客户端路由会保持 404，直到同一项变更同时加入服务器入口规则与真实组合测试。frontend-static 的真实 Loader 测试固定了 index 入口、现有资源、普通未命中和资源未命中的 GET/HEAD 状态一致性，并覆盖类似 API 的路径、路径遍历、畸形目标、不支持的方法和回退释放。
