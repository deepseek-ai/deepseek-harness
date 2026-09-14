# Agent Note: Composer 占位提示的判空规则

Status: implemented

[English](2026-09-09-composer-placeholder-whitespace.md) | 中文

## Problem

占位提示复用去除首尾空白后的提交判断，会让提示文字覆盖已经包含空格的草稿。

## Decision

原始草稿非空时，Composer 隐藏占位提示。提交仍检查去除首尾空白后的内容。附件和已认领指令沿用现有的占位提示隐藏规则。

## Alternatives considered

**复用提交判断。** 空白字符没有可发送的消息内容，但会占据编辑器并移动光标。共用判断会混淆这两种状态。

## Consequences

所有占位提示，包括排队消息的插话提示，都会在输入空白字符后隐藏，删除后恢复。没有附件的纯空白草稿仍无法发送。[组件测试](../../../../packages/client/ui-conversation/tests/input-bar.client.spec.tsx) 覆盖显示、输入法组合、重新渲染和提交；[浏览器回归](../../../../apps/web/tests/composer-placeholder.e2e.ts) 使用构建后的界面检查键盘和剪贴板操作。
