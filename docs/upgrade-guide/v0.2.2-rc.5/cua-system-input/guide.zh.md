---
kind: upgrade-guide
description: "CUA 系统输入选项取代系统指针选项和授权配置。"
---

# CUA 系统输入

[English](guide.md) | 中文

## 变更

CUA 将 `useSystemPointer` 改为 `useSystemInput`，能力字段 `systemPointer` 改为 `systemInput`，配置项 `requireSystemPointerApproval` 改为 `requireSystemInputApproval`。macOS 的 `mouseMove`、`toggleMouse`、`click`、`drag`、`pressKey` 和 `sendKeyEvent` 支持此选项。显式系统点击和拖动同时发送鼠标事件及键盘修饰键的按下、松开事件。省略或传 `false` 保留默认输入方式。Windows 暂不开放此能力。

系统输入授权覆盖键盘和鼠标操作。错误码由 `MOUSE_CONTROL_*`、`MOUSE_APPROVAL_*` 改为 `SYSTEM_INPUT_*`、`SYSTEM_INPUT_APPROVAL_*`。

## 迁移

1. 将 CUA 程序和原始请求中的 `useSystemPointer` 替换为 `useSystemInput`。单独按下和松开时使用相同选项。键盘选项放在 `pressKey(key, modifiers, options)` 或 `sendKeyEvent(key, direction, options)` 的第三个参数。
2. 将 profile 或 home patch 中的 `requireSystemPointerApproval` 改为 `requireSystemInputApproval`，能力检查改为 `systemInput`，并更新错误码前缀。
3. 随 Host 一起重建或升级 macOS helper。选择系统输入前确认 `cua.getCapabilities().systemInput`，激活并观察目标，验证一次带修饰键的点击或按键并检查结果。`typeText`、`paste`、`scroll` 和 AX 方法不接受此选项。
