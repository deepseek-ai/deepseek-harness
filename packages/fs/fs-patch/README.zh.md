---
description: "解析 Codex 风格补丁并将 hunk 应用于文本，不执行文件系统 I/O。"
kind: "package-library"
---

# dsh-fs-patch

[English](README.md) | 中文

## 概述

使用 `parsePatch` 将完整的 Codex 风格补丁解析为有序文件操作，再用 `applyHunks` 将更新 hunk 应用于 LF 规范化文本。两个函数只处理调用方传入的字符串，不访问文件系统。语法错误抛出并标明原始输入行号；匹配返回新文本或结构化失败。

## 目录

- [使用此包](#use-this-package)
- [兼容性](#compatibility)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

操作和 hunk（修改块）只包含可 JSON 序列化的值；解析按输入顺序保留重复路径，路径保持为未解析的字符串。

```ts
import { applyHunks, parsePatch } from '@deepseek-ai/dsh-fs-patch'

const operations = parsePatch('*** Begin Patch\n*** Update File: hello.txt\n-hello\n+hi\n*** End Patch')
const operation = operations[0]
if (operation?.kind === 'update') {
  const result = applyHunks('hello\n', operation.hunks) // { ok: true, after: 'hi\n' }
}
```

非法输入抛出 `PatchParseError`，包含从 1 开始的 `lineNumber` 和说明如何修正的 `reason`。位置计入原始输入中的前导空行和 heredoc 包装。

`applyHunks` 返回 `{ ok: true, after }` 或 `{ ok: false, failure }`，不修改输入。匹配失败报告 hunk 在补丁中的行号、`context` 或 `oldLines` 阶段、顺序搜索游标和原始未匹配模式；移除末尾空行重试后仍报告原始模式。以返回值而非异常报告失败，便于调用方收集多个文件操作的匹配失败。

<a id="compatibility"></a>
## 兼容性

参照实现为 [OpenAI Codex rust-v0.158.0](https://github.com/openai/codex/tree/rust-v0.158.0/codex-rs/apply-patch/src)：语法参照 `parser.rs` 和 `streaming_parser.rs`，匹配及 `NormalizeToLf` 重建参照 `seek_sequence.rs` 和 `file_update.rs`。`text_file.rs` 说明独立的换行保留表示。[解析器测试](tests/parse.spec.ts) 与[文本测试](tests/apply.spec.ts) 改编选定的上游用例，包括 `file_update_tests.rs` 和 `lib.rs`。[LICENSE](LICENSE) 在 DeepSeek 贡献的 MIT 许可证之外，保留 OpenAI 署名与 Apache-2.0 条款。

### 解析

| 输入 | 解析结果 |
|---|---|
| Begin/End Patch；Add/Delete/Update File 头 | 有序操作；接受空补丁和空新增文件。 |
| 新增文件中以 `+` 为前缀的行 | 去除前缀；每行都附带末尾 LF。 |
| 更新中以空格、`+` 或 `-` 为前缀的行 | 上下文、插入或删除；没有前缀的空行视为空上下文。 |
| 首个更新省略 `@@`；后续使用 `@@` 或 `@@ text` | 带可选上下文锚点的有序 hunk；拒绝空 hunk。 |
| 紧跟 Update File 的 Move to | 更新操作携带目标路径；没有非空 hunk 的移动被拒绝。 |
| hunk 后的 End of File | 设置 EOF 标志；忽略后续空白行，更多内容需要新的 hunk 或文件头。 |
| LF/CRLF、外围 Unicode 空白、缩进的文件头 | Codex 裁剪规则使用 Unicode `White_Space`，包含 U+0085，不包含 BOM（U+FEFF）。更新内部缩进的标记仍作为上下文。保留内容空白。 |
| 字面量 `<<EOF`、`<<'EOF'` 或 `<<"EOF"` 包装 | 接受但不执行 shell；与参照实现相同，结束行必须以 `EOF` 结尾。 |
| 重复路径、相对/绝对路径、Unicode 文本 | 原样保留，不解析路径或进行 Unicode 归一化。 |
| Environment ID 头 | 首个操作前给出专用的不支持错误；其他位置给出普通语法错误。 |
| Unified diff、shell 命令、非法标记 | 拒绝并给出原始行号；诊断措辞与 Codex 不同。 |

与参照实现相同，任何 hunk 之前的 EOF 没有效果；更新仍然需要非空 hunk。参照实现也接受在较早的 End Patch 和中间空白之后重复出现的最终 End Patch。

### 匹配与文本更新

| 输入或规则 | 结果 |
|---|---|
| 四级匹配 | 精确匹配、两侧去尾部 `White_Space`、两侧去首尾空白，再将去首尾空白后的 Unicode 标点映射为 ASCII。每一级遍历所有候选后才进入下一级。 |
| Unicode 标点 | U+2010–2015 和 U+2212 映射为 `-`；U+2018–201B 映射为单引号；U+201C–201F 映射为双引号；U+00A0、U+2002–200A、U+202F、U+205F、U+3000 映射为空格。不做 NFC/NFKC 归一化。 |
| `@@ text` 与重复内容 | 从游标起找第一个匹配锚点，再从其后一行搜索。旧行取游标后的首个匹配，随后游标推进到匹配末尾。所有搜索都基于原文本。 |
| EOF hunk | 只从 `lineCount - patternLength` 搜索，即使该位置在游标之前。固定版本的实现不会回退到更早的匹配位置，尽管搜索函数的注释如此描述。 |
| 旧行为空 | 在原文件末尾插入；若末尾有空源行，则插在该行之前。插入不推进游标；存在锚点时仍须匹配。同位置插入保留补丁顺序。 |
| 未匹配且末行为空的模式 | 去掉最后一行重试；新行末尾若为空也去掉。重试模式为空时匹配游标位置。 |
| 文本重建 | 匹配前去掉按 LF 分割所得的一个末尾空元素；按起点稳定排序后反序应用替换。如果末尾没有空元素则补一个，再用 LF 连接。空结果保持空；非空结果以 LF 结尾。 |
| 上下文行 | 用补丁文本替换整个匹配区间，包括容错匹配的上下文差异。 |
| 没有 hunk | 仍执行相同的重建，因此会补齐缺少的末尾 LF，也可能消耗一个末尾空行。 |

与 Codex 的刻意差异在于职责和结果报告：行尾风格由 DSH 提供方保留，因此匹配器只接收 LF 规范化文本，不实现 `PreserveLineEndings`。CR 是普通字符：调用方必须先规范化 CRLF，之后还原选定的行尾风格。匹配失败返回结构化数据而非 Codex 带路径的错误，因此调用方负责文件标识和面向用户的诊断。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[解析器](src/parse.ts) 构建语法记录，不依赖 Session 或提供方。[文本更新器](src/apply.ts) 先在原文本中定位每个 hunk，再构建完整结果。[类型](src/types.ts) 携带语法位置与匹配失败；[文件系统参考](../../../docs/subsystems/filesystem.zh.md#patch-syntax-records) 维护公开类型定义。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [文件系统包组](../README.zh.md)——提供方、策略和文件工具。
- [Apply patch 文件编辑](../../../.agents/notes/implemented/feature/2026-09-28-apply-patch-file-editing.zh.md)——决策记录。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 文本更新只实现 `NormalizeToLf`；调用方负责行尾转换。
- 公开 API 接受完整字符串，不接收流式增量。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
