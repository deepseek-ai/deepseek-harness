---
kind: upgrade-guide
description: "ProfileContext 以 overlay 文件路径取代已解析的 overlay，每次组合都会重新读取这些文件。"
---

# 从文件读取命令行 overlay

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-app-boot` 的 `ProfileContext`（以 `ctx.profileContext` 提供）不再包含 `overlays: readonly PatchOptions[]`，改为 `overlayPaths: readonly string[]`：按命令行顺序排列的 `--patch` 文件绝对路径。`readProfilePatches()` 每次调用都会读取这些文件，因此返回当前的 overlay 内容，并在 overlay 文件缺失或无效时抛出异常。启用 `dsh-hmr` 时，编辑 `--patch` 文件会重新组合运行中的 profile。读取 `profileContext.overlays` 的插件，以及构造 `ProfileContext` 的启动器或测试会受到影响。

## 迁移

1. 将对 `ctx.profileContext.overlays` 的读取替换为 `readProfilePatches(binName, ctx.profileContext)`；只需要 overlay 层时，对 `overlayPaths` 的每一项调用 `loadOverlayPatches(binName, path)`。
2. 在构造 `ProfileContext` 的代码中，将 `overlays: [...]` 替换为 `overlayPaths: [...]`。内存中的 overlay 行需先写入 patch 文件，再传入该文件的绝对路径。
3. 运行类型检查确认迁移完成：`ProfileContext` 值上不再存在 `overlays` 属性。
