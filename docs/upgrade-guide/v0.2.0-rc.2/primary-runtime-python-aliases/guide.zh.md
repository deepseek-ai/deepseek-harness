---
kind: upgrade-guide
description: "自定义 primary-runtime payload 的 Python 解释器别名必须支持目录迁移。"
---

# 自定义 Python 运行时别名必须指向同目录解释器

[English](guide.md) | 中文

## 变更

在 macOS 和 Linux 上，`DSH_PRIMARY_RUNTIME` 之前接受指向 payload 外部或经过其他链接的解释器链接。现在，payload 校验要求 `dependencies/python/bin/python` 或 `python3` 的链接直接指向同目录的普通解释器文件，文件名由 `runtime.json` 中 Python 的主版本号和次版本号决定，例如 `python3.12`。普通命令文件仍受支持，包括 Python wheel 中分发的文件。Windows 不变。

## 迁移

1. 对于自定义 payload，将版本化解释器保留在 `dependencies/python/bin/` 中，并让 `python` 和 `python3` 以该文件名为目标建立相对链接。[运行时准备说明](../../../../packages/skill/tool-workspace-dependencies/README.zh.md)列出了必需的目标与输出参数。
2. 复制准备好的资源时保留相对链接。使用 Node `fs.cp` 时设置 `verbatimSymlinks: true`；wheel 构建器必须将命令展开为普通文件，因为 pip 不会还原链接。本机构建冒烟检查要求准备好的资源目录保留两个别名。
3. 确认 `readlink` 对两个别名都只返回同目录解释器的文件名，再将 payload 移离构建目录，将 `DSH_PRIMARY_RUNTIME` 指向新目录，验证 `load_workspace_dependencies` 和返回的 Python 命令均可成功执行。
