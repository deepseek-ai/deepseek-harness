---
kind: upgrade-guide
description: "Cordis Loader 1.0.0-rc.9 与 Include 1.2.0 按 YAML 1.2 解析、拒绝格式错误的条目，applyEntryPatches 改为返回 PatchResult。"
---

# Loader 校验条目选项，Include 按 YAML 1.2 解析

[English](guide.md) | 中文

## 变更

`@deepseek-ai/cordis-plugin-loader` 现在包含上游 Loader 1.0.0-rc.9，`@deepseek-ai/cordis-plugin-include` 包含 Include 1.2.0。受影响的是手写的 `cordis.yml`、`cordis.patch.yml` 与 overlay 文件，以及调用 Include 或 Loader 导出的代码：

- Include 和 `parseEntryYaml` 按 YAML 1.2 core schema 解析，不再使用 js-yaml 的 JSON schema。`0b101` 这样的二进制整数现在读作字符串 `'0b101'`。空的 `!!js` 标量现在读作空表达式，求值结果为 `undefined`，不再解析失败。
- 创建或更新条目前会校验条目选项。`name` 必须是字符串；`group` 必须是布尔值；`disabled` 必须是布尔值或 `!!js` 表达式；`group: true` 的条目必须带有 `config` 列表，空列表也要写出；`inject` 必须是字符串列表或映射；`isolate` 必须是映射，其值为 `true` 或字符串。此前能加载但含有这类值的条目现在会被拒绝，同级条目仍会启动；被拒绝的条目若是 `webserver` 等必需条目，`dsh` 会终止启动，否则输出警告。Include 文件中只要有一个条目不是映射，整个文件都会被拒绝。含 `:` 的 id 仍然可以使用。
- 解析错误、条目选项错误和配置校验错误都会以 `file:line:column` 指出文件位置。条目自身的模块找不到时，错误为 `ModuleNotFoundError`，不含 Node 的 `imported from` 部分；其 `code` 仍为 `ERR_MODULE_NOT_FOUND`。
- 替换 group `config` 的 patch 带来的子条目可以被后续 patch 定位，被替换掉的子条目则不能再被 patch。
- `applyEntryPatches(data, patches, warn)` 返回 `{ data, index }`，不再直接返回条目列表；它会把生成的 id 写入 `patches` 中被替换的 group `config` 里的匿名条目。`parseEntryYaml` 抛出 `yaml` 包的 `YAMLError`，不再抛出 js-yaml 的 `YAMLException`。

## 迁移

1. 必须保持为数字的二进制整数改写为十进制或十六进制。
2. 对每个 profile 运行 `dsh --dump-config`。解析错误现在会给出行号和列号；按提示修正对应的值。
3. 给每个缺少 `config` 的 `group: true` 条目加上 `config: []`，例如子条目全部来自 patch `insert` 的 group。启动 profile，检查日志中的 `invalid entry options` 和 `invalid config`，在给出的位置修正列出的每个路径。
4. 如果后续 patch 针对的是某个 group 的子条目，而该 group 的 `config` 已被前面的 patch 替换，确认该子条目现在会应用这个 patch。
5. 在代码中读取 `applyEntryPatches(...).data`；如果 patch 列表必须保持不变，传入 `structuredClone(patches)`。捕获解析错误时不要依赖 js-yaml 的类型；`entryYamlErrorPosition(error)` 仍会返回错误位置。
6. 确认 `dsh --dump-config` 输出预期的条目，且 profile 启动时不再出现上述诊断。
