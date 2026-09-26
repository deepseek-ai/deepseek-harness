# Agent Note: 会话写句柄占用反馈

Status: implemented

[English](2026-09-16-session-writer-held-feedback.md) | 中文

## Problem

Agent 空闲时，Session 仍可能持有写句柄。另一个 Host 无法恢复该会话，但通用内部错误 toast 没有提供恢复指引。持有者也可能属于同一个进程，因此仅凭占用不能确定是另一个正在运行的应用。

## Decision

当恢复因 `SessionAlreadyOwnedError` 失败且不存在可复用 Agent 时，Session Controller 返回 `session/writer-held`，携带 `{ sessionId }`。Client 遵循 [Remote 失败词汇](../architecture/2026-08-28-ctx-remote-failure-vocabulary.zh.md)，按 code 判别。Controller 按 Error 名称识别持久化错误，与 Session Query 的可选依赖处理一致；加载 Controller 不需要持久化实现或错误类身份相同。

发送和模型选择失败显示本地化指引，说明可能有其他 DSH 实例占用 Session，并建议退出其他实例后重试。模型选择将原始 Remote 结果返回给两个 UI 入口；错误分类不依赖稍后读取共享目录状态。[写租约决策](../feature/2026-08-31-cross-process-session-write-lease.zh.md) 继续拥有锁定和释放语义；此反馈既不抢占写权限，也不自动重试写入。

## Alternatives considered

**在 `session/agent-busy` 下使用自由文本 reason。** 第二个字符串判别值失去 code 与 details 的类型关系，并将写占用与提示词接纳失败混在一起。

**单独的目录标志或必需的持久化 peer。** 标志重复记录操作失败，且可能在目录刷新后过时。仅为识别错误而强制依赖持久化，会移除对无持久化部署的支持。

## Consequences

Wire 新增一个有类型的失败码，不改变已存储的 Session 数据。恢复指引无法确定哪个进程持有句柄。Host 测试覆盖错误名称，以及有、无持久化时的普通失败；Client 测试覆盖两种语言和随模型操作返回的失败。无密钥的 `queue-actions` Web 场景通过随附组合固定写占用 toast 和保留草稿的输出。`verify-optional-dependency-imports` 防止可选依赖的值导入破坏模块加载。
