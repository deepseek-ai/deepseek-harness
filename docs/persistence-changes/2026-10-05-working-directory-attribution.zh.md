---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-working-directory-attribution

[English](2026-10-05-working-directory-attribution.md) | 中文

## 概述

新增由工作目录组件拥有的通知来源标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-working-directory-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "9a36727716d0e73f681f3b725e7f28f89417c68174c8af0ff2b1ef52b08326a0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "ba5b10ea77d68f4a29439a9bd2a14f6a560acf55731749d57237757cc72fbc06"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "19fab83e64cf84ee8a6caf62c592e85c9b195bfd19e84a2667c6693a395681fd"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "2ace3b8059b82b6d9837fed518ca97a99eb37c4482df7aad0e71c85489428ade"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。新增的 working-directory 来源种类只提供来源标记；已声明的来源策略保留未知标记而不解释其含义。Session 格式保持不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/working-directory/tests packages/shell/tool-bash/tests/tools.spec.ts packages/shell/tool-pwsh/tests/tools.spec.ts packages/subagent/subagent/tests/schedule-tools.spec.ts：5 个文件、207 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
