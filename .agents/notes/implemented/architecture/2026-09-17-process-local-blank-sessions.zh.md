# Agent Note: 复用空白 Session 时获取写锁

Status: implemented

[English](2026-09-17-process-local-blank-sessions.md) | 中文

## Problem

两个共享 Session 存储的 Host 在打开 Workspace 时可能选中同一个空白 Session。空白 Session 已有活动 Agent，可以接受 slash 命令，并且可能在创建检查点后持有写锁。无人占用的持久化空白会话也可能带有 Host 重启后仍有用的命令设置。

## Decision

Session 列表包含持久化空白会话。启动恢复选择已保存的空白会话；普通 Workspace 导航按列表顺序选择第一个符合条件且未归档的成员。显式 ID 的 `session.create` 会恢复该 Session，并在打开历史前取得写锁。只有 `session/writer-held` 会触发新建 Session。其他错误返回调用方。同一 Client 的并发 Workspace 连接共享获取与回退过程。后续导航会取消尚未完成的启动选择。

Agent 在整个生命周期内持有取得的句柄。检查占用后释放探测锁，会在恢复前留下竞态。持久化数据与 Remote schema 均不引入 PID 或进程身份。

本决策扩展 [Client Session scope 决策](2026-07-25-web-client-session-scope-and-provide-channel.zh.md)中的空白会话复用策略；其真实 Session 支持 slash 以及 Provider 收养的理由仍然有效。

## Alternatives considered

**纯客户端草稿。** Slash 命令与 Session 作用域插件在首条提示词之前就需要真实 Session。延迟创建需要单独的命令生命周期。

**释放活动空白会话的写锁。** Blank 表示没有 `turn/start`，并不表示没有事件。活动 Agent 仍可能追加命令与配置事件，因此释放其锁会允许多个写入方竞争。

**隐藏所有冷空白会话。** 这会让导航丢失可复用的命令设置，并且每次重启都创建另一空白会话，即使旧写锁已空闲。

**持久化创建者 PID。** 内核写锁已能仲裁获取操作。PID 复用与过时的创建者记录无法增加权威性。

## Consequences

Host 可以复用自己的活动空白会话，也可以接管无人占用的持久化空白会话并保留其 slash 状态。现有写锁被持有时，不同 Host 创建不同的空白会话。所选空白会话被占用时，即使另有空闲空白会话也会新建；导航不再寻找其他候选。不增加清理逻辑。两个 Host 打开同一个已有对话时仍可能遇到写锁争用。未知投影提示仍可见且不扫描冷日志正文；自动复用要求已知的空白元数据。非锁争用的获取错误会中止新建会话，目前只报告到控制台；此流程没有针对隐藏空白会话的恢复操作。

## Verification

导航测试覆盖已保存选择、单候选锁争用回退、其他错误、重叠获取以及后续导航替代。实际 Web 组合测试持有真实持久化写锁，验证另有空闲空白会话时仍新建，并接管已释放的所选空白会话及其 plan 状态。fresh-round-trip 的录制 Session 场景在提交已录制的提示词前刷新空白会话。
