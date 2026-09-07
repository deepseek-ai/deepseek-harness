# Agent Note: 遥测匿名用户 id（$DSH_HOME/.anonymous-user-id）与 OTel Resource 的 user.id

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-telemetry-anonymous-user-id.md) | 中文

## 问题

session telemetry 已默认挂载（[默认挂载 Note](2026-07-31-web-telemetry-default-mount.zh.md)），但 OTel Resource 只有 `service.name`/`service.version`，没有任何用户级标识——接收端无法按用户聚合、无法数活跃用户。此前唯一相关口径是一条未实现的「hostname/本机 IP 哈希派生 user.id」裁定。需要给 OTel 回流一个语义干净的匿名用户身份。

## 决策

`getOrCreateAnonymousUserId()` 返回 `$DSH_HOME/.anonymous-user-id`（`resolveDshHome` 解析，`$DSH_HOME` > `~/.dsh`）中的裸 UUID 行，首用生成随机 UUID v4 并落盘；后端构造时把它作为 Resource 的 `user.id`（OTel semconv 标准用户属性）随每批导出携带一次。原始实现位于 `session-telemetry-otel`，因为当时不存在第二个真实消费方。`/feedback` 后来成为该消费方，因此[共享 id 决策](../architecture/2026-08-07-shared-feedback-telemetry-user-id.zh.md)将所有权移交给 `@deepseek-ai/dsh-anonymous-user-id`，但不改变本 Note 记录的存储、匿名、并发与丢失语义。[直连 DeepSeek 请求身份](2026-08-11-deepseek-request-user-id-header.zh.md)是同一 id 的第三个消费方。

| 裁定 | 取值 | 理由 |
|---|---|---|
| id 来源 | 随机 UUID v4，绝不从 hostname/网络地址/git remote 派生 | 派生 id 可反查，「匿名」名不副实 |
| 存储形态 | `.anonymous-user-id` 裸 UUID 行 + 换行，无 JSON 包装 | 身份是独立事实，不挂在某条遥测链路的文件命名/格式下 |
| 读写形态 | 同步 IO + 进程内按解析后文件路径 memo | `OpenTelemetrySessionBackend` 构造函数是同步的（async 迫使插件装载改形）；一进程一次盘 IO，运行中删文件不影响本进程 |
| 并发首启 | `wx` 独占写裁决，落败方重读胜者 id | 覆盖常见并发（重读撞进胜者建档-写入微秒窗仍可能导致该次运行中每个进程各持一个 id，下次启动收敛到落盘值——遥测级后果，接受） |
| 丢失语义 | 文件被删 → 下次启动换新 id，接受丢失 | 匿名身份无恢复价值；可恢复性要求派生材料，与匿名冲突 |
| 写失败 | best-effort 返回内存 id | 遥测绝不因 home 只读被阻塞 |
| 上报位置 | Resource 属性，非逐条 attributes | 每批一次即够接收端按 Resource 维度聚合；逐条注入要动 seam 约定且涨 wire 体积 |
| semconv 依赖 | 不引 `@opentelemetry/semantic-conventions` 包 | 一个字符串常量不值一个依赖 |
| 落点 | `@deepseek-ai/dsh-anonymous-user-id`，由 OTel 后端、`/feedback` 与直连 DeepSeek 请求共享 | 消费方共用同一存储契约，且不依赖导出后端 |
| 单独开关 | 无 | 任一消费方都可创建该身份；`DSH_TELEMETRY_DISABLED` 会停止遥测上报，但不会禁用反馈确认或 DeepSeek 请求头 |

## 考虑过的替代方案

| 被拒 | 一句话理由 |
|---|---|
| hostname/IP 哈希派生 id（此前口径） | 可反查即非匿名；随机 UUID 语义干净，用户已裁定取代此前口径 |
| user.id 放每条 record 的 attributes（Claude Code 形态） | 要动 session-telemetry seam 约定或逐条注入，wire 体积涨；Resource 每批一次已满足聚合 |
| 在 `/feedback` 需要该 id 之前抽取共享包（初版实现） | 当时唯一的真实消费方是 OTel 后端；只有直接反馈需要同一个关联 id 后，抽取才具备依据 |
| AppCLIEntry 读好 id 经 config patch 注入 | 每个 surface 入口都要接线；config 里传运行时事实与部署配置混淆 |
| 挂进 `@deepseek-ai/dsh-home-paths` | paths 是纯路径计算零 IO；带持久化的身份能力会污染包边界 |

## 后果

- 一个 `$DSH_HOME` 在 OTel 回流中是一个稳定用户；不同 home 在构造上就是不同用户，无跨 home 关联机制。
- OTel 回流、`/feedback` 与直连 DeepSeek 请求共享 `.anonymous-user-id`。
- 删除 `.anonymous-user-id` 即重置身份（下次启动生效）；home 不可写时每进程各自持有一个内存 id 直至恢复可写。
- [默认挂载 Note](2026-07-31-web-telemetry-default-mount.zh.md) 的身份 follow-up 中「匿名用户 id」项由本决定关闭；hostname/surface 维度与脱敏规则、usage-metrics track 仍是待办。
