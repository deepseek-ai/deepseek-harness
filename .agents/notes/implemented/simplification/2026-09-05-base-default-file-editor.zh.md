# Agent Note: 共享 base 默认文件编辑器选择

Status: implemented

[English](2026-09-05-base-default-file-editor.md) | 中文

## Problem

共享 base 同时选择 `read`/`write`/`edit` 和 `str_replace_editor`，这些工具提供重叠的文件编辑接口。[Issue #3599](https://github.com/deepseek-harness/deepseek-harness/issues/3599) 要求基于 base 的 profile 默认使用一套接口，同时保留专用的极简组合。

## Decision

[base patch](../../../../packages/bundle/base/cordis.patch.yml) 选择 `read`、`write` 和 `edit` 负责文件编辑。它不插入 `tool-str-replace-editor`；因此 SDK 与 Web 应用 patch 无需禁用覆盖。编辑器包仍可供显式插入它的组合使用。

[Web minimal](../../../../packages/preset/agent-presets/presets/minimal/agent.cordis.yml) 在 agent 作用域插入自己的 `str-replace-editor` 配置项。独立的 [sdk-minimal bundle](../../../../packages/bundle/sdk-minimal/cordis.patch.yml) 不继承 base，自行插入配置项。两种极简组合都保留其编辑器。

本决策细化了[统一 dsh 启动器](../architecture/2026-08-22-single-dsh-application-launcher.zh.md)中的共享工具默认值。该文档对启动所有权、共享服务和 patch 优先级仍然有效；没有被完全取代的活跃 Agent Note。

## Alternatives considered

**在每个应用中分别禁用编辑器。** 这会在 base 中保留重叠的默认接口，并要求各消费方主动退出。共享选择由 base 直接负责。

**删除工具包或从 minimal 移除它。** 专用的极简组合通过此接口完成文件操作。保留包及其显式配置项可以保留这一行为。

## Consequences

基于 base 的 SDK、headless、ACP 与自定义 profile 默认不包含该编辑器 schema。Web standard 同样不包含它。profile、home 或逐次调用 patch 可以通过 `insert` 添加工具；只设置 `disabled: false` 的 patch 需要已有配置项，无法创建配置项。本决策不要求 SDK 与 Web 的全部工具一致。

## Verification

[SDK 进程测试](../../../../apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts) 捕获默认文件工具、显式插入编辑器与独立极简工具清单的实际模型请求。[headless 进程测试](../../../../apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts) 通过所属应用检查共享默认值。[Web minimal 快照](../../../../apps/web/tests/minimal-preset.snapshot.ts) 通过极简 preset 执行编辑器。[headless](../../../../snapshots/session/headless.snapshot.ts)、[SDK](../../../../snapshots/sdk/sdk.snapshot.ts) 与 [ACP](../../../../snapshots/acp/acp.snapshot.ts) 录制会话固定组装后模型可见的输出，包括显式插入编辑器的 SDK fixture。
