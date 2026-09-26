---
description: "从插件管理页启用出厂的定时服务、提醒目录与自动化任务页面。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-schedule-bundle

[English](README.md) | 中文

## 概述

此可选 Bundle 打开 `@deepseek-ai/dsh-web-app` 以 `disabled: true` 插入的三个定时条目：`time-context`、`schedule` 与 `ui-schedule`。它的补丁不追加条目，也不声明插件依赖，因此启用它不会重复挂载同一个 Host 服务。随包配置默认禁用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

打开 Web 侧栏的插件管理页并启用带时钟图标的“定时与时间上下文”。此后，活跃的根智能体获得 `schedule_create`、`schedule_list`、`schedule_update` 与 `schedule_delete`，会话头部显示提醒目录，侧栏的自动化任务入口打开任务管理页面、右侧栏承载所选任务的详情，每个符合条件的步骤追加一条时钟读数，包含当前时间、打开请求所带的浏览器时区，以及距上一条模型可见消息的经过时间。禁用此 Bundle 会恢复随包组合；已存储的任务保留在磁盘上。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`cordis.patch.yml` 包含三个按 id 定位的补丁，各自把 Web Bundle 已插入条目的 `disabled` 设为 `false`。`packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES` 列出此包，`apps/cli` 依赖它，因此每次安装都随包携带且默认禁用，插件管理页在 Official 分组中提供它。选中后会把该 Bundle 追加到 profile 的 `dsh.profile.bundles` 列表末尾；Bundle 层按列表顺序应用，因此这些补丁能命中条目，只是因为该列表把 `@deepseek-ai/dsh-web-app` 排在此包之前。手写顺序把此包排在最前时，这些条目保持禁用，而插件管理页仍把该开关显示为已启用。此纯配置包不拥有可变的运行时状态，因此不发布不变量伴随模块。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 针对出厂 Web 条目的三个 `disabled: false` 补丁 |
| [`locale/en.json`](locale/en.json)、[`locale/zh.json`](locale/zh.json) | 插件管理页的标题与描述 |
| [`icon.svg`](icon.svg) | 插件管理页图标 |
| [`src/index.ts`](src/index.ts) | 空的模块入口；补丁即运行时内容 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [定时子系统](../../../docs/subsystems/schedule.zh.md) — 持久任务、发生时刻解析与投递。
- [定时服务](../../schedule/schedule/README.zh.md) — Host 任务存储、激活与记录格式。
- [Web Bundle](../../bundle/web-app/README.zh.md) — 携带这些条目的组合。

-----

<a id="model-experience"></a>
## 模型体验

### 提醒工具与时钟读数

#### 模型看到的内容

活跃的根智能体获得 `schedule_create`、`schedule_list`、`schedule_update` 与 `schedule_delete`。`time-context` 在每个符合条件的步骤追加一条持久用户消息，携带采样时刻、打开请求所带的浏览器时区，以及距上一条模型可见消息的经过时间。

#### Token 影响

启用该 bundle 会给每个活跃根 Agent 请求增加四个定时工具的 schema，并为每个符合条件的步骤增加一条持久时钟读数；即使对话从不创建提醒也会承担这两项开销。

#### KV 缓存影响

四个工具的 schema 在 bundle 挂载时改变一次请求前缀；每条追加的读数都是该前缀之后的新可见内容，因此不会使已有条目失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 此开关针对 `@deepseek-ai/dsh-web-app` 插入的条目。在没有该 Bundle 的 profile 中，三个补丁匹配不到任何条目：加载器为每个条目报告一条 `patch: entry <id> not found` 警告，且不从该 Bundle 挂载任何东西；这样的 profile 也不挂载插件管理页。
- 该 Bundle 的详情页没有逐条目开关。Host 把被覆盖的三个 id 报告在 `overrides` 下，而 Web 客户端只渲染 Bundle 插入的条目，因此打开这张卡片会显示“这个插件包不包含任何组件。”。控制这三个条目的开关在 Official 分组列表行上。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
