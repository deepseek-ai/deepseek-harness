---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-03-working-directory-anchor

[English](2026-11-03-working-directory-anchor.md) | 中文

## 概述

为 working-directory/change 增加可选的 anchor，使一次变更即可把进入的检出目录登记为 Session 的工作区锚。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-working-directory-anchor
baseline: false
changes:
  - root: "event:working-directory/change"
    previous: "2026-09-13-working-directory"
    after: "376ab95962d99133db02add3a1dda91a257affb2c2e71e64da139b679d82cb88"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

没有 anchor 的已有事件折叠结果不变：当前目录投影忽略该属性，新的 workspaceRoot 投影把缺失的 anchor 读作仅移动当前目录、不新增锚，因此已存储日志仍只有原始项目一个锚。旧读者保留事件类型及其 cwd，忽略该可选属性；它们从未推导工作区根，解释结果不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/working-directory：37 个测试通过，包括带与不带 anchor 的日志回放以及两者产生的用户上下文文本。

<a id="dev-note"></a>
## 开发备注

无。
