# Agent Note: 复用空白 Session 时获取写锁

Status: implemented

[English](2026-09-17-process-local-blank-sessions.md) | 中文

## Problem

两个共享 Session 存储的 Host 在打开 Workspace 时可能选中同一个空白 Session。空白 Session 已有活动 Agent，可以接受 slash 命令，并且可能在创建检查点后持有写锁。无人占用的持久化空白会话也可能带有 Host 重启后仍有用的命令设置。

## Decision

Session 列表包含持久化空白会话。启动恢复选择已保存的空白会话；普通 Workspace 导航按列表顺序选择第一个符合条件且未归档的成员。显式 ID 的 `session.create` 指明该 Session；Host 恢复它并在打开历史前取得写锁，写锁被其他写者持有时改为新建 Session（[复用与 preset 规则](../bug-fix/2026-09-29-reused-blank-runs-requested-preset.zh.md)）。其他错误返回调用方。同一 Client 中的 Workspace 连接仅在与该 Workspace 最近一次进行中的连接请求相同 preset 时与之合并。后续导航会取消尚未完成的启动选择。

Agent 在整个生命周期内持有取得的句柄。检查占用后释放探测锁，会在恢复前留下竞态。持久化数据与 Remote schema 均不引入 PID 或进程身份。

本决策扩展 [Client Session scope 参考](2026-09-15-client-session-references.zh.md)中的空白会话复用策略；其真实 Session 支持 slash 以及 Provider 收养的理由仍然有效。

## Alternatives considered

**纯客户端草稿。** Slash 命令与 Session 作用域插件在首条提示词之前就需要真实 Session。延迟创建需要单独的命令生命周期。

**释放活动空白会话的写锁。** Blank 表示没有 `turn/start`，并不表示没有事件。活动 Agent 仍可能追加命令与配置事件，因此释放其锁会允许多个写入方竞争。

**隐藏所有冷空白会话。** 这会让导航丢失可复用的命令设置，并且每次重启都创建另一空白会话，即使旧写锁已空闲。

**持久化创建者 PID。** 内核写锁已能仲裁获取操作。PID 复用与过时的创建者记录无法增加权威性。

## Consequences

Host 可以复用自己的活动空白会话，也可以接管无人占用的持久化空白会话并保留其 slash 状态。现有写锁被持有时，不同 Host 创建不同的空白会话。所选空白会话被占用时，即使另有空闲空白会话也会新建；导航不再寻找其他候选。不增加清理逻辑。两个 Host 打开同一个已有对话时仍可能遇到写锁争用。未知投影提示仍可见且不扫描冷日志正文；自动复用要求已知的空白元数据。非锁争用的获取错误会中止该次导航；在 hero 中选择工作区或显式准备草稿时以提示展示该错误，启动恢复只报告到控制台，以此方式失败的隐藏空白会话在此流程中没有恢复操作。

## Verification

导航测试覆盖已保存选择、为被占用候选打开 Host 返回的 Session、其他错误、重叠获取以及后续导航替代。实际 Web 组合测试持有真实持久化写锁，验证另有空闲空白会话时仍新建，并接管已释放的所选空白会话及其 plan 状态。fresh-round-trip 的录制 Session 场景在提交已录制的提示词前刷新空白会话。
