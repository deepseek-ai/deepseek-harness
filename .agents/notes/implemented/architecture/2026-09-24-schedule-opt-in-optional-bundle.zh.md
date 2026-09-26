# Agent Note: Schedule 作为按需开启的可选 bundle

Status: implemented

[English](2026-09-24-schedule-opt-in-optional-bundle.md) | 中文

> 取代[默认 Web 组合中的 Schedule](../../archived/architecture/2026-09-24-web-default-schedule-composition.md)：这三行现在默认禁用，打开它们是此 bundle 的职责。

## Problem

`packages/bundle/web-app/cordis.patch.yml` 以 `disabled: true` 插入 `time-context`、`schedule` 与 `ui-schedule`，因此随发行版交付的 Web 组合不提供任何定时能力：没有 `schedule_*` 工具、没有 Session 提醒目录、没有自动化任务页面，也没有逐步时钟读数。这些条目在产品界面上没有开关；想要它们的部署要改 profile patch 层或传 `--patch` overlay，而两者都是使用随发行版 Web profile 的人无法触及的配置文件。

## Decision

这三行仍留在组合中，因为按 id 定位的 patch 覆盖的是已存在的行：profile patch 或 bundle 把某行的 `disabled` 设为 `false`，无需再次插入它。

`@deepseek-ai/dsh-experimental-schedule-bundle`（`packages/experimental/schedule-bundle/`）在其 `cordis.patch.yml` 中携带三个按 id 定位的 patch，每行一个，各自把 `disabled` 设为 `false`；它不插入任何行。`packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES` 列出该包，`apps/cli` 将其声明为运行时依赖，因此每次安装都随包携带且默认关闭。[实验性能力作为可选 bundle 的决策](2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)负责 `OPTIONAL_BUNDLES` 的约定，以及 Web 插件管理页在 Official 分组中渲染的本地化 `icon` 与 `meta.title` / `meta.description` 元数据。

启用该 bundle 会打开 `time-context`（每个步骤的时钟读数，包含采样瞬时、附加到当前开放请求的浏览器时区，以及自前一条模型可见消息以来的经过时长）、`schedule`（持久提醒，以及每个活跃根 Agent 上的 `schedule_create`、`schedule_list`、`schedule_update` 与 `schedule_delete`），以及 `ui-schedule`（Session 提醒目录与自动化任务页面）。该 bundle 把 `time-context` 与 `schedule` 一起打开，因为提醒请求给出的是挂钟时间目标：采样瞬时正是让模型把“明天九点”这类请求转换成带偏移量的 `at` 值的依据。持久记录、投递与管理操作由 [Schedule 子系统](../../../../docs/subsystems/schedule.zh.md)负责；承载这些禁用行的组合由 [Web bundle](../../../../packages/bundle/web-app/README.zh.md)负责。禁用该 bundle 会恢复随发行版交付的组合，`schedule` 行保持禁用期间 Host 不再调度；已存储的任务记录保留在 Schedule domain 中。

## Alternatives considered

**默认发布 Schedule。** 那样每个 Web 会话都要在每个请求头中带上四个工具 schema，并在每个符合条件的步骤追加一条持久 user 消息，从不创建提醒的对话也要承担这两项成本。这种安排还让该能力在产品界面上没有关闭开关。

**保留一个 `--patch` overlay 文件。** overlay 是启动时的参数，而不是产品界面上的开关，因此使用随发行版 `web` profile 的人无法触及它。通过它的 `insert` 列表重新声明这些条目并不能覆盖它们：`applyEntryPatches` 追加该列表时不对 id 去重，而 Loader 会把组合出的列表按 id 收敛为一个条目、最后一个声明生效，因此该 overlay 会替换 Web Bundle 的条目，而不是给它们设值。

**把这三行从 Web 组合中抽出、移入 bundle。** 这样 bundle 会插入这些行而不是覆盖它们；某个 profile 若也声明了这些 id，同一个 id 就会有两份声明，而 Loader 只保留最后一份。按需开关针对的正是这些禁用行。

## Consequences

- 默认的 `dsh web` 会话不带 Schedule 工具 schema、Session 提醒目录、自动化任务页面与逐步时钟读数。需要它们的安装可从插件管理页启用该可选 bundle，或把该包列进 profile 的 `dsh.profile.bundles`。
- 启用后的安装会给每个活跃根 Agent 增加四个工具 schema，并在每个符合条件的步骤追加一条持久时钟消息；该读数对模型可见且持久，因此它与其他 user 消息一样参与回放、压缩，并出现在导出的 Session 日志中。
- 在不携带这三行 Web 行的组合中，该 bundle 的每个补丁都会报告一条 `patch: entry <id> not found` 警告且不挂载任何东西；其包不声明插件依赖，因此启用它不会重复挂载同一个 Host 服务。
- 该开关只涉及配置：`src/index.ts` 是空模块，运行时内容由 patch 承载，包本身不拥有可变的运行时状态，因此不发布不变量伴随模块。
