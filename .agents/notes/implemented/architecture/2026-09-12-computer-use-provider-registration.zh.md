# Agent Note: Computer-use provider registration

Status: implemented

[English](2026-09-12-computer-use-provider-registration.md) | 中文

## Problem

桌面提供方暴露不同的操作、观测格式和平台设施。DSH 需要防止在一个组合中意外启用两个提供方，同时让各提供方的集成正常工作，而不承诺通用操作 API。

## Decision

DSH 能力称为 **computer use（计算机操作）**。[`dsh-computer-use`](../../../../packages/computer-use/computer-use/README.zh.md) 拥有 `ctx.computerUse`，注册一个提供方自定的名称并返回其 effect 清理函数。第二次注册无论名称为何都会失败。服务不包含提供方对象、共享操作类型、分派方法、Session 锁或运行时选择器。

**Cua Driver** 是上游实现的名称。[MCP 提供方](../../../../packages/experimental/computer-use-cua-driver-mcp/README.zh.md)连接已安装的可执行文件。[原生提供方](../../../../packages/experimental/computer-use-cua-driver-native/README.zh.md)安装上游原生 npm 依赖。两者均保持实验性并加入显式公开发布允许列表；均不默认启用。

各集成暴露上游工具目录。MCP 结果转换保留在 `dsh-mcp-client` 中，其基于回调的工具适配函数也转换原生 Cua Driver 结果。计算机操作服务不依赖该适配函数或任一提供方。

提供方卸载时保留注册，直到停止接收工具调用且自有工作和资源关闭。分组 Cordis effect 为此清理排序；独立 effect 可能并发清理。原生提供方通过 `tools/execute` 在原生调用和截图准入之间共享取消信号，同时保留执行标识。并发 Session 由调用方协调，因为提供方注册不拥有观察、操作和验证流程。

## Alternatives considered

**统一操作 API。** 通用截图、输入和窗口术语需要转换提供方特有的语义，而当前没有需要可移植性的消费者。由提供方拥有工具可保留这些语义。

**仅外部 MCP。** 此方案复用已安装的驱动及其进程身份，但保留独立安装的前提。原生提供方提供单包运行时安装。

**仅嵌入原生运行时。** 原生集成让 DSH 拥有运行时生命周期，并与后端进程共享原生故障。MCP 提供方保留独立安装驱动的选项。

**Session 所有权代理。** 在完整流程期间预留桌面需要显式获取和释放策略。当前服务仅约束提供方注册，将流程协调留给调用方。

## Consequences

服务保持独立于实验性包。公开发布允许列表接纳两个提供方包，但不提升其支持状态。配置选择提供方，切换需要先卸载当前提供方。

原生平台支持和宿主权限仍由上游和部署负责。macOS 光标叠加层托管和专用 Desktop 权限界面暂缓实现。取消会停止等待并传播到驱动；不承诺回滚已交付的桌面输入。
