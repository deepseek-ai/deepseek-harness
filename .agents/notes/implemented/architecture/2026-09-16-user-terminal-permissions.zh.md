# Agent Note: User-terminal permissions

Status: implemented

[English](2026-09-16-user-terminal-permissions.md) | 中文

## 问题

用户需要在限制 Agent（智能体）权限的同时亲自运行命令。共享 Agent 的沙箱模式会迫使用户为了手动操作而扩大 Agent 权限；保留交互式 shell 又会阻止后续模式切换，因为已有进程的沙箱限制无法跟随新的 Session 设置改变。

## 决策

Web 侧栏终端直接通过 Session 的 subprocess provider 运行，使用执行环境中系统用户的权限。它不通过 Agent 沙箱限制 shell，也不请求 Agent 审批。操作系统权限、容器隔离和 provider 对环境凭据的清除仍然生效。Session 标识负责访问范围、进程清理和初始目录；sandbox policy 仅在 Session 没有 cwd 时提供配置的默认目录。

改变 Agent 权限时，用户终端继续运行。Agent 使用的 shell 和 terminal 工具保留各自的沙箱限制。用户终端的输入和输出不产生模型输入或 Session 事件。

本决策仅取代 [Web 侧栏终端决策](../feature/2026-09-09-web-sidebar-terminal.zh.md)中的共享沙箱策略和模式切换限制。原记录继续负责进程所有权、传输、屏幕恢复和 shell 选择。OpenCode 的 `packages/core/src/pty.ts` 和 `packages/core/src/pty/pty.node.ts` 提供相邻实现依据：其交互式终端使用选定的 shell 和工作目录直接创建 PTY。

## 考虑过的替代方案

**继承 Agent 权限。** 一个 Session 模式可以描述两类进程，但用户必须同时授予 Agent 仅用于手动命令的权限。持久用户 shell 随之阻碍 Agent 权限切换。

**增加独立的终端权限选择器。** 产品将此终端视为用户操作的系统 shell。另一个选择器会增加策略状态和进程重启语义，目前没有对应需求；部署和操作系统控制已经确定执行环境。

## 影响

访问 Web 终端即可作为 subprocess provider 的系统用户执行命令，包括在该用户有权限时写入 Session 工作区之外的路径。它不会授予 root 权限或逃逸容器。Session 所有权继续用于分组和清理，不意味着 Agent 决定用户操作的权限。

Controller 测试覆盖全部 Agent 沙箱模式下的直接 shell 启动，以及模式改变后的持续所有权。录制的 Web 权限策略场景在只读、完全访问和工作区写入之间切换时保持同一个真实用户 PTY，验证工作区内外的写入，并保留 Agent 的只读拒绝和审批断言。Bash 浏览器断言在 macOS 和 Linux 运行；Windows 保留可移植的 controller 检查和 Agent 策略回放。
