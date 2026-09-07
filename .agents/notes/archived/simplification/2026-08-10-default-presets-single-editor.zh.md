# Agent Note: 通用 preset 只提供一套编辑工具

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-default-presets-single-editor.md) | 中文

## 问题

`standard`、`code` 和 `cordis` preset 同时提供 `read`/`write`/`edit` 文件系统工具与 `str_replace_editor`。两套接口在常规文件查看和编辑上重叠，导致每次请求都携带额外的工具 schema，却没有增加独立的默认能力。`minimal` preset 具有不同的组合约定：它固定的双工具清单有意在持久 `bash` 之外提供 `str_replace_editor`。

## 决策

`standard`、`code` 和 `cordis` preset 配置挂载 `dsh-tool-fs` 与 `dsh-tool-fs-search`，但不挂载 `dsh-tool-str-replace-editor`。因此 PTC mode 的注册表和生成的 SDK 均不包含 `str_replace_editor`。`minimal` preset 继续挂载 `dsh-tool-str-replace-editor`，部署配置或用户自定义 preset 仍可显式挂载该插件。

此决策收窄 preset 工具清单，不移除工具包及其 Python 运行时支持。较早的[共享清单决策](../feature/2026-07-31-even-out-shipped-tool-rosters.zh.md)继续说明与 surface 无关的工具为何归 preset 组合所有；本记录说明编辑器例外。

## 曾考虑的替代方案

**在通用 preset 中保留两套编辑接口。** 不予采用，因为重叠的模型可见 schema 增加了工具选择，却没有提供不同的默认操作。

**从所有交付组合中移除 `str_replace_editor`。** 不予采用，因为 `minimal` preset 有意将该 schema 作为两个工具之一，显式部署仍是该独立插件的有效消费方。

## 后果

通用 agent 使用 `read`、`write` 和 `edit` 完成文件系统修改，minimal agent 保留 `str_replace_editor`。preset 组合测试固定其不会出现在 standard 清单、Cordis 清单及 PTC mode SDK 中，同时 minimal 断言继续固定其存在。
