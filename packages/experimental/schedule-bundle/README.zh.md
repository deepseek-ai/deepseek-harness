---
description: "从插件管理页加入定时服务、提醒目录与自动化任务页面。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-schedule-bundle

[English](README.md) | 中文

## 概述

此可选 Bundle 插入随发行版交付的 Web 组合所不含的三个定时条目：`time-context`、`schedule` 与 `ui-schedule`。随包配置默认禁用。

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

打开 Web 侧栏的插件管理页并启用带闹钟图标的“自动化任务”。此后，活跃的根智能体获得 `schedule_create`、`schedule_list`、`schedule_update` 与 `schedule_delete`，会话头部显示提醒目录，侧栏的自动化任务入口打开任务管理页面、右侧栏承载所选任务的详情，每个符合条件的步骤追加一条时钟读数，包含当前时间、打开请求所带的浏览器时区，以及距上一条模型可见消息的经过时间。此 Bundle 的页面列出时间感知、任务调度与任务界面及其状态。禁用此 Bundle 会恢复随包组合；已存储的任务保留在磁盘上。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`cordis.patch.yml` 插入这三个条目，`package.json` 依赖它们的包，使每个条目都从此 Bundle 解析。`packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES` 列出此包，`apps/cli` 依赖它，因此每次安装都随包携带且默认禁用，插件管理页在“官方”分组中提供它。选中后会把该 Bundle 追加到 profile 的 `dsh.profile.bundles` 列表。此纯配置包不拥有可变的运行时状态，因此不发布不变量伴随模块。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 插入 `time-context`、`schedule` 与 `ui-schedule` 三个条目 |
| [`package.json`](package.json) | 以依赖声明这些条目的包 |
| [`locale/en.json`](locale/en.json)、[`locale/zh.json`](locale/zh.json) | 插件管理页的标题与描述 |
| [`icon.svg`](icon.svg) | 插件管理页图标 |
| [`src/index.ts`](src/index.ts) | 空的模块入口；补丁即运行时内容 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [定时子系统](../../../docs/subsystems/schedule.zh.md) — 持久任务、发生时刻解析与投递。
- [定时服务](../../schedule/schedule/README.zh.md) — Host 任务存储、激活与记录格式。
- [Web Bundle](../../bundle/web-app/README.zh.md) — 此 Bundle 向其加入这些条目的组合。

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

- 此 Bundle 打开时，其页面像其他所有 Bundle 一样为每个条目提供开关。这三个条目只能一起工作：关掉 `schedule` 会让任务页面失去服务，关掉 `time-context` 会让模型在创建新提醒时拿不到当前时间。
- 未选中此 Bundle 时，按 id 定位 `time-context`、`schedule` 或 `ui-schedule` 的 profile 补丁或 `--patch` overlay 匹配不到任何条目：加载器为每条这样的补丁报告一条 `patch: entry <id> not found` 警告。请选中此 Bundle，而不是按 id 打开这些条目。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
