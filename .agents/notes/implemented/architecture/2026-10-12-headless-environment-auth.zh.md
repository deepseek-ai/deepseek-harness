# Agent Note: Headless 任务不挂载交互式凭据存储

Status: implemented

[English](2026-10-12-headless-environment-auth.md) | 中文

## 问题

[已保存凭据优先级](2026-10-09-stored-credential-precedence.zh.md)的决策保证 GUI 保存的密钥生效，即使 shell 为其他应用导出了密钥。共享同一个 Harness home 的 headless 任务可能因此使用 GUI 的账户，而不是显式传给任务的密钥。只调整引用优先级仍会让 pi-ai 提供方记录和已保存 grant 排在环境变量之前。

## 决策

随附 headless 组合包禁用 base 中的 `credentials`、`authorization` 和 `deepseek-account` 行。API 密钥适配器已经支持不挂载凭据服务的组合，按启动快照解析：进程环境、运行命令的目录 `.env`、Harness home `.env`。该 profile 不读取、迁移、写入或删除 `.credentials.yaml`。显式禁用依赖它的 authorization 和 account 行，避免普通任务输出等待服务的警告。

这部分取代了已保存凭据优先级中针对随附 headless profile 的单次覆盖策略。其他 profile，以及显式恢复存储的 headless，仍按已保存凭据优先解析。headless [README](../../../../packages/bundle/headless/README.zh.md#credentials)负责恢复 patch 的用法。

## 考虑过的替代方案

**在所有 profile 中让环境变量优先。** 这会使 GUI 保存的密钥无法替换启动环境中遗留的密钥，并恢复引用与提供方记录之间不一致的优先级。

**只禁用 credentials 行。** 这能选用环境变量，但 authorization 与 account 提供方会保持 pending，每次启动都产生警告。

**给存储增加第二种优先级模式。** 现有适配器后备与 profile 覆盖已经满足需求；这种做法却会把额外配置和记录处理策略引入共享提供方。

## 后果

- Headless 忽略已保存 API 密钥、提供方记录和 grant。依赖已保存登录凭据的提供方或 DeepSeek account 路由会失败，直到用户恢复存储认证；恢复后也恢复已保存凭据优先。
- 环境变量与提供方外部凭据链仍然可用。会话、settings 与工具继续组合；不挂载存储不会禁止工具读取文件系统。
- Web、SDK 与 ACP 保留凭据存储；其认证、登录和刷新实现不变。
- Profile 进程测试覆盖三个环境层、具名与原生 pi-ai 认证、缺失密钥、忽略畸形存储、恢复存储，以及文件保持原样。现有 headless 录制与真实模型工作区测试覆盖组合中的其余行为。
