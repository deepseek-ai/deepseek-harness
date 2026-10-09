---
kind: upgrade-guide
description: "dsh plugin reads --profile only before the forwarded pnpm arguments and prints its own help."
---

# `dsh plugin` option placement

English | [中文](guide.zh.md)

## Change

`dsh plugin` reads `--profile` only before the forwarded pnpm arguments, which start at the first token it does not recognize, and it has its own help. Previously it accepted `--profile <name>` anywhere on the command line, had no help of its own, and forwarded `-h` and `--help` to pnpm from any position.

When the forwarded arguments begin with the pnpm command, everything after that command now reaches pnpm verbatim, including `-h`, `--help`, and `--profile`. In any other position, including after a leading pnpm option such as `--filter <selector>`, `-h` or `--help` prints the `dsh plugin` help and exits 0. Scripts that place `--profile` after the pnpm command or after a leading pnpm option fail with `required option '--profile <name>' not specified`, and `dsh plugin --profile <name> --help` no longer prints pnpm's help.

## Migration

1. Move `--profile <name>` before every pnpm argument: replace `dsh plugin add <package> --profile <name>` with `dsh plugin --profile <name> add <package>`.
2. Request pnpm's help for one command after that command, with any pnpm options after it too, as in `dsh plugin --profile <name> add --help`. For pnpm's general help, forward `help`: `dsh plugin --profile <name> help`.
3. Confirm that `dsh plugin --help` prints `Usage: dsh plugin [options] [args...]` and that the commands from steps 1 and 2 reach pnpm.
