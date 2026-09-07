# Agent Note: 会话内容搜索通过 openAt never 以 opt-in 方式交付

Status: implemented
Archived: 2026-09-04

[English](2026-08-13-session-content-search-opt-in.md) | 中文

## 问题

交付的 bundle 之前以启用状态挂载 SQLite 会话查询提供方的全文索引（`openAt: first-search`），因此每个默认部署都携带一个派生 FTS 索引，Web 侧边栏提供内容搜索。一个部署是否需要该索引——它的 node:sqlite 导入、每次搜索的来源对账和派生存储——是部署自身的选择，产品默认不携带它交付；面向模型的搜索工具此前已经是 opt-in 且未挂载（见[非默认交付决策](../feature/2026-08-02-session-search-not-shipped-default.zh.md)）。

通过卸载插件行来关闭该能力不可行。`ApiProxyService` 将 `sessionQuery` 声明为必需注入，没有该提供方时整个宿主 API 网关保持未加载，Web GUI 无法启动。会话日志导出通过 `ctx.sessionQuery.traceSession` 追踪子代理后代，子代理分叉也通过同一血缘追踪解析其 Workspace——两者都需要可选服务守卫加一个替代血缘来源，改动面大约扩大三倍，同时使精确读取在所有地方消失。

## 决策

内容搜索在提供方处强制关闭。`openAt: 'never'` 是 `@deepseek-ai/dsh-session-query-sqlite` 的第三个打开阶段：`searchSessions` 和 `searchEvents` 在任何请求规范化之前就以类型化的 `SESSION_QUERY_SEARCH_DISABLED` 代码失败，node:sqlite 绝不会被导入或打开，也不运行任何来源观察或对账。`ctx.sessionQuery` 上继承的全部精确读取、过滤和跟踪保持可用，因此会话导出、分叉的 Workspace 继承和标题读取不受影响。

`SESSION_QUERY_SEARCH_DISABLED` 加入封闭的 `SessionQueryErrorCode` 分类，`tool-session-query` 的服务边界将它映射为模型安全消息 `session search is disabled in this deployment`。

base bundle 在 `session-query-sqlite` 行上设置 `openAt: never`，web bundle 的重述保持该值；启用内容搜索只需在后续 patch 层用一行覆盖 `openAt`（`first-search` 或 `startup`），通常同时配一个持久 `path`。宿主 `session.search` 端点沿现有错误路径报告提供方失败，Web 侧边栏保持其既有降级：本地标题/工作区匹配加内容搜索不可用提示。CLI 兼容性测试固定交付的 `openAt: never` 行，而 Web e2e 脚手架保持内容搜索启用——其种子会话场景通过内容搜索导航，这些运行也是 opt-in 路径的装配级覆盖。

## 曾考虑的替代方案

- **卸载插件行**（在 base patch 中 `disabled: true`）——否决：api-gateway 的必需 `sessionQuery` 注入会使整个宿主 API 保持未加载，而把该注入改为可选需要守卫加上会话导出与分叉解析中的 header 遍历血缘回退。
- **在消费方处关闭**（宿主 `session.search` 端点或侧边栏）——否决：强制应由做出决定的操作执行；opt-in 的模型工具或任何其他消费方仍会触达索引。
- **在 `openAt` 旁增加独立布尔开关**——否决：打开阶段已经拥有"SQLite 何时启动"这一轴；`never` 延伸同一根轴，而不是增加一个可能与之矛盾的第二个旋钮。

## 结果

- 默认部署不运行任何派生索引：没有 node:sqlite 导入或实验性 SQLite 启动警告，没有对账工作，磁盘上没有派生数据库。侧边栏搜索只匹配会话标题和工作区名称。
- 默认状态下的搜索失败是类型化且稳定的，调用方可以把部署选择与索引故障（`SESSION_QUERY_INDEX_FAILED`）区分开。
- 重新启用内容搜索是逐部署配置而非代码改动，并原样恢复完整的 FTS 行为。
- 挂载搜索工具但未覆盖 `openAt` 的组合，每次搜索调用都会得到模型安全的已禁用消息；启用工具意味着同时启用索引。
