---
kind: upgrade-guide
description: "自定义文件动作菜单应仅在 Desktop 提供另存为，在 Web 使用浏览器下载。"
---

# Web 文件下载

[English](guide.md) | 中文

## 变更

Web 文件动作服务不再通过浏览器文件选择器提供另存为。Web 的 `canSaveAs` 始终为 false，`save(source, 'saveAs')` 会在读取来源前拒绝。内置 Web 文件和图片菜单提供「下载」，不显示「另存为」。Desktop 仍提供两种操作；保存成功后返回目标绝对路径 `path`，不再返回不透明文件 ID。

## 迁移

1. 自定义 Client 菜单仅在 `ctx.fileActions.canSaveAs` 为 true 时添加「另存为」。
2. Web 端调用 `ctx.fileActions.save(source, 'download')`。浏览器处理原始内容和建议文件名；`requested` 结果仅表示下载已开始，不代表完成。不要报告本机保存路径。
3. 将 `savedFile(url)` 和 `reveal(id)` 调用替换为完成后 `saved` 结果上的操作，使用其中的 `path` 调用 `session.openWorkspacePath`。原文件右键定位应独立于保存目标。
4. 验证 Web 文件和图片菜单只有「下载」而没有「另存为」，包括支持 `showSaveFilePicker` 的浏览器；验证 Desktop 图片菜单保留两种操作。保存结果与提示的归属参见[文件动作参考](../../../../packages/client/ui-file-actions/README.zh.md)。
