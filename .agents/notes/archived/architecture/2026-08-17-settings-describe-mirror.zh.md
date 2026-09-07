# Agent Note: Settings describe 镜像

Status: implemented
Archived: 2026-09-04

[English](2026-08-17-settings-describe-mirror.md) | 中文

## 问题

一次冷启动的 web boot 在约 200ms 内发出十五次 `settings.describe`，且每新增一个持有偏好设置的客户端插件，该计数再加二。两个机制叠加：`SettingsScopeBinder.bind()` 为每个绑定的 scope 启动一次全量文档读取（产品组合中有六个 scope，外加插件目录 tab、welcome 门与 models onboarding join），而 `onConnected` 在**首次**连接时同样发出 `connection/reset`，于是上述每个读取方都立即重读了几毫秒前刚取到的应答。每个读取方还各自持有失效订阅与各自的 `refreshIfLoaded` 式防护，且十五次独立读取原则上可能落在十五个不同的文档 revision 上。

## 决定

**一个读取方，多个派生面。**`dsh-client-ui-settings` 持有 `SettingsDescribeMirror`——浏览器中唯一的 `settings.describe` 读取方：一个持有完整应答的快照 store，由所属插件的两个订阅（`settings/document-updated`、`connection/reset`）负责刷新。并发的 `load()` 调用折叠进在飞读取加至多一次尾随重读。在飞槽位会在 loading 发布同步重入 `load()` 之前先取得 run 的所有权，随后在 run 自身 try/finally 内、与读取 rerun 标志相同的同步段中清空；若把清理挂在返回 promise 的 `.finally()` 上，它要晚一个微任务执行，落入该间隙的刷新会标记一个无人读取的 rerun。

`bind()` 返回的 `SettingsScope<T>` 面保持不变，但 controller 现在是镜像上的 selector：自身没有读路径，decode 规则不变，写队列保留。提交成功的写入把应答的 view 折回镜像（`acceptView`），兄弟 scope 无需重读即可看到新 revision；这次折叠会废弃更早发出的在飞应答，而首次完整文档尚未建立时到达的写入会让该读取重跑，不会把单个 namespace 发布成残缺文档。失败的最新写入触发一次镜像恢复读取。跨命名空间的表面——插件目录 tab、permission 行（其动态枚举位于命名空间 schema 中，而 scope 有意不携带 schema）、models join、agent-preset 行的可写性、以及 `hasDocument`——消费 `ctx.settingsScope.describe()` 提供的共享读／折叠面（`getSnapshot`／`subscribe`／`ensure`／`acceptView`）。

本决策更新了[通过 Host settings 持久化 Web 用户偏好](../bug-fix/2026-08-06-host-backed-web-preferences.zh.md)和[由插件自己拥有的设置表层](2026-08-12-plugin-owned-settings-surface.zh.md)所记录的浏览器读取与失效机制，同时保留其中关于偏好所有权与命名空间暴露的决策。它也取代了 [DeepSeek 官方首次使用凭据配置](../feature/2026-07-30-deepseek-onboarding-credential-setup.zh.md)中的设置直读描述；该联接的 settings 部分现在从本镜像派生。

冷启动预算由 `apps/web/tests/startup-rpc-budget.e2e.ts` 钉在两次读取：镜像在绑定时的急切读取，加上首连 reset 触发的读取——后者是有意保留的：它关闭了「文档提交落在急切 HTTP 读取与 SSE 订阅之间、其失效通知丢失」的窗口。方案最初的一次读取目标，若不接受该失效丢失窗口、或不把首次读取推迟到 SSE 流建立之后，无法达成。

## 考虑过的备选

- **仅在 `bind()` 内做 single-flight 共享**——能去重并发风暴，但仍保留 N 个直连读取方、N 套订阅以及 revision 偏差；binder 之外的读取方（welcome、models、tab、permission）毫无受益。以治标为由否决。
- **boot 载荷内嵌**（宿主把 describe 应答内联进页面 boot）——省下首次读取，却在镜像仍然需要的前提下增加第二条带自身陈旧规则的取数路径。推迟；若将来需要，它可与镜像叠加。
- **按命名空间的 `settings.describe(ns)`**——缩小单次应答，但每个消费者仍各读一次，扇出与增长率原样保留。否决。
- **一次读取（去掉首连 reset 重读）**——只有接受「急切 HTTP 读取与 SSE 订阅之间的失效丢失窗口」、或把首次读取推迟到流建立之后才可达成；两者都在用正确性或首屏新鲜度换一次环回请求。否决，保留钉住的两次。

## 后果

- 启动期 `settings.describe` 从 15 次降到 2 次，新增持有偏好设置的插件带来零次新增读取。
- 任一时刻每个派生面看到的都是同一份文档 revision；各读取方的防护（`refreshWelcomeIfLoaded`、`refreshPermissionIfLoaded`、`refreshDocumentIfLoaded`）及其订阅随之消失。
- 镜像对任何命名空间的文档提交都会刷新，因此在没有任何设置表面打开时，一次外部设置编辑现在也花费一次后台读取——这是「表面打开即新鲜」的代价。随着各 scope 订阅的删除，按命名空间的 `ns !== spec.namespace` 过滤一并消失。
- `credentials/describe`（启动 3 次）、`agentPresets/list`（2 次）、`llm/listProviders` 与 `llm/listConfigurableProviders` 是另外的数据源，保持直连；若将来需要，同一镜像模式对它们同样适用。
- 客户端代码中新增直连 `settings.describe` 调用即是预算回归；e2e 的失败信息会提示在 `ui-settings` 之外 grep 调用方。
