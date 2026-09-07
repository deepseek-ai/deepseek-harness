# Agent Note: 插入补丁插件的文件 URL

Status: implemented

[English](2026-09-05-patch-plugin-file-urls.md) | 中文

## Problem

Node ESM 会把 Windows 盘符前缀解释为 URL scheme，并把文件名中的片段字符视为 URL 语法。因此，直接将文件系统路径传给插件导入会使 Windows 绝对路径以及包含 `#` 或 `%` 的文件名加载失败。

## Decision

补丁文件解析将 `insert` 条目及其嵌套分组中的本机绝对路径、相对于补丁文件的 `./` 或 `../` 名称转换为文件 URL。包标识符、已有 URL、已有条目的名称断言及替换用的 `config` 值保持原有含义。解析阶段负责转换，因为在合并各层之前它掌握来源补丁的目录。

可选的 `HostResolvedRootInclude` 导入覆写会另外为选择安装宿主解析基址的调用方转换绝对路径。普通 CLI profile 不选择该覆写，因此它不能代替补丁文件转换。

## Alternatives considered

**只在 Python fixture 中使用 `Path.as_uri()`。** 这能避开一次失败，但用户编写的 profile 和 overlay 补丁仍会遇到问题。

**修改共享 Loader 基址。** 这会丢失逐补丁来源信息并改变裸包解析。文件 URL 保留选定的本地文件，无需修改解析基址。

## Consequences

可选与必需补丁读取器共用该转换。直接 Loader 导入及替换分组 config 引入的子条目不在其范围内；扩展这些路径需要各自的语义与覆盖。

补丁读取器测试验证转换与真实激活。构建后 SDK 验收加载文件名含 URL 敏感字符的绝对路径 overlay 插件，并验证其文件系统标记、初始化与关闭。
