---
kind: upgrade-guide
description: "`--from-default-profile` 现在会替换已存在的自定义 profile，而不是拒绝执行。"
---

# `--from-default-profile` 会替换已存在的 profile

[English](guide.md) | 中文

## 变更

此前目标 profile 已存在时，`dsh --profile <name> --from-default-profile <template>` 会以 `profile "<name>" already exists` 失败，残留的目标目录也会被拒绝。现在每次执行都会用模板的全新副本替换目标目录，然后启动它；带配置 dump flag 时则打印组合结果。原有目录会被删除，包括 `package.json` 中的依赖、已安装的 `node_modules` 和 `cordis.patch.yml`。任何大小写形式的随附 profile 名称仍不能作为目标。

受影响的是在脚本或快捷方式中重复执行该命令（例如 `dsh rescue --from-default-profile web`），并期望后续执行保留该 profile 插件或 patch 的用户。

## 迁移

1. 要在不重置的情况下启动已存在的 profile，去掉该选项：运行 `dsh rescue`，而不是 `dsh rescue --from-default-profile web`。
2. 要在重置后保留本地修改，先复制 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，执行命令后用 `dsh plugin --profile <name> add <package>` 重新安装该 profile 的插件，再恢复该 patch。
3. 确认迁移结果：执行 `dsh rescue --from-default-profile web --help` 后，`$DSH_HOME/profiles/rescue/package.json` 中没有任何依赖。
