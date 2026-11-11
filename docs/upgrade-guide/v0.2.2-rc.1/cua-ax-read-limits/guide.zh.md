---
kind: upgrade-guide
description: "macOS 默认读取更多 AX 节点，调用方可为单次读取覆盖配置值。"
---

# macOS AX 树读取范围

[English](guide.md) | 中文

## 变更

macOS 的默认节点数从 2000 增至 5000，默认深度从 25 增至 50。窗口中有更多节点可访问时，读取可能耗时更长，输出到模型的文本也可能增加。

`maxElements` 和 `maxDepth` 分别决定省略对应参数时的读取范围。调用方可以为一次读取指定高于或低于配置的值。查找粘贴菜单始终使用配置值。

## 迁移

1. 如需沿用原先的常规读取范围，在 `cordis.yml` 或配置补丁中找到 `@deepseek-ai/dsh-experimental-cua-macos`，在现有的 `config` 下设置 `maxElements: 2000` 和 `maxDepth: 25`。
2. 重启配置，确认 Computer Use 模型说明中的两个默认值与配置一致。
3. 如果脚本依赖特定的遍历范围，在 `getAccessibilityTree()` 的调用处显式传入这两个参数。一次调用的覆盖值不会影响后续读取。
