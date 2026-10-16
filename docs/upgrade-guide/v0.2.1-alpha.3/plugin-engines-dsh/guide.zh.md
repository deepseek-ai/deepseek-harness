---
kind: upgrade-guide
description: "插件兼容性检查先读 engines.dsh，再读 DSH peerDependencies；拒绝记录改用 requirements 代替 peers。"
---

# 插件兼容性先读 `engines.dsh`

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.3 中，安装和 profile 启动只依据插件或组合包在 `peerDependencies` 中对 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 的声明判定兼容性，忽略 `engines.dsh`。下一版本中，包自身的 `engines.dsh` 范围单独决定结果，并忽略这些 peer；只有缺少 `engines.dsh` 时才使用 peer 规则。`workspace:` 值只在 peer 中有效；出现在 `engines.dsh` 中时视为不兼容。`engines` 不是对象或 `engines.dsh` 不是字符串时，兼容性检查无法读取清单，该包会被拒绝。受影响的是声明了 `engines.dsh`，或把 `engines` 声明为非对象值的插件作者。

插件管理器返回给客户端的 `incompatible-version` 拒绝记录 `IncompatiblePlugin`，以及 app-boot 的 `PluginCompatibility` 结果，将 `peers` 重命名为 `requirements`。按 engines 规则判定时键为 `engines.dsh`，回退到 peer 规则时键为 peer 包名。读取这些记录的代码受影响。

## 迁移

1. 如果包声明了 `engines.dsh`，让该范围覆盖包支持的所有 DSH 版本，因为 DSH peer 范围不再放宽或收窄它。删除 `engines.dsh` 可保留基于 peer 的检查。
2. 将 `engines.dsh` 中的 `workspace:` 值替换为语义化版本范围。
3. 从 `IncompatiblePlugin` 和 `PluginCompatibility` 读取 `requirements`，不再读取 `peers`。
4. 用 `dsh plugin --profile <profile> add <package@version>` 或插件管理器安装该包确认迁移：不匹配时，拒绝信息会列出 `engines.dsh` 或对应 peer 包。
