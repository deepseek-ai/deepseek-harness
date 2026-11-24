---
description: "将飞书/Lark 聊天接入所有已接纳聊天共享的持久化 agent 会话，并提供聊天斜杠命令。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-im-bundle

[English](README.md) | 中文

## 概述

在已有的 profile（如 `web`）中加入实验性的 IM 自动化。本组合包插入 Satori IM 核心、飞书/Lark 与 QQ 适配器、IM 宿主（`@deepseek-ai/dsh-im`）以及斜杠命令等 Host 条目。运维人员通过 profile 补丁配置准入聊天、发送者白名单、写权限与共享会话的模型路由。运行需要飞书应用与本地持久化存储；QQ 适配器已内置但默认关闭。安装包不随附本组合包，需显式安装。

## 目录

- [使用方式](#use-this-package)
- [实现机制](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用方式

使用 `dsh plugin --profile web add @deepseek-ai/dsh-im-bundle` 把本组合包安装到常驻运行的 profile 中。IM 条目随该 profile 的进程运行，并随之停止。

### 配置部署

创建具备机器人能力的飞书应用，启用长连接（WebSocket）事件接收，并订阅 `im.message.receive_v1` 事件。为应用开通读取与发送消息、上传与下载媒体资源、创建与更新消息卡片的权限，发布应用版本并将机器人拉入目标群聊。

请为每个部署使用独立的飞书应用，并保持单个活动消费进程。飞书[将每个事件投递给单个已连接客户端](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case.md)，多个进程共用同一套应用凭据会导致消息被分流。

在进程环境变量中提供 `DSH_FEISHU_APP_ID` 和 `DSH_FEISHU_APP_SECRET`，并编写如下 profile 补丁，填入实际的机器人 id、聊天 id、发送者白名单、模型路由和绝对工作目录路径。`im` 条目定义消息接纳规则（`sources`）与共享会话（`defaultDispatch`）：每条被接纳且提及机器人的消息都会进入同一个服务所有已接纳聊天的会话。省略 `chats` 会接纳所有发往该机器人的聊天；此时应严格限制 `users`。设置 `writable: false` 可将聊天设为只读。默认配置下 `sources` 为空且未设置 `defaultDispatch`，任何消息都不会到达 agent。

```yaml
- id: im
  config:
    sources:
      - id: team
        bot: lark:cli_example
        chats: [oc_example]
        users: [ou_operator]
        writable: true
    defaultDispatch:
      agentPreset: standard
      provider: deepseek-official
      model: deepseek-flash
      cwd: /absolute/workspace
```

飞书适配器条目（`im-feishu`）配置连接参数与租户权限。出站消息会自动根据内容在 `card` 和 `post` 模式中选择降级代价最低的模式（代价相同时优先使用 `card`）。`cardStreaming: true` 在状态流式发布时原地编辑同一条卡片消息（设为 `false` 则缓冲状态、结束时只发送一次 `PATCH`，流式消息改用 `post` 模式）；`callbacks: true` 接收 `card.action.trigger` 卡片按钮回调（如停止按钮）；`allowAtAll` 不设置即已声明 `@所有人` 提及，只有显式设为 `false` 时才降级为文本（用于禁止 @所有人 的租户）。国际版 Lark 可设置 `platform: lark`。

```yaml
- id: im-feishu
  config:
    platform: feishu
    appId: !!js process.env.DSH_FEISHU_APP_ID
    appSecret: !!js process.env.DSH_FEISHU_APP_SECRET
    cardStreaming: true
    callbacks: true
```

QQ 适配器条目（`im-qq`）默认关闭。如需启用 QQ，请设置环境变量 `DSH_QQ_APP_ID` 与 `DSH_QQ_APP_SECRET`，将 `im-qq` 设为 `disabled: false`，并在 `im` 中添加对应的 `qq:<appId>` 接纳来源。

把这些条目写入该 profile 自己的 `cordis.patch.yml`，或通过 `--patch` 传入。重启时请保持 `$DSH_HOME` 目录不变，使会话日志与 `im_*` 存储域能够一致恢复。共享会话沿用该 profile 的沙箱与审批策略；审批请求由该 profile 自身的审批界面处理。

每条投递到共享会话的消息都附带标明来源聊天的 `<im-chat key="…" />` 头部，会话通过 `im_reply` 或 `im_send` 在该聊天中作答。会话不会发布其他内容：由于没有挂载轮次渲染器，只有 agent 调用 `im_send`、`im_reply` 或 `im_send_file` 时用户才会看到回答。默认的 `delivery: steer` 会将轮次运行期间收到的新消息在下一步注入当前轮次，`followup` 会排队启动新轮次，`inject` 仅添加上下文而不唤醒空闲会话。聊天成员可发送 `/stop` 停止当前轮次，在共享会话的 home 聊天中发送 `/clear` 或 `/new` 重置会话上下文，发送 `/status` 查看会话状态，发送 `/help` 列出可用命令，发送 `/compact` 压缩会话历史（均由 [`session-commands`](../im-session-commands/README.zh.md) 处理）。

`im` 条目激活时，会将待恢复投递与新消息派发一并暂缓至 Loader 组装稳定，确保 `im_*` 工具与 `im-session-commands` 先完成挂载。释放该 profile 时会依次关闭适配器连接、活动 agent 与存储域。

-----

<a id="understand-the-implementation"></a>
## 实现机制

<details>
<summary>实现细节——点击展开</summary>

[组合包补丁](cordis.patch.yml) 插入 HTTP（`im-http`）、Satori 核心（`im-core`）、把回答所用的 `<markdown>` 元素渲染成各平台原生标记的插件（`im-markdown`）、飞书适配器（`im-feishu`）、QQ 适配器（`im-qq`，默认禁用）、IM 宿主（`im`）以及斜杠命令（`im-session-commands`）。`im-http` 与各 IM 条目通过 `isolate: { http: im }` 隔离 `http` 服务，避免与 profile 上的其他 `http` 服务冲突。两个适配器条目均声明 `inject: [im]`，确保在 `ctx.im` 激活前不会建立平台连接或确认事件。它不声明应用入口，也不覆盖 profile 中的任何条目。由于 `dsh-im` 在全局挂载了 `im_*` 工具，共享会话使用的预设无需声明额外插件条目。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [IM 宿主服务](../im/README.zh.md) — 接纳规则、托管会话、默认分派会话与 `im_*` 工具。
- [IM 子系统](../../../docs/subsystems/im.zh.md) — 公开类型、存储域与 Cordis API 目录。
- [实验性包组](../README.zh.md) — 实验性状态说明与其他实验性包。
- [系统架构](../../../docs/architecture.zh.md) — profile 组装与 agent 生命周期。

-----

<a id="model-experience"></a>
## 模型体验

间接通过 [IM 服务](../../../docs/subsystems/im.zh.md) 及其挂载的 `im_*` 工具影响模型。

#### KV Cache 影响

组合包本身不增加文本，请求内容与前缀复用由挂载的服务和预设负责。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

本组合包当前存在以下限制：

- **需要手动配置** — 本组合包没有插件页入口或配置表单：凭据来自环境变量，接纳来源来自 profile 补丁。
- **仅支持 WebSocket 长连接** — 不包含入站 Webhook 服务器或历史消息自动回填。
- **QQ 适配器默认关闭** — 启用 `im-qq` 需要配置 QQ 机器人凭据与网关事件权限，且每个 QQ 应用同一时间只能运行一个网关连接会话。
- **单进程独占存储** — 每个 `$DSH_HOME` 及其 IM 存储域同一时间只能由单个进程读写。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作记录——点击展开</summary>

无。

</details>
