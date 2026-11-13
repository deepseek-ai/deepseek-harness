# Agent Note: harness home 路径类别

Status: proposed

[English](2026-11-04-dsh-home-path-categories.md) | 中文

## 问题

各个包在 `$DSH_HOME`（默认 `~/.dsh`）下自行构造路径，因此 home 根目录混杂着用户配置、持久记录、日志、索引和下载内容。新的服务或插件没有规则可以确定其文件应放在哪里，部分负责方还会手动解析 home：[liveshare](../../../../packages/experimental/liveshare/src/host/share-host.ts) 直接读取 `process.env.DSH_HOME`，[migrate-sessions-to-v4](../../../../scripts/migrate-sessions-to-v4.ts) 默认使用 `~/.dsh/sessions`，不读取 `DSH_HOME`。

## 方案

按照 [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/) 使用的类型，对 `$DSH_HOME` 下的路径分组。每个类别都位于 `$DSH_HOME` 内；harness 不读取 `XDG_*` 变量。

| 类别 | 存放内容 | 丢失后果 |
|---|---|---|
| `config` | 用户为配置 harness 而编写或编辑的文件 | 丢失用户配置 |
| `data` | 持久记录：用户工作成果、登录信息、已安装的软件 | 丢失用户工作成果、登录信息或已安装的软件 |
| `state` | 跨运行保留但不属于用户工作成果的记录：日志、索引、id、保留的输出 | 历史被重置；harness 仍可正常工作 |
| `cache` | harness 可以重新构建或重新下载的内容 | 仅耗费时间或带宽 |
| `backup` | harness 写入的备份压缩包，例如 home 或 profile 的压缩副本 | 无影响；正常运行时不会读取这些压缩包 |

不设 `runtime` 类别（XDG 中用于 socket 和 pid 文件的类型），因为没有负责方需要在 home 下使用它：锁文件放在其保护的文件旁边，而活动的 socket 留在操作系统临时目录中，因为 Unix socket 路径有长度限制。`backup` 不是 XDG 的类型：它为备份压缩包提供一个目录，用户和清理工具可以随时清空，不影响运行中的 harness，也不影响被备份的记录。

### 路径辅助函数

`@deepseek-ai/dsh-home-paths` 中的 [`dshPath(category, ...segments)`](../../../../packages/util/home-paths/src/index.ts) 返回 `<home>/<category>/<segments>`，不创建目录；`dshPath({ category, dshHome }, ...segments)` 基于显式配置的 home 解析路径。Loader `!!js` 配置表达式在 `dshHomePath` 之外也可以使用同一个函数。home 下的新路径使用 `dshPath`，并把负责方的目录名作为第一个路径段传入，该目录名通常是去掉 `@deepseek-ai/dsh-` 前缀的包名。`dshHomePath` 继续用于现有的顶层条目，`dshCachePath` 等同于 `dshPath('cache', ...)`。

### 约定的顶层条目

用户会直接打开、编辑这些条目并在脚本中引用它们，仓库中的文档也提到它们，因此它们保留当前的顶层位置，不在迁移候选之列：

| `$DSH_HOME` 下的路径 | 负责方 | 类型 |
|---|---|---|
| `.env` | [app-boot](../../../../packages/boot/app-boot/README.zh.md) 环境层 | config |
| `cordis.patch.yml` | [app-boot](../../../../packages/boot/app-boot/README.zh.md) home patch 层 | config |
| `AGENTS.md` | [agent-instructions](../../../../packages/context/agent-instructions/README.zh.md) | config |
| `skills/` | [skill-filesystem](../../../../packages/skill/skill-filesystem/README.zh.md) | config |
| `.credentials.yaml` | [credentials-local](../../../../packages/credentials/credentials-local/README.zh.md) | data |
| `profiles/<name>/` | [app-boot](../../../../packages/boot/app-boot/README.zh.md)、plugin-manager、Desktop（`desktop` profile 及其 `lock`） | data |
| `sessions/` | base 和 sdk-minimal bundle 中的 session-persistence-jsonl 根目录 | data |
| `cache/` | 已经是 `cache` 类别 | cache |

profile 目录内的文件，例如 `node_modules/`、`pnpm-lock.yaml`、`compatibility.json`、`.plugin-manager/`、`.plugin-market/repositories/`、`created-plugins/` 和 `cua-*.lock`，随所属 profile 保留，因为 pnpm 和 profile 工具按相对于 profile 的路径访问它们。旧版 `settings.yaml` 导入器继续读取 home 根目录，因为该文件是导入来源。

### 其他现有条目

这些条目没有面向用户的约定。每一行给出该条目所属的类别；迁移它属于单独的变更，需要数据迁移方案：

| `$DSH_HOME` 下的当前路径 | 类别 | 负责方 | 原因 |
|---|---|---|---|
| `storages/` | `data` | base bundle 中的 storage-json 根目录 | Workspace、schedule 及其他领域记录；其中 `session_projcache` 单元是可重建的缓存，但 storage-json 只有一个根目录 |
| `attachments/v1/` | `data` | [attachment-local](../../../../packages/attachment/attachment-local/README.zh.md) | 用户附件；Session 历史记录了它们的绝对路径 |
| `dsh-runtimes/` | `data` | Desktop 离线运行时（[workspace-dependencies](../../../../packages/bundle/web-app/cordis.patch.yml)） | 已安装的软件，可能包含用户添加的内容 |
| `liveshare/` | `data` | [liveshare](../../../../packages/experimental/liveshare/README.zh.md) 的所有者状态和凭据 | 存放管理令牌 |
| `.anonymous-user-id` | `state` | [anonymous-user-id](../../../../packages/identity/anonymous-user-id/README.zh.md) | 丢失后只会生成新的 id |
| `logs/` | `state` | CLI 启动失败报告 | 日志 |
| `llm-deepseek/files-v3.json` | `state` | [llm-deepseek](../../../../packages/llm/llm-deepseek/README.zh.md) 上传索引 | 派生索引 |
| `office-kit/outputs/` | `state` | [office-kit](../../../../packages/document/office-kit/README.zh.md) | 保留的转换输出，超过保留期后删除 |
| `speech-to-text/sensevoice/` | `cache` | voice-input-bundle | 可下载的模型 |
| `cache/attachments/` | `cache` | attachment-local 请求图片 | 已位于 `cache` 中 |

### home 之外

以下位置不在本提案范围内：`~/.agents`（`DSH_AGENTS_HOME`），与其他 agent 工具共享；Electron 的 `userData` 和 `logs`，由 Electron 管理；Python SDK 资源缓存 `~/.cache/deepseek-harness/resources`（`DSH_RESOURCE_CACHE`），在多个 home 之间共享；操作系统临时目录下的 spill 和子进程输出目录；以及开发者或发布脚本的状态，例如 `~/.dsh-desktop-signing`。

## 备选方案

**立即迁移所有条目。** 最初的草案把所有条目（包括约定的条目）都移入类别目录，且不提供回退。这样做会使每个现有 home 在升级后看起来为空，使 Session 中记录的附件绝对路径失效，并重命名用户手动编辑的文件。上述约定条目现在保持不动，其余迁移等待迁移方案。

**读取 `XDG_*` 变量。** 把 home 拆分到 `XDG_CONFIG_HOME`、`XDG_DATA_HOME` 等多个根目录，会让一次安装分散到多个目录，并破坏测试、SDK 和 Desktop 所依赖的单一 `DSH_HOME` 覆盖；[单一 harness home 解析器](../../implemented/architecture/2026-07-24-single-harness-home-resolver.zh.md)已经否决了拆分根目录。本提案只借用分类方式，并且仍在这一个根目录之内。

**增加 `runtime` 类别。** 当前没有负责方需要它；增加它会发布一个未使用的值。

## 验收标准

- `$DSH_HOME` 下的新路径使用 `dshPath` 构造，并落在某一个类别目录中。
- 每次迁移“其他现有条目”中的条目时，都附带一个保留现有用户数据的迁移，以及一份升级指南。
- 约定的顶层条目保留其位置。

## 风险

在迁移落地之前，home 中同时存在类别目录和旧的顶层条目。迁移 `attachments/` 会使 Session 历史中的绝对路径失效，除非迁移保持旧位置可读。手动解析 home 的负责方在被修改之前不会使用该辅助函数。
