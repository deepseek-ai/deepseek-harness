# Agent Note: Session Inspector 数据所有权与导航

Status: implemented

[English](2026-09-24-session-inspector.md) | 中文

## 问题

调试 Session 需要并排查看原始日志、Chat 结构和会话内容。运行时对象共享 Node、Turn、Step 身份并包含循环引用，只显示 JSON 无法支持引用导航。检查器需要独立入口，但不需要把所有 Conversation View 变成 Sidebar 资源。

## 决策

`experimental/session-inspector` 注册 `session-inspector-log` Sidebar 页面及其 Session 作用域正文。已有 Sidebar 管理 Session 引用。检查器不增加资源提供方、Conversation header slot、composer 或产品包导航 API。[Session Inspector README](../../../../packages/experimental/session-inspector/README.zh.md) 描述表格操作与展示行为。

- Session Controller 和 Chat 保留数据所有权。只有当前选中的表格订阅；日志使用现有已加载窗口和分页，不增加 Session 流或持久化格式。
- 虚拟表格按 Turn → Step → 事件 → Assistant block/delta 分组。未闭合 block 展开，闭合后折叠。自动折叠通过尾部留白保留可见行或仍存在的祖先位置；手动折叠锚定被点击组头并暂停跟随。吸顶祖先在表头和前面吸顶行之下选择。
- Chat 保留真实根顺序和分组成员关系。未进入可见分组的已物化节点按事件锚点插回，不追加到最后一个 Turn 之后。内容更新保留行身份。
- WeakMap 引用标记 Node、Group、各自 Data 根对象、Turn/Step 位置及 Data reader。面包屑保存 reader 而非副本。Node Data 可原地展开；具名引用和祖先检测阻止循环展开。
- 对象字段按需读取，每页 50 项。Location Data reader 可以原地变化而保留身份，因此 Conversation 发布会使展开字段缓存失效。纯 UI 重渲染复用缓存。Getter 不自动执行，弱集合内容保持不透明。
- 导航逻辑留在实验包内。检查器通过已有 Slot/Chat data 属性和当前 UI Session 查找主 Chat，排除 Sidebar、隐藏视图与嵌套会话。可搜索的折叠祖先接收 `beforematch`；检查器不写入 Chat 的折叠状态。
- 已可见目标只闪烁。屏外目标先使用原生平滑滚动，再在 body 层通过裁剪浮层闪烁。用户打断、替换请求、切换模式或释放会取消未完成操作。日志行允许近似映射到附近已加载 Node、Group 或 Turn；定位不切换主 View，也不加载历史。
- 反向点选通过主 Chat 上的真实点击蒙层完成。`elementsFromPoint()` 和独立匹配函数反查底下记录；蒙层拦截底下控件的点击，并把滚轮交给已有滚动区域。取消会移除蒙层、浮层与监听。

## 运行时诊断

默认关闭的可选组合包 `inspector-profile` 启用会话检查能力、NodeJS 调试 Worker 和未脱敏的 Host fetch 采集。启用组合包不需要调试参数或用户覆盖配置。实现及显式源码／构建产物 overlay 保持可用；Web startup 不接受新参数，设置区不增加调试按钮。

Host 管理调试 URL、Worker 和采集生命周期。组合配置提供 `--inspect` 时，Host 尝试打开 Chrome；打开失败后打印的链接仍可使用。关闭调试窗口不会停止采集。显式启用允许执行本地代码并采集未脱敏网络数据，风险说明见 [Inspector 安全部分](../../../../packages/experimental/inspector/README.zh.md#security)。

页面加载后启用的 Client 通过已鉴权、文档相对的 Connection 路由获取当前 ingest 参数。初始注入仍支持早期建联。连接重置会刷新参数；替换先释放旧 source，卸载会取消并等待未完成操作。Client 不接收也不打开调试 URL。

## 考虑过的替代方案

**通用 Conversation View 资源与 header label。** 这需要为一个消费者增加地址校验、独立 Session 引用、视图不可用恢复和 composer 选项。已有 Sidebar 页面类型足够；通用协议应等独立消费者出现后再评审。

**在 `ui-conversation` 注册 Sidebar，包括细分 header 导出。** Sidebar 已消费 Conversation header。反向依赖形成 TypeScript project-reference 环，运行时弱注入和仅类型导入不能消除。实验消费者通过正常 `/client` 入口同时依赖两包。

**复用 `subagentchat`。** 它承载完整 subagent 会话与 composer，而不是原始数据检查。独立页面不改变普通会话和 subagent Chat 行为。

**通过通用事件实现目标 View 定位。** 这能隔离 DOM 实现，但需要为实验消费者在产品包增加请求类型、路由、确认和生命周期代码。Inspector 自持 DOM 适配，接受已有属性或布局变化时同步维护的代价。

**把所有 Chat 对象序列化为 JSON。** 共享身份、循环引用和 Map key 会失去交互结构。弱引用与按需对象树保留导航，也不持有被替换的快照。

**流结束后立即缩短列表。** 长 block 折叠会改变视口。尾部留白保留锚点，并由新行逐渐填充；跟踪最新会清除留白。

**只读取页面初始注入。** 后启用插件没有初始注入。获取当前 bootstrap 可以让建联不依赖页面加载时机。

**让 Client 打开调试 URL。** 浏览器页面不管理 Host 应用启动。由 Host 启动可以统一 URL 处理与进程生命周期，不增加启动服务。

## 后果

检查器管理局部筛选、折叠、选中、面包屑和高亮，不拥有 Chat 业务状态。它只检查已加载历史和主 Chat 中已挂载内容，不展示 Projection 控制流更新。单独启用 Session Inspector 插件不会启动调试端口或请求采集；启用可选组合包也会启用 NodeJS Inspector 和 fetch 采集。

此前的[可选组合包决策](../architecture/2026-09-21-experimental-capabilities-as-optional-bundles.zh.md) 继续管理安装与提供方运行时的取舍。本功能向名单增加 Inspector profile，而不是把所有实验提供方都做成可选组合包。

## 测试

包级测试覆盖注册释放、层级与折叠锚点、隐藏节点顺序、筛选、对象导航与缓存失效、DOM 范围、平滑滚动、点选和取消。工作量回归限制索引集合的首屏读取量，并防止追加时重新分组历史行。诊断测试覆盖 Loader 启用、注入和主动获取 bootstrap 的失败、重连恢复、注册回滚、打开窗口失败与等待释放完成。`snapshots/web/session-inspector` 中的 Web 场景通过可选组合包重放录制 Session，检查日志筛选、对象详情和 Chat Group 顺序。
