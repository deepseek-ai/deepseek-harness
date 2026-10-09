---
kind: upgrade-guide
description: "dsh plugin 只在被转发的 pnpm 参数之前读取 --profile，并提供自己的帮助。"
---

# `dsh plugin` 选项位置

[English](guide.md) | 中文

## 变更

`dsh plugin` 只在被转发的 pnpm 参数之前读取 `--profile`，被转发的参数从它无法识别的第一个 token 开始；它还提供自己的帮助。此前它接受出现在命令行任意位置的 `--profile <name>`，没有自己的帮助，并且无论 `-h` 和 `--help` 位于何处都会转发给 pnpm。

被转发的参数以 pnpm 命令开头时，该命令之后的所有内容现在都会原样交给 pnpm，包括 `-h`、`--help` 和 `--profile`。在其他任何位置，包括位于 `--filter <selector>` 等开头的 pnpm 选项之后，`-h` 或 `--help` 都会打印 `dsh plugin` 的帮助并以 0 退出。把 `--profile` 写在 pnpm 命令或开头的 pnpm 选项之后的脚本会因 `required option '--profile <name>' not specified` 而失败，`dsh plugin --profile <name> --help` 也不再打印 pnpm 的帮助。

## 迁移

1. 把 `--profile <name>` 移到所有 pnpm 参数之前：将 `dsh plugin add <package> --profile <name>` 改为 `dsh plugin --profile <name> add <package>`。
2. 查看某个 pnpm 命令的帮助时，把帮助选项和其他 pnpm 选项都写在该命令之后，例如 `dsh plugin --profile <name> add --help`。查看 pnpm 的总体帮助时转发 `help`：`dsh plugin --profile <name> help`。
3. 确认 `dsh plugin --help` 打印 `Usage: dsh plugin [options] [args...]`，并且第 1、2 步中的命令能够到达 pnpm。
