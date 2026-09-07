# Agent Note: Web UI 权限预设与审批应答

Status: implemented
Archived: 2026-09-04

[English](2026-07-23-web-permission-and-approval.md) | 中文

## 问题

Web 承载层启动的是一个不受限的 agent（智能体）：`bootHost` 组合了 `dsh-bash-local` 与 `dsh-fs-local`，因此每个 Web 会话都以完整文件访问权限运行，既无审批通道，也无权限管控——而 ACP 组合早在数月前就已交付完整的沙箱化产品路径（沙箱提供方 + 策略归属 + 受限的 shell/fs + 审批 + 预设）。Web 协议约定其实早已预留了对应位置——`approval/requested`/`approval/resolved` 的 mux 帧、携带 `ApprovalResponsePayload` 的 `POST /api/respond`、client 侧的 `pendingBuffers`——但 host 的 `respond` 只是一个 stub，没有应答者把 `ctx.approval` 桥接到流上，没有 RPC 暴露权限选择，PendingCard 把审批渲染成可见却无法应答的样子。

## 决策

Web 承载层组合与 acp-agent 相同的沙箱化产品路径：`dsh-sandbox-local`、`dsh-sandbox-policy`、`dsh-bash-sandbox`、`dsh-fs-sandbox`、`dsh-user-approval` 与 `dsh-permission-presets`，由 `BootHostOptions.sandbox` 提供部署默认值（`mode`，默认 `workspace-write`；`approvalPolicy`，默认 `ask`）。

`createApiProxy` 拥有审批 pending 注册表。它的 `approval/request` waterfall（瀑布式事件）应答者从会话刚追加的 `approval/asked` 审计事件中读取审批 id（没有审计事件的 ask 属于外部通道，予以委托），为每个问题 mint 一个稳定的 rpcId，向每个打开的 mux 流广播可应答的 `approval/requested` 帧，并在每次 mux 打开时原样重放仍处于 pending 的帧——这正是约定早已承诺的刷新恢复基线。`respond` 按回显的 rpcId 路由，用既有的 zod schema 校验 `ApprovalResponsePayload`，将载荷的审计关联与所路由的条目交叉核对，解析应答者，并广播 `approval/resolved`；ask 的中断信号会以 `cancelled` 撤回该问题。

权限选择依托两个新的一元 RPC，`session.permissions` 与 `session.setPermission`，把 `ctx.permissionPresets` 投影为一个由协议拥有的 `PermissionOption` DTO（沿用 ACP bridge 的先例：每个协议拥有自己的呈现形状）。无权限的组合提供空的选择项，client 隐藏该控件。空闲期的切换以后写胜出（last-write-wins）的方式保存在 proxy 侧的 pending map 中，并在 `agent/pre-step` 时冲刷，因为旋钮事件必须保持轮次内闭合以支持持久回放；共享的 `hasOpenTurn` 折叠迁入 `dsh-session`，取代了 `dsh-user-approval`、ACP bridge 与 proxy 中各自的私有副本。

在 client 侧，`Session` 新增了 `permissions` 与 `setPermission`，审批应答则依托运行时的 `PendingWait` 载体。按照设计师草稿，处于 pending 的审批会接管 composer：`ApprovalPanel` 注册为由会话声明的 `conversation.composer` 链中一个按选择器路由的条目（即 ui-user-questions 模式），以理由标题、配对的命令与一次性的拒绝／允许按钮取代 InputBar；ui-conversation 约定中的 `PendingApproval` 领域面拥有 `ApprovalResponsePayload` 在该载体上的协议编码（wire encoding），广播的 resolved 帧使该等待落定并恢复 composer。pending 问题通过 ui-user-questions 接管 composer，包括 `plan-review` 决策形状。侧边栏用一枚优先级高于运行中圆环的琥珀色警示圆点，同步呈现每个被阻塞的交互，搜索期间也不例外：manager 跟踪每个会话的审批与问题请求标识，而非读取 Session 实例；它只把满足 plan-review composer 二元呈现约束的请求分类为计划审查，并在问题与审批并发时优先呈现第一个 pending 问题，以匹配 composer 路由。实例化前的缓冲会保留每个仍有效的请求标识，替换回放产生的重复项，并移除已解决的请求，因此侧边栏状态绝不会比可应答的 `PendingWait` 存续得更久；跟踪以连接代次为单位清除，以保证重开后的回放才是权威依据。从未实例化过的会话仍会点亮该圆点。composer 底行的 chip 经会话注入面挂载 `PermissionSelect` 控件。连接 fixture（测试前置数据）与 host 保持一致：它的常驻审批可应答一次，其权限选择项按会话持久保存。

## 曾考虑的替代方案

**在 Web 协议上复用 ACP 的 `session/set_config_option` 形状。** 不予采纳：Web 约定的一元方法注册表（`RpcMethodMap` + 逐方法的 zod schema）是它自成一体的方言；一个通用的 config-option 接口会为一个选择项绕开编译期锁定的 schema 表。一对专用方法让两侧都能从签名推导得出。

**用一个会话事件承载 pending 交互，而非实时注册表。** 不予采纳：可应答请求是瞬态的交互状态，而非持久的会话数据——审批的 `approval/asked`/`decided` 审计对已经记录了持久的那一半。持久化 requested 帧会在回放时重新问出已经作废的问题。

**仅在存在 mux 订阅者时才注册应答者。** 不予采纳：pending 条目必须在 client 断连后依然存活（刷新恢复正是要点所在），因此注册表的生命周期长于任何单个流；一个受订阅者门控的应答者，会让在重载窗口期间关闭的 ask 落空。

**点击即乐观移除卡片。** 不予采纳：广播的 resolved 帧才是真相；点击即移除会隐藏一个因拒绝回执或传输失败而仍然悬置的问题。面板改为在本地禁用其按钮，并在失败时重新启用。

## 后果

Web 会话从受限状态启动（默认 `workspace-write` + `ask`），sandbox 拒绝升级会通过审批通道抵达浏览器。部署方可以通过 `BootHostOptions.sandbox` 放宽或收紧默认值，无需触动装配。问题应答使用同一注册表模式（ui-user-questions 基于问题 pending 表），Session 导航会在用户打开会话前识别审批、计划审阅与普通问题等待。权限选择在每次挂载时读取一次；来自另一个 client 切换的实时刷新暂缓实现。覆盖包括 proxy 注册表与权限 RPC 单元测试套件、会话对象与 fixture 单元测试套件，以及针对审批应答与 preset 切换的无密钥 Web 冒烟测试。
