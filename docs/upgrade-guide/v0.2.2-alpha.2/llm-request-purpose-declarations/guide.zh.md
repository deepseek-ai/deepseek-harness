---
kind: upgrade-guide
description: "辅助 LLM 请求用途改为生产方拥有的类型声明，不再使用共享固定联合。"
---

# 声明辅助 LLM 请求用途

[English](guide.md) | 中文

## 变更

`GenerateOptions.purpose` 由 `@deepseek-ai/dsh-llm/types` 导出的可声明合并的 `LlmRequestPurposeMap` 派生。共享包不再声明 `compaction` 或 `session-title`。构造辅助请求的插件必须加载生产方的声明，或声明自己的用途。现有运行时用途字符串保持原有含义。

## 迁移

1. 直接构造压缩请求时导入 `@deepseek-ai/dsh-compaction-basic`，构造标题请求时导入 `@deepseek-ai/dsh-session-title-llm`；只需要声明时使用仅类型导入。
2. 对插件拥有的用途，在插件公开类型入口中扩展 `LlmRequestPurposeMap`，将用途键映射到 `true`：

   ```ts
   import type {} from '@deepseek-ai/dsh-llm/types'

   declare module '@deepseek-ai/dsh-llm/types' {
     interface LlmRequestPurposeMap {
       'my-plugin-purpose': true
     }
   }
   ```

3. 使用新包的声明编译插件，确认请求接受已声明用途，并拒绝未声明的键。
