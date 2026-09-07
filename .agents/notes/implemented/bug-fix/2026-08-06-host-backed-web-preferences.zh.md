# Agent Note: 通过 Host settings 持久化 Web 用户偏好

Status: implemented

[English](2026-08-06-host-backed-web-preferences.md) | 中文

## 问题

Web 的 Appearance、Language 和繁忙态 Enter 偏好原本存在浏览器 `localStorage` 中。浏览器存储以 origin 为作用域，因此换一个端口重新打开 `dsh web` 会选中另一个存储分区并丢失选择，即使两个进程使用同一个 DSH home。这些是用户级产品偏好；会话选择、草稿、折叠展开状态和其他瞬态浏览器状态仍保留在页面内。

第一版主题实现只把 Appearance 移入 Host settings，但会在提供 `ThemeRuntime` 之前等待初始 RPC。缓慢或不可用的 settings 请求因而会挂起组装后的页面。该实现还在读取后才建立订阅，可能错过此窗口内的失效通知；它写入时不携带 namespace revision，并且允许已释放插件所排队的写入到达 Host。

## 决策

各领域所属的 Host half 注册三份 schema：可选的 `locale.preference`（`zh` 或 `en`，缺失时交由浏览器决定）、`ui-theme.preference`（`light`、`dark` 或 `system`，默认为 `system`），以及 `ui-conversation.busyEnter`（`queue` 或 `steer`，默认为 `queue`）。本地 settings 提供方将显式选择存入 `$DSH_HOME/settings.yaml`，在使用默认 home 时，该路径解析为 `~/.dsh/settings.yaml`。API 代理在 Connection 浏览器认证之后服务每一个已注册的 namespace；字段角色仍会脱敏机密值。

`dsh-client-ui-settings` 持有一个浏览器全局的 settings describe 镜像，并提供 `ctx.settingsScope.bind(spec)` 作为该镜像上的逐 namespace selector。镜像在开始后台读取之前安装 `settings/document-updated` 和 `connection/reset` 监听器，因此任何 settings 传输都不会阻塞插件激活，失效通知也不会掉入先读取、后订阅的空档。每个绑定的 scope 会发布一个供领域服务订阅的快照 store（状态、分节值、revision、可写性、host／内存模式），自身不再增加协议读取或监听器。默认解码器会对照该 namespace 自身的序列化 wire schema（经同包的 `ctx.settingsSchema` 服务还原）校验每个传入分节，因此各领域无需携带手写的 wire 校验器。领域服务把 scope 当作普通的构造函数协作者接收，立即发布各自的暂定默认值：由浏览器派生的 locale、系统主题和 Queue；随后采纳已获接受的 Host 分节，但不将其写回；不带 scope 构造的服务——独立词典或政策 fixture（测试前置数据）——则仅停留在进程本地。共享读取与失效生命周期由后续的 [settings describe 镜像决策](../../archived/architecture/2026-08-17-settings-describe-mirror.md)规定。

用户变更会同步更新实时服务，并经 `scope.set` 将一项 `settings.mutate` 路径操作排入队列。scope 会串行处理手势，以最新已知 namespace revision 作为 `expectedRevision` 发送，记录每次成功写入的 revision，并且只允许最新写入的结算结果重新发布实时状态。最新写入被拒或失败时，scope 会重新加载 Host 状态。插件释放会拒绝新工作、跳过已排队操作、抑制运行中操作发布状态，并等待该操作结算后才让插件达到完全停稳。

Client 在非 loopback 页面禁用 Host 持久化，因此这些页面的偏好仍只保留在进程内，尽管 Connection 认证完整 API。动态第三方主题 id 仍是内置 Host schema 之外的进程内扩展；移除其中一个会重置实时注册表，但不会替换上一个持久化的内置偏好。

## 曾考虑的替代方案

**保留 `localStorage`，并在不同端口间复制值。** 一个 origin 无法枚举另一个 origin 的存储，而 Host 中继会围绕浏览器特有格式重新实现一套 settings 服务。

**将 Host settings 镜像到 `localStorage`。** 第二个权威来源会要求另外定义启动与失效时的冲突规则，同时依然保留造成该缺陷的分区。Host settings 文档是唯一的持久化真源。

**等待初始读取，以避免暂定渲染。** 绘制页面不以配置可用为前置条件。后台读取可能引发一次实时收敛，但它会隔离失败，并保留既有的浏览器／系统／默认回落路径。

**让每个领域拥有自己的 settings 控制器。** 并发、revision、失败、失效与释放规则完全一致；此前的主题实现已因复制这些规则产生生命周期漂移。由领域持有 schema，可以避免把产品政策放入共享运行时。

**带成对 sync/persist 回调的逐字段偏好控制器。** 第一版共享生命周期经领域提供的 `sync` 回调同步单个标量字段，服务则经注入的 `persist` 回调写回。这对相互依赖的回调迫使构造分两阶段完成——写入器先默认为无操作，稍后经 `bindPersistence` 替换——namespace 每新增一个字段，本都得再携带一个自己的控制器和一次全文档读取，且每个领域都重新声明了一个已注册 wire schema 本已表达的手写校验器。namespace scope 发布一份供服务订阅的快照并直接接受写入，因此这对回调与第二个构造阶段都不存在。

**把每个 `localStorage` 条目都移入 settings。** 当前会话、草稿、面板展开状态、trajectory 显示状态和类似条目属于浏览器实例状态，而非用户配置。将它们提升为设置，会在没有产品契约的情况下，跨标签页和端口同步短暂导航状态。

## 后果

Appearance、Language 和繁忙态 Enter 选择会跟随 DSH 用户 home，跨越重新加载、端口与回环 origin。直接编辑 `settings.yaml` 所产生的变更会通过现有失效流收敛，而旧的 `dsh.theme`、`dsh.locale` 和 `dsh.conversation.busyEnter` 条目既不会被读取，也不会被写入。

启动时可能会在后台读取结算前短暂显示领域默认值。短暂的读取失败会保留该默认值或上一个正确的进程内值；重连时会重试。写入被拒时，界面可能会在本地值立即变化后明显恢复为持久化偏好。

聚焦的单元测试覆盖 schema 注册、先监听后读取的顺序、非阻塞激活、经 schema 校验的分节接受、携带 revision 的有序写入、陈旧响应隔离、故障恢复、释放时完全停稳，以及远程端仅内存模式。以 namespace 为粒度的 scope 也承载多字段分节，因此后续的配置表面可以沿用同一份生命周期，而不必手搭 describe/mutate 同步。无密钥 Web settings 场景通过 UI 写入全部三项偏好，校验 YAML 文档并确认旧 `localStorage` 为空，重新加载，再使用同一个 DSH home 在不同端口上启动另一个 Host。
