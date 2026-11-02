---
description: "通过独立的 Liveshare 服务端分享 DSH 会话，提供已验证的所有者登录、查看者控制和受限执行。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-liveshare

[English](README.md) | 中文

## 概述

通过常规 DSH 浏览器界面向同事分享会话。所有者选择查看或受限写入，并单独决定是否允许分叉会话；所有者主机执行这些选择。附件上传属于分享本身：查看者可见的会话都可以接收文件。这个可选组合包增加所有者登录、分享控件、出站网关，以及所有者自身 Web 页面中的查看页界面。默认 Web profile 不包含它。单独部署的 Liveshare 服务端验证查看者并传输请求；其 OAuth、数据库、路由和部署实现不属于本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### Profile 与构建要求

manifest（元数据清单）声明可安装的 `dsh.bundle` 层和浏览器端入口。该组合包在被 profile 启用前保持隐藏，见[默认可见性与启用](#default-visibility-and-enabling)；受支持的应用仍通过 `dsh --profile` 启动。

Owner、查看页和 Liveshare 服务端必须使用匹配的协议版本。构建包含 Owner 网关进程；查看页没有单独的构建。包版本、导出和发布内容由 [package.json](package.json) 声明。

<a id="default-visibility-and-enabling"></a>

### 默认可见性与启用

dsh 安装会把本包作为运行时依赖一起安装，但没有任何随发行版交付的 profile 选中它的组合包，因此它的插件一条都不会运行，插件管理器既不会在**内置插件配置**里列出它，也不会在**实验性插件**（含**更多**页）里列出。组合包 ID 仍可按 ID 打开，因此按 ID 打开组合包的页面仍能到达它的详情。

要启用它，把它的两条条目插入当前 profile 的 patch 文件 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。该文件是一个 YAML 序列的 Loader patch；这两条就是组合包自己的 [patch](cordis.patch.yml) 插入的条目，其中允许使用 `!!js` 表达式：

```yaml
- insert:
    - id: liveshare-viewer-declarations
      name: '@deepseek-ai/dsh-experimental-liveshare/viewer-declarations'
    - id: liveshare-share-host
      name: '@deepseek-ai/dsh-experimental-liveshare'
      config:
        ownerIdentityProvider: <provider-id>
        ownerIdentityTenant: <tenant-id>
        ownerIdentitySubject: <subject-id>
        allowedSubjectIds: []
        ownerStateFile: /path/to/owner-shares.json
```

把每个 `<...>` 占位符换成部署自己的值：身份 provider、tenant 与 subject 是该部署的 Liveshare 服务端配置使用的值，示例中的都是占位符而非真实身份。环境层同样可用：在 `$DSH_HOME/.env` 里设置 `LIVESHARE_*`，并保留组合包自己的 `!!js process.env.…` 表达式。Liveshare 服务端地址不属于这里的配置：首次使用时由所有者在分享弹窗里填写，见下文的所有者配置。

profile 也可以改为选中组合包：在 `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里加入 `"@deepseek-ai/dsh-experimental-liveshare"`；卡片可见后，卡片上的开关执行的就是这次写入。

两条路线都只在重新组合时生效。profile 的 HMR 行开启时，改动在 profile 被重新读取后应用；没有 HMR 时，等下一次 `dsh` 启动才应用。只要组合包声明的行有一条在运行，它的卡片就会出现在**实验性插件**下，也出现在**更多**页。删除这些条目、把它们置为 disabled，或把组合包从 `dsh.profile.bundles` 移除，都会停止这些行，卡片也随之从两个列表消失。

### 所有者配置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `LIVESHARE_OWNER_PROVIDER_ID` / `LIVESHARE_OWNER_TENANT_ID` / `LIVESHARE_OWNER_SUBJECT_ID` | 未设置 | 用于旧主体匹配的所有者身份；不替代 Liveshare 服务端签发的凭据 |
| `LIVESHARE_OWNER_DISPLAY_NAME` | 未设置 | 配置身份的显示标签 |
| `LIVESHARE_ALLOWED_SUBJECTS` | 空 | 分享访问规则之外的部署级主体允许列表 |
| `LIVESHARE_OWNER_STATE_FILE` | `$DSH_HOME/liveshare/owner-shares.json` | 保存分享元数据、已保存的 Liveshare 服务端地址、实例身份和管理 token |
| `LIVESHARE_OWNER_CREDENTIAL_FILE` | 状态文件旁的 `owner-credential.json` | 保存绑定至签发它的 Liveshare 服务端的凭据 |

Liveshare 服务端地址在首次使用时设置：在分享弹窗的地址输入框里填写并保存。保存的地址持久化在 owner state 文件中，之后创建的分享都发布到该地址；已经等待注册的发布在注册信息、持久记录和返回链接中保留起始服务端地址，已有分享保留记录中的 Liveshare 服务端地址。经分享管理 Remote 清除保存的地址后，这个宿主就没有地址可用——此时创建分享会明确要求先保存地址，而不是回退到某个部署默认值。读者看到的分享者名称来自 Relay 验证凭据上的显示名，本地配置不能覆盖它；凭据只带主体时显示主体标签。提供方应用密钥属于 Liveshare 服务端，不属于这里的配置。

### 登录与管理分享

分享对话框在 Owner 上创建短期授权事务。弹窗只向预期窗口、来源和事务返回一次性代码。Owner 使用私有校验值兑换代码并保存绑定该 Liveshare 服务端的凭据；正常浏览器登录流程不会把该凭据存入浏览器存储或 URL。过期、取消、重放或不匹配的事务均拒绝。代码兑换期间更改 Liveshare 服务端，包括切换后再切回，会在保存凭据前拒绝登录。存储提交后，探测和分享认领保留该操作的 Liveshare 服务端与凭据身份。未验证身份时禁止发布，Liveshare 服务端不支持身份绑定时也一样。

分享管理本身走 `liveshareShares` Typert Remote：分享列表、创建、停止、档位与分叉开关变更、端点选择、Liveshare 服务端状态、所有者身份、Liveshare 服务端保存的审计以及两项服务端检查都是挂载命名空间上的方法。登录往返与凭据保存是所有者页面仍然调用的仅有的同源 HTTP 路由。

所有者通过组织链接接纳查看者；部署的 `LIVESHARE_ALLOWED_SUBJECTS` 作用于每份分享，把组织链接分享的准入收窄到它列出的主体。已存储的 `selected` 或 `approval` 分享保留原有 ACL 与访问摘要，弹窗不再创建这类分享；`liveshareShares.create` 的 `accessMode` 与 `allowedSubjectIds` 只保留给这些记录与直接 Remote 调用方。管理分享页面列出保存的链接、档位、可用状态及 Liveshare 服务端的审计响应，并可修改分享档位、开关「允许分叉会话」以及停止分享。失败操作显示错误；界面重新读取 Owner 响应，不把点击本身当作成功。分享弹窗也能修改已有分享：档位、分叉开关与插件端点在弹窗里选择，由滚动区之外的一次保存一并提交，并在保存后回读 Owner 的记录；未保存的选择会明确标出，关闭前先提示它们会被丢弃。

### 会话档位

| 档位 | 查看者操作 | 执行限制 |
|---|---|---|
| `view` | 向源会话发送提示词，并停止其正在运行的轮次 | 挂在会话上的只读沙箱，只约束分享查看者发起的轮次：该轮次只能使用读取与检索面（`read`、`read_image`、`glob`、`grep`、`present`）、无本地文件副作用的工具（`todo_write`、`skill`、`web_search`、`web_fetch`）；每次调用声明的每个路径都按获授工作区检查 |
| `write` | 还可修改该工作区内的文件 | 有上限的可写沙箱：读取与检索面加上有界 `edit` 与 `write`，同样作用于查看者发起的轮次 |

两档都会驱动共享会话，区别在于能否写入。沙箱挂在会话上，只要该会话还有分享活跃就会安装，但它只约束分享查看者发起的轮次：所有者自己发起的轮次保留会话原生工具，包括 `bash` 与不受限的文件工具；所有者在查看者轮次中追加的输入仍留在该受限轮次内。该判定只存在于 Host 内存、按轮次重算，不写入会话日志；所有分享停止或全部过期后执行层被释放，会话恢复自己的工具。分叉会话不是一个档位：分享自带独立开关，与档位无关；被允许的查看者可从已完成的源前缀分叉出会话，分叉会话运行在只读上限下；分享处于 `write` 档时改为受约束的写上限。

附件上传既不是档位，也不属于分叉开关：它跟随可见性。无论分享处于哪个档位、是否允许分叉，已准入的查看者都可以向共享会话以及自己通过本分享分叉出的会话上传附件。所有者没有单独的附件开关。

任何档位都不授予会话配置、重命名、归档、工作区管理或所有者全局设置与凭据权限；附件上传跟随可见性，不是档位授予。Owner Gateway 以 Remote 失败 `remote-access/denied`（reason 为 `liveshare/read-only`）拒绝查看者的 `settings/describe`、`credentials/describe`、`agentPresets/list`、`agentPresets/read` 以及分享未授予的其它端点；配置值、凭据引用元信息及 preset 插件配置不属于查看者数据。查看者保留本地展示默认值。这些管理决定与向会话发送消息的权限保持独立。**临时机制**：拥有本页所需端点的插件通过 [`viewerDeclarationsOf(ctx)`](src/host/viewer-declarations.ts) 提供能力——不改动任何状态的端点用 `registerViewerReadable(actions)`，会写入的端点用 `registerViewerWritable(actions)`——直到 Typert 元数据中的端点级访问声明取代这一接口。**提供能力本身不授予任何权限**：owner 按分享逐个开放某插件的端点，只有该插件的当前能力与这份分享自己的选择都指明同一端点、且资源在读者可见范围内时，该分享才暴露它。可写的选择沿用分享自身的写入规则，因此**只在会话本身已允许写入、且源执行已 confine 的分享中生效，任何能力与选择都不会把只读分享变成可写**；两种选择都把这个 policy 已经判定的 action——`session/prompt`、`session/cancel`、`session/fork` 及其 role 列出的其余 action——留给档位自己的结论。所有者自己的页面以所有者访问基线打开，界面保持不变。

Owner Gateway 按调用指明的 Session 与工作区判定每次调用，并拒绝目标缺失或无效的调用。查看页的会话列表和工作区成员裁剪为源会话及该查看者自己的分叉会话。页面从读者的访问快照读取每个会话自己的答案，因此切换选择不会把前一会话的权限带过去。未知或无法读取的模式默认拒绝。Owner 为源会话与分叉会话调用重新检查准入；撤权会取消受影响的调用和流，分享准入收窄时还会停止共享会话正在运行的轮次。页面区分认证、访问、过期、停止分享、所有者离线和传输失败，仅重试明确分类为可重试的失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

查看页就是 Owner 自己的 Web shell。Liveshare 服务端通过 `asset` 读取取得 Owner 渲染好的 index 文档，并把 [viewer-carrier.ts](../liveshare-protocol/src/viewer-carrier.ts) 生成的载体脚本放在文档最前面。Shell 资源、客户端插件 bundle，以及 index 相对文档基准引用的三个确切顶层文件（`manifest.webmanifest`、`favicon.svg`、`favicon-dark.svg`）都经同一读取取得，来自 Owner 的前端读取服务和客户端模块注册表，因此页面以 Owner 的版本运行 Owner 的全部插件。任何 asset 路径上的 source map 都被拒绝，且该判定是权威的：经 Liveshare 服务端转发的 `asset` 读取会原样到达这里，因此 Liveshare 服务端侧的同名规则只覆盖它自己的页面资源路由；被服务的文档还会去掉自己的 manifest 链接，否则浏览器会不带凭据地抓取它。载体把 Connection 调用和 Gateway 流转换为 `POST {base}/__share/rpc` 请求，并把 Liveshare 服务端无法作答的只读页面源 Owner 路由（`/open-in-app/apps` 与 `/api/present.host`）也经该通道转发，而不是留给 Liveshare 服务端尾部。Liveshare 服务端在不透明请求体之外提供已认证主体。Owner 读取处理器把每位读者的调用和流以「每个分享、每位读者一个 Peer」分派进自己的 Connection 与 Gateway，该 Peer 的 `share-viewer` principal 携带分享与服务端断言的身份。Gateway 依据本包注册的 `share-viewer` 策略，经 [`dsh-api-remote-access`](../../api/remote-access/README.zh.md) 判定该 Peer 的调用以及转发给它的会话通知：受服务的读者持有共享会话、其自己的 fork 及包含它们的工作区上的读取角色，持有条件按分享档位与其自身 fork 开关判定的 fork 与写入角色，此外别无授权；附件上传随读取角色生效。读取处理器保留分享生命周期拒绝、Liveshare 服务端授权刷新、冷会话准备和 fork 编排，在准备或分派提示词与停止之前读取策略的写入规则，并在授权结束、分享停止或过期、或复检拒绝时释放读者的 Peer。读者索取页面或打开流时也会开始准备该分享的源会话，因此宿主重启时该会话的 agent 尚未存活也能补上驱动所需的层；无法被 confine 的分享会如实说明该状态，而不再声明只读。存在载体写入的 `__DSH_LIVESHARE_VIEWER__` 全局变量时，本包的浏览器端挂载查看页界面，否则挂载分享操作。读者收到的 index 把读者自己的访问快照赋给每个 index 设为所有者基线的同一全局变量，页面随后跟随读者的 `remoteAccess/follow` 快照；CSS 隐藏不构成授权。

Fork 请求绑定主体、分享、源会话、操作身份和已完成前缀。持久化预留记录与已记录的分叉会话使重试已记录的操作时重放同一分叉会话；owner 的 `SessionForkRequest` 自己生成分叉会话 id，因此在分叉会话已创建、但尚未记录时中断的请求会再次 fork。注册表变更为异步操作，仅在加锁的读取、修改与原子发布后完成；调用方必须等待预留、记录与撤销。冷态激活使用 Host 常规 Agent lookup，由串行 `agent/created` 在排队输入运行前安装限制，不使用 Remote `session/prepare` 端点。分叉会话作用域保留单个默认拒绝的 guard；重连替换其限制安装，释放旧安装不会移除继任。

读者的提示词以 `user-rpc` 消息进入会话，其 `source.principal` 指明该读者；pre-step 在每条进入消息到达模型前，按 Relay 的准入重新检查其查看者。执行按轮次受限：只要有分享处于活跃状态，已准入输入中带有 share-viewer principal 的轮次就运行 Host 挂载的读取与检索面（`read`、`read_image`、`glob`、`grep`、`present`）受限替代、无本地文件副作用工具（`todo_write`、`skill`、`web_search`、`web_fetch`）的替代，以及（当某个分享允许写入时）有界 `edit` 与 `write`。其余所有工具对该轮次一律拒绝，且每次允许的调用声明的每个路径都会解析并按获授根目录检查。所有者自己发起的轮次保留会话原生工具，直到最后一个分享停止或过期。该轮次判定只存在于 Host 内存，按轮次重算，不写入会话日志。每次操作都会重新读取分享当前的 Relay 授权，并按获授根目录检查解析后的目标。读者的停止与提示词一样经 Gateway 分派：`share-viewer` 策略在分享档位确立且会话受沙箱限制时放行，随后由所有者自己的会话控制器停止该会话当前运行的轮次，包括所有者发起的轮次。读写保留正常写入观察策略。执行规则见 [LiveShare 子系统](../../../docs/subsystems/liveshare.zh.md)。

| 职责 | 源码 |
|---|---|
| 登录、凭据存储及网关生命周期 | [share-host.ts](src/host/share-host.ts) |
| 分享管理操作及其 `liveshareShares` Remote | [share-operations.ts](src/host/share-operations.ts), [share-remote.ts](src/host/share-remote.ts) |
| 查看请求分派、读者 Peer 与访问策略 | [viewer-read.ts](src/host/viewer-read.ts)、[viewer-principal.ts](src/host/viewer-principal.ts)、[viewer-access-policy.ts](src/host/viewer-access-policy.ts)、[viewer-declarations.ts](src/host/viewer-declarations.ts)、[source-access.ts](src/host/source-access.ts) |
| Fork 记录与运行时限制 | [fork-registry.ts](src/host/fork-registry.ts)、[fork-enforcement.ts](src/host/fork-enforcement.ts)、[shared-tools.ts](src/host/shared-tools.ts) |
| 页面载体、查看页界面和页面资源读取 | [viewer-carrier.ts](../liveshare-protocol/src/viewer-carrier.ts)、[client/index.ts](src/client/index.ts)、[viewer-session-plugin.ts](src/client/viewer-session-plugin.ts)、[viewer-assets.ts](src/host/viewer-assets.ts) |
| 共享身份和帧定义 | [协议包](../liveshare-protocol/README.zh.md) |
| 注册与 socket 范围请求关联 | [registration-url.ts](src/owner-gateway/registration-url.ts)、[pending-rpc.ts](src/owner-gateway/pending-rpc.ts) |

注册声明线路版本与可选能力。声明的版本不匹配时返回 HTTP 426；不做版本转换。IPC 请求使用绑定原始 socket 和 worker generation 的唯一 token；响应与取消匹配 token、分享 ID 和 Liveshare 服务端 ID。可关联的不支持请求会收到作用域内拒绝。

可选 `share-access-state` 帧及鉴权请求列表响应提供完整、带版本的 Liveshare 服务端授权。Host 独立保留 Owner 选择的模式，执行时使用两者中较窄的模式。所有完整请求列表读取，包括管理读取，都应用同一版本与 generation 校验；缺失授权使准入失效。首次发现撤权的请求收到 `403 viewer-not-authorized`，其它已撤权工作被取消。`share-viewer` 策略及 `agent/pre-step` 将接收 Session 绑定到分享源会话或该主体记录的分叉会话。排队外部输入在重启后仍刷新授权；已删除分享不能授权恢复的 Inbox 输入。快照字段见 [共享协议参考](../liveshare-protocol/README.zh.md)。

查看流属于打开它的主体。通知与控制投影只暴露源会话及该主体的分叉会话；交互审批与提问留在 Host。`forkLineage` 是 LiveShare 自有 UI 投影，不是授权。读者访问快照中的逐会话 grant 独立于展示谱系，决定页面是否提供提示词与停止。

外部 Liveshare 服务端的服务、存储、OAuth 提供方和部署保持独立归属。仅涉及 Owner 的测试位于本包；启动两端完整产品的测试留在上层 Liveshare 服务端集成中。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [LiveShare 子系统](../../../docs/subsystems/liveshare.zh.md)
- [Owner 决策记录](../../../.agents/notes/implemented/feature/2026-09-13-liveshare-protocol-and-owner-surfaces.zh.md)
- [Web 组合包](../../bundle/web-app/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接触达：host 把 viewer 的 prompt 驱动进共享会话，模型请求因而承载该 host 以会话普通用户输入转发的 viewer 内容。

#### KV Cache 影响

viewer 的 prompt 以普通用户输入进入共享会话，因此扩展的是与所有者自身输入相同的缓存 prompt 前缀；本组合包不增加任何请求字段、工具或系统提示文本。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Owner、查看页和 Liveshare 服务端需要匹配版本；尚未建立跨版本兼容保证。
- 所有者无法拒绝已准入查看者的附件上传：能读取某条会话的查看者也可以向它附加文件，与档位和分叉开关无关。这是已接受的风险。
- 查看者的文件操作按获授根目录做路径检查，若本地进程在检查与打开之间把获授范围内的目录换成符号链接，读写可能被改指别处；目录句柄锚定留待单独变更引入。查看者工具仅限受限的读取与检索面（`read`、`read_image`、`glob`、`grep`、`present`）、无本地文件副作用的工具（`todo_write`、`skill`、`web_search`、`web_fetch`），以及 write 档下的有界 `edit` 与 `write`；不授予 `bash`、`pwsh`、`cua`、`plugin_manager`、`schedule_*` 及该工具面未列出的任何工具。
- 查看页没有独立工作区文件编辑界面，也没有管理权限。
- 端点能力是临时机制且不经审查即被信任：注册表只校验名称形如 `<namespace>/<method>` 的 Remote 端点，因此被勾选的端点会在 policy 绑定的资源上被任意已认证分享读者调用，端点自身的 confine 是唯一限制。被勾选的可写端点在已允许写入的分享中具有破坏性。能力只覆盖 `global`、`session`、`workspace` 三种资源种类，`event:` 名称会被拒绝。
- owner 在分享面板里为每份分享选一个开放档位——不可用 / 可读 / 可写——默认不可用，统一作用于所有声明了端点的插件；分享管理里能看到每份分享已开放的端点。档位在保存时展开成插件当时声明的端点，因此记录始终是显式端点列表，插件之后新增的端点不会自动开放，直到 owner 再次保存。当前能力填不满的档位不可选：没有任何插件声明可写端点时，「可写」按不可用呈现，而不是降级成可读。一次保存按顺序写这三项（档位、分叉开关、端点）；靠后的端点写入被拒时，前面的权限写入已经生效，界面报错并保留 owner 的选择以便重试。选择是分享级的：该分享的每位已准入查看者都可以在 policy 绑定的资源上调用被选中的端点，尚未建立逐查看者端点级别。插件不再声明的端点即使留在记录里也不暴露；不是整档的记录按不可用显示并说明重新保存会覆盖它。
- 工作区不再包含读者可见的会话后，要到该工作区或工作区顺序下次变化时才离开读者的工作区订阅（[remote access 限制](../../api/remote-access/README.zh.md#known-limitations-and-deferred-work)）。
- 注册表文件锁防止并发文件写入丢失持久条目，但每个注册表读取自身内存快照。多个 Host 之间不协调 Owner 分享状态更新与网关归属；每个 home 只使用一个活动 Owner Host。这不是多宿主授权服务。
- 不发布运行时 invariant 配套模块：授权在操作本身检查，本包没有单独的 invariant 观察器。
- Worker 重启会重新注册保留分享，但不重放查看流；查看者通过传输层恢复。注册被 401、403、410 或 426 拒绝时，该分享的重连就此停止，直到有别的操作把它重新注册：重新发布或改档位都会重新注册，为该 Liveshare 服务端存入凭据也会，它会把该地址下未在线的分享重新注册。恢复分享时出示的是本机为该分享所属 Liveshare 服务端保存的凭据，与本机自己对凭据过期的判断无关，因为 Liveshare 服务端会在背后为登录续期，凭据是否仍然授权只由 Liveshare 服务端决定；新建分享时仍按本机这一判断拒绝。
- 访问档位授予 `view` 准入，有效 fork/write 权限来自分享模式。尚未建立逐查看者执行级别或立即跨实例停止／取消完成保证；取消不能撤回已提交写入。写入降为只读的快照会拒绝后续写入，但不承诺立即取消正在运行的分叉会话轮次。
- 功能达到发布条件前，仍须完成最终装配快照验证。
- 在查看页上，绕过 Connection 载体的客户端读取（交付物读取、open-in-app、PDF 资源、HMR 事件）到达的是 Liveshare 服务端而不是 Owner；index 文档中以根路径开头的 manifest 和图标链接在 Liveshare 服务端前缀下无法解析。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
