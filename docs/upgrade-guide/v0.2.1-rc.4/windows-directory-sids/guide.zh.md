---
kind: upgrade-guide
description: "Windows ACL 调用方使用派生的逐目录 SID，不再提供一个共享的写入 SID。"
---

# Windows ACL 目录身份

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-sandbox-windows-acl` 用 `directoryWriteSid` 替换 `workspaceWriteSid`。`AclSandbox` 为每个规范可写目录派生独立身份：构造器不再接受 `writeSid`，其 `writeSid` 属性替换为只读 `writeSids` 数组。私有临时 SID 继续独立。标准 `dsh` profile 的用户无需修改配置。

## 迁移

1. 在直接调用 `AclSandbox` 的代码中移除 `writeSid` 选项。继续传入 `writableDirs`、`mode` 和显式 `tempDir`；启用临时目录写入时保留 `tempWriteSid`。检查派生身份时读取 `writeSids`。
2. 在 `AclSandbox` 之外物化授权时，将 `workspaceWriteSid(path)` 导入替换为 `directoryWriteSid(path)`。每个规范目录只授予其自身的 SID，不要将同一 SID 授予多个目录。
3. 对于调用方管理授权的 runner 调用，按去重后先工作区、再额外根目录的顺序，为每个规范目录重复一次 `--write-sid`，并保留 `--temp-write-sid`。无 agent 调用省略这两类 SID 标志。
4. 编译调用方，并在 Windows 上验证新进程可以写入允许的目录，且无法写入策略中未包含的目录。已有进程保留启动时的权限。
