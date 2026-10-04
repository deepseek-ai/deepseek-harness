---
kind: upgrade-guide
description: "子路径插件不再从导出的 <子路径>/package.json 读取展示文本和图标，改用 locale meta 和 <子路径>/icon。"
---

# 子路径插件改读 `<子路径>/icon`，不再读 `<子路径>/package.json`

[English](guide.md) | 中文

## 变更

在 v0.2.0-rc.2 中，插件管理页和设置页会在包导出 `my-plugins/search/package.json` 时，通过它读取 `my-plugins/search` 这样的子路径插件：`name` 和 `description` 补全缺失的 locale 字段，`icon` 提供行图片。子路径不是包，因此下一版本不再为它读取任何 `package.json`。其标题和描述只来自 `my-plugins/search/locale/*.json`，图片来自导出的 `my-plugins/search/icon` 资源。包根插件保留 `package.json` 文本和 `icon`；省略 `icon` 时，导出的 `./icon` 提供图片。受影响的是导出子路径 `package.json` 的包作者。

## 迁移

1. 将子路径清单的 `name` 和 `description` 移到子路径 locale 文件的 `meta.title` 和 `meta.description`，并导出这些文件，例如 `"./search/locale/*.json": "./locale/search/*.json"`。
2. 用图标导出替换子路径清单的 `icon`，并发布其目标文件：

   ```json
   {
     "exports": { "./search/icon": "./assets/search.svg" },
     "files": ["assets/search.svg"]
   }
   ```

3. 删除 `./search/package.json` 导出及其文件。
4. 在 DSH 仓库中运行 `pnpm run verify-package-meta`，或打开插件管理页，确认子路径行显示标题、描述和图片。
