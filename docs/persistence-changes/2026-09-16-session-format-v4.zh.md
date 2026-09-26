---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-16-session-format-v4

[English](2026-09-16-session-format-v4.md) | 中文

## 概述

将 已定稿 V4 写入方声明的 SessionHeader.version 从 3 推进到 4，记录一等 tool 角色结果与生产者拥有的 source，并向 turn/end.reason 添加 forked 变体。 添加 developer 角色的 Session 变更，工具添加仅记录名称并绑定历史请求头，另含工具移除和延迟加载模式标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-16-session-format-v4
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-11-initial"
    after: "1a3440e3577382704d42a6263aa463504eb74c566734a55e9503a63efcd02445"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-14-image-offload"
    after: "1506a9b8224986c83015ae99d2cb5ede705538c58c063d6a48ef6d761a31ba6c"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-14-image-offload"
    after: "15d5dfdd822aa35e115afd74a8982825a493880457774e6850bc1520b50875e4"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-14-image-offload"
    after: "1033093edd0db80ff410e00830b523405e00bb0c7684948e531ff65095799625"
    decision: version-bump
  - root: "event:compaction/summary"
    previous: "2026-09-14-image-offload"
    after: "e2f9a41e0989f54ed8cee80f8db2bcf9d60a5c810dc9d45b83fa050b9dce7602"
    decision: version-bump
  - root: "event:developer/message"
    previous: null
    after: "eef4ef54dc7a133d47448a4ee822e45a351314923ef5f66db34c8b24e4b32d80"
    decision: version-bump
  - root: "event:request/header"
    previous: "2026-09-11-initial"
    after: "4208123b50df5006b181481ab45fcf1cde807b88d3fd4d340090bc2e202fac41"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-14-image-offload"
    after: "fa8f7d3ebf08a76c7f7a8b0781873c4d819b964da5dbb52cd3cdfa5da34f452d"
    decision: version-bump
  - root: "event:system/message"
    previous: "2026-09-14-image-offload"
    after: "69081694be231d56fd9580ba14645fd5e35373202605d5c5c841a9435b5fa3b1"
    decision: version-bump
  - root: "event:team/message/queued"
    previous: "2026-09-14-image-offload"
    after: "21fb6a90d5068f6a0003b7ab316ed2f56342477146a65c00db0f13c4d8df667d"
    decision: version-bump
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-14-image-offload"
    after: "100f6dca1468538239522cde3533e5bd721d0f1a7b50bea8b0eb533ea6c96163"
    decision: version-bump
  - root: "event:tool/result"
    previous: "2026-09-14-image-offload"
    after: "7c9f44e90a0058f4cc532ae20dad0c10afa6eba22e70a6c79fc79490bad64397"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-09-14-image-offload"
    after: "0f8512903d94f57a4748fa1a2092e64342856796684e6b8343db685b192745ce"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-14-image-offload"
    after: "3f72db3d87a0c5c43e68be467b4cca728eaf5adc1d5d2b6975ff42bfbd961761"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

工具角色声明会改变十个事件根，因为 inbox 条目、消息事件、compaction 摘要、标题请求、团队消息和 PTC dispatch 嵌入了共享的 `Message` 或 `ContentBlock` 声明。从联合中移除 `tool-result` 并按角色细化消息，会改变这些可达 schema，并非新增十套独立事件协议。`turn/end` 的变更单独记录 forked reason；`SessionHeader` 记录版本递增。

[原生 V4 校验决策](../../.agents/notes/implemented/architecture/2026-09-17-native-v4-read-validation.zh.md) 负责说明这些当前字段所需的读取接纳规则。

V3-to-V4 迁移将已发布的 user 角色工具结果提升为 tool 角色消息，包含必需的 toolCallId 和可选的 isError。工具结果包装不再属于内容块联合。迁移保留每个已接纳源事件和继承切分点，并根据同一持久化根目录中保留的直属子 Session 日志追加缺失的父级 subagent/catalog 记录。历史正文恢复要求显式提供子日志证据集合；没有可供补全的子日志时也须传入空集合。子日志的 descriptor 缺失、多条或版本未知时，跳过该子项的补全；身份、时间戳或模式冲突会拒绝迁移且不发布后继。已有 catalog 事实保持不变。历史读取打开在内存中准备结果。写入打开在重新校验子项成员与修订后，将当前后继发布到未修改的前代文件旁。Delivery generation 校验防止历史确认成为有效的 V4 水位。V3 读取方拒绝更新的 generation。已定稿迁移向 turn/end.reason 添加 forked。精确切点的 fork 在继承标记之后追加子会话自有的错误结果和结束事件。V4 接纳经过校验、使用确定性分支 ID 和文案的未启动 fork 结果；已发布的 V0–V3 校验器和已记录的前驱代际保持不变。

`request/header` schema 还将退役的 `system` 键记录为禁止字段。这项声明记录已有的原生读取拒绝规则，不改变存储数据或提示词重建；以后允许该字段携带值时，必须提升格式版本，而不能归类为普通可选字段添加。

生产者拥有的 source 通过 [V3→V4 迁移](../../packages/session/session-format-v3-to-v4/README.zh.md#v3-to-v4-specification)替代已发布的 plugin wrapper。冻结的重命名表和冲突规则保留 source 字段与事件坐标；未知生产者归属保留每个自有 JSON 属性。原生读取和写入打开在公开 Session 之前校验 source 字段。已有 V4 文件不会重新运行迁入边。

核心拥有的 user source 属性记录归属保留策略；tmux-context 将位置归属标记为符合条件，同时保留生产者内部的去重。Auto Review 和压缩摘要器使用仅供请求使用的 user 输入，移除其活动 source 注册，同时保留历史迁移支持。这些输入不能写为持久化 Session 消息。目录 formatVersion 2 保存策略元数据，不改变 Session 版本，也不重写冻结的 schema 记录。System、model 和 tool source 保持严格的语义规则。

Developer 事件保留原始角色，并要求处于打开的 step。每个添加块存储 toolName；developer/message.headerSeq 指向更早且已知的 request/header，其中必须恰好包含一个完整同名 ToolSchema。同一事件的所有添加共用该历史请求头版本，仅移除或其他 developer 消息省略 headerSeq。原生与 Session 接纳拒绝缺失、前向、非请求头、未知请求头、歧义、不完整定义及已退役内嵌定义形式，不解释未知且可忽略的记录，也不丢弃无关 JSON 元数据。同名替换、重启、fork、surface 替换和压缩保留历史模式身份，不查询最新请求头或注册表。通用 sourceEventSeqs 保持独立。Developer source 使用与 user source 相同的已记录归属保留策略。可选的 deferLoading 标记独立于添加历史。已提供的 profile 不发出 developer 记录；提供方序列化、自动发出及 UI 支持仍未启用。

PTC 生产者写入 `source.kind: 'ptc-mode'`。V3→V4 迁入边保留 `tools-code-mode` 和 `tools-ptc` 作为历史 plugin 查找键，并将二者映射到该当前 kind。source 策略保留 `ptc-mode`，不允许将其声明为仅用于归属。

<a id="verification"></a>
## 验证

精确切点 fork 集成后，聚焦的 Session、agent-loop、Session Controller、V4、chat-view 和 compaction 测试共 63 个文件、1,523 个测试通过。V4 fork 测试确认编码、解码和恢复保留原始 ID 与文本，拒绝格式错误的结果，并验证嵌套继承切点。工具角色迁移测试和 SDK 快照刷新也在原始变更中通过；构建后的 Python runtime sdk-snapshot 场景通过，定向 pi-ai 与 auto-review 覆盖率检查通过 351 个测试，三个受影响模块覆盖率均为 100%。

生成的请求头保留字段回归测试以及已有的退役语法和 Session surface 测试共通过三个文件中的 65 项测试。生成字段保留可选的 `never`；允许可选字符串会产生必须提升版本的诊断，而原生读取方仍拒绝该退役键。

Producer-source 与 request-input 检查共通过 12 个文件中的 447 项测试，覆盖 provider 等价性、仅供请求使用的输入的类型拒绝、user 归属保留、source 迁移及原生 source 准入。与 tool-role 父层的生成目录相比，有四个 root 发生变化，447 个类型指纹保持不变。

聚焦的 Session、V4 和 request-input 测试共 38 个文件、884 项通过，完整 V3-to-V4 包与 Session surface 的语句、分支、函数及行覆盖率均为 100%。覆盖历史同名模式绑定、复合添加/移除、畸形引用与定义、未知请求头拒绝、未知记录不透明性、元数据保留、fork、替换、压缩引用，以及不重写 generation 的原生 plain/zstd 读写接纳。

<a id="dev-note"></a>
## 开发备注

无。
