# Agent Note: 遥测、反馈与 DeepSeek 请求共享匿名用户 id

Status: implemented
Archived: 2026-09-04

[English](2026-08-07-shared-feedback-telemetry-user-id.md) | 中文

## 问题

OpenTelemetry 后端已在 `$DSH_HOME/.anonymous-user-id` 中持久化一个匿名 UUID。`/feedback` 需要同时报告接收反馈的会话 id 与用户 id，以便运维人员将确认文本与导出的记录相关联。复制该身份或单独生成身份会使报告的用户失去意义；从 `session-telemetry-otel` 导入身份则会让直接命令依赖导出后端，并在遥测侧挂载反馈导出时形成依赖环。

早先的[匿名用户 id 决策](../feature/2026-07-31-telemetry-anonymous-user-id.zh.md)刻意将辅助函数留在 OTel 后端内，直至出现第二个真实消费方。反馈成为第二个消费方，[直连 DeepSeek 请求身份](../feature/2026-08-11-deepseek-request-user-id-header.zh.md)则是第三个。

## 决策

`@deepseek-ai/dsh-anonymous-user-id` 负责 `getOrCreateAnonymousUserId()` 和 `$DSH_HOME/.anonymous-user-id` 存储约定。`session-telemetry-otel` 将返回的 id 用作 OpenTelemetry Resource 的 `user.id`；`/feedback` 的成功确认先报告 `Feedback recorded for session {sessionId}`，再在第二行显示 `User: {userId}`；直连 DeepSeek 请求则通过 `x-deepseek-harness-user-id` 携带它。系统在获取 id 前拒绝无效反馈，DeepSeek 适配器也仅在凭据解析成功后获取 id，因此空命令和凭据失败都不会创建 `.anonymous-user-id`。

此次抽取保留既有的随机 UUID、home 解析、进程内缓存、独占创建并发、损坏文件替换与 best-effort 写入语义。

## 考虑过的替代方案

| 已否决 | 原因 |
|---|---|
| 从 `session-telemetry-otel` 导入辅助函数 | 使反馈耦合到可选的导出后端，并在遥测导出反馈后形成反向依赖环 |
| 在反馈中复制持久化辅助函数 | 同一文件约定的两份实现可能发生偏差，并因校验或失败语义不同而产生竞态 |
| 生成独立的反馈用户 id | 确认文本无法与 OTel Resource 相关联，因而不能达到报告目的 |

## 后果

- 一个 harness home 只有一个匿名 id，由反馈确认、会话遥测导出与直连 DeepSeek 请求共享。
- 反馈包只依赖身份能力，不依赖遥测 seam 或 OTel SDK。
- 该包由三个消费方使用，成为有充分依据的共享库；其空不变式伴生插件解释了为何读取私有文件并非有用的运行时关系检查。
- 原始匿名用户 id Note 仍是存储与隐私语义的权威记录；本 Note 仅取代其中由 OTel 本地拥有身份的决策。
