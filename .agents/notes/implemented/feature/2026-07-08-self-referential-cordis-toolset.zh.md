# Agent Note：Cordis 运行时检查与 runner 隔离

Status: implemented

[English](2026-07-08-self-referential-cordis-toolset.md) | 中文

## Problem

运行时 API 发现必须描述插件实际能调用的 API。进程内生成定义还需要注册校验和完整的 effect 释放；仅隔离 JavaScript 全局变量并不能限制注入服务的权限。

## Decision

`cordis_inspect_list` 和 `cordis_inspect_query` 提供只读运行时发现。生成目录保留源码中的声明和 JSDoc，并按存活 provider 筛选。目录生成器拒绝过期产物；精确查询避免每次请求都承担完整 API 声明的 token 成本。

Host 和 Client runner 保留程序侧生命周期和浏览器消费者。Host 定义在新的 vm realm 中求值，并接收 context façade：服务访问需要声明注入，框架内部结构不可见，注册归定义的 fiber 所有。工具输出先回到 Host realm 进行归一化，再接受校验。释放会等待 fiber 所有的 effect。vm 防止意外污染全局变量；注入的文件系统、shell 和网络服务仍有真实权限，因此它不是安全边界。

定义仅存在于进程中。重启和会话恢复不会从历史调用重建它们。[Creator 持久化插件决策](../architecture/2026-09-16-creator-persistent-plugin-management.zh.md)负责 agent 安装、审批和 profile 持久化。内置模型工具不创建或修改 runner 定义。

## Alternatives considered

**手写 API 表。** 拒绝，因为它会独立于服务声明漂移；生成目录与新鲜度检查共享同一源码。

**将 vm 视为安全沙箱。** 拒绝，因为 façade 暴露的服务可以访问 Host 的真实资源。受限全局变量改善生命周期正确性，不执行权限控制。

**从会话日志重建定义。** 拒绝，因为重放源码会执行历史副作用。历史卡片展示持久化源码和结果，不恢复运行中的定义。

## Consequences

检查能力不依赖 Creator 或 Plugin Manager。Runner 生命周期测试覆盖受保护注册、启动失败清理和等待释放。现有浏览器消费者保留生命周期 API；移除其写入注册表与激活机制，需要协调替换这些消费者，不能删除历史渲染或假定会话数据会重建运行状态。
