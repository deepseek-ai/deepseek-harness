---
kind: upgrade-guide
description: "挂载存储时，已保存凭据现在优先于环境后备；随附 headless profile 不挂载存储认证。"
---

# 存储的密钥优先于导出的变量

[English](guide.md) | 中文

## 变更

早期版本会先使用导出的环境变量，再使用 `$DSH_HOME/.credentials.yaml`（默认为 `~/.dsh/.credentials.yaml`）中同名的 `refs` 条目。这适用于 `DEEPSEEK_API_KEY=… dsh`、shell 配置文件中的导出、CI 机密和容器 `-e` 值。该名字被导出期间，Models 页面无法为其保存密钥。

现在存储的条目优先。只有当文件没有为该名字存储值时，导出的变量才会生效；`$cwd/.env` 和 `$DSH_HOME/.env` 仍排在两者之后。即使该名字已被导出，Models 页面也可以保存和替换密钥。

随附的 `headless` profile 则禁用凭据存储、authorization 和 DeepSeek account 提供方。它依次使用启动环境、项目 `.env` 和 Harness home `.env`，并保持 `.credentials.yaml` 原样。已保存 API 密钥和登录凭据默认不再为 headless 任务提供认证。Web、SDK 和 ACP 保留存储。

如果某个 harness home 在 `refs` 下存储了值，而启动 `dsh` 的进程导出了同名变量，你就会受到影响。挂载了这类 home 的容器也包括在内。请求现在使用存储的密钥，而不是导出的密钥。以全新 harness home 启动、没有 `.credentials.yaml` 的 CI 作业或容器不受影响。[存储凭据优先级](../../../../.agents/notes/implemented/architecture/2026-10-09-stored-credential-precedence.zh.md) Agent Note 记录了原因。

## 迁移

1. 将 `$DSH_HOME/.credentials.yaml` 中 `refs` 下的名字，与 shell、CI 作业或容器导出的变量进行比较。只出现在其中一处的名字无需处理。
2. 对同时出现在两处的名字，如果存储的密钥正是你要使用的账户，就保留它。否则，删除 `refs` 下该名字所在的行。运行中的 harness 会重新加载该文件，因此下一次请求无需重启即可读取导出的变量。
3. 对 headless 任务，导出所需密钥并运行 `dsh headless "<task>"`。要继续使用已保存密钥或登录凭据，请应用三行配置的 [headless 恢复 patch](../../../../packages/bundle/headless/README.zh.md#credentials)；恢复存储也恢复已保存凭据优先。现有 profile、home 或命令覆盖可以覆盖随附行，因此核对有效组合时请查看 `dsh headless --dump-config`。
4. 确认请求使用预期账户，并在需要时确认启动进程导出了非空值。只检查名字和是否存在，不要打印凭据值。仅依赖已保存凭据的 headless 运行现在会失败；恢复存储或提供受支持的环境认证即可解决。
