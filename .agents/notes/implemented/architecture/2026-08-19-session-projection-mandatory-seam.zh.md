# Agent Note: 会话投影作为必需的读取 seam

Status: implemented

[English](2026-08-19-session-projection-mandatory-seam.md) | 中文

## 问题

可选的投影注册表会让 host 行为读取投影状态的插件在缺少该状态时仍然激活。除非读取方拒绝缺失的注册表或 key，否则 host 行为或 subagent 目录字段可能静默消失。只有批量读取也会在消费方只需要一个 host 值时物化每个客户端 view。

## 决策

本决策建立在[会话投影的 host 状态与客户端视图](../../archived/architecture/2026-08-19-session-projection-state-and-client-views.md)所定义的拆分之上。

每个 host 状态所有者都把投影注册表及其所需 key 视为必需状态。所有者将 `sessionProjections` 声明为必需注入，并在提供服务方法前等待获取完成；其他消费方依赖这些服务。正式组合在这些插件之前挂载注册表。`ApiProxyService` 采用必需注入形式；较低层的 `createApiProxy` factory 对隔离测试和诊断保持容错。

所有者通过[等待注册与保留句柄](2026-10-12-session-projection-registration-handles.zh.md)获取状态。该决策取代可选首次访问获取和返回裸释放函数的方式，保留这里的必需状态规则：缺少注册表不能静默产生默认 host 状态。客户端视图仍只包含消费字段；业务服务方法提供各消费方所需的 host 数据。

`onChanged` 只发布客户端可见值的变化。注册变化不会创建第二条 Host 事件流或客户端 tombstone 协议。后续权威 history 或 list 基线会反映活跃 key 集。

`onEventChanged` 把一个已提交事件的变化归为一组。所有单元驱动完成后，它按注册顺序收到视图发生变化的每个客户端可见 key 一项 `{ key, val }`，`val` 是该 key 的视图。某个单元或 `onChanged` 监听器抛错时，它仍会收到抛错前已收集的各项。Remote projection 帧沿用这一分组：`session/control` 与 `session/observeProjections` 每个已提交事件发出一帧，携带由同样各项组成的 `changes` 数组，因此 Client 一次应用一个事件的变化，Session 列表只发布一次，而不是每个 key 一次。每项都写明自己的 key，因此改为 `null` 的 key 与未变化的 key 可以区分，消费方也不必按位置把值和 key 配对。`onChanged` 保留给只关心单个 key 的 Host 消费方。

## 考虑过的替代方案

- **为缺失的投影状态提供默认值。** 这会保留更多不完整组合，但缺失 host 状态将无法与合法空值区分。正式 profile 已挂载注册表，配置错误必须显式失败，因此否决。
- **要求每个贡献方都在激活时强依赖。** 这会统一 key 集，却会让贡献生命周期与服务激活产生不必要的耦合。首次访问时显式失败既能保留可选注册形式，也不会允许静默降级。
- **每次读取都使用 `snapshot()`。** 这只保留一个方法，但会计算无关 wire view，并鼓励消费方让 host 逻辑依赖批量传输数据。改用类型化单 key 状态读取。
- **向客户端发送完整 host 值。** 这避免单独的 view 类型，但会暴露客户端不消费的来源信息和策略旋钮。改用显式裁剪的 view。
- **跨 Host 和 mux stream 广播注册表新增和移除。** 两条 stream 没有共享顺序，客户端因此需要 tombstone、缓冲帧和基线重试来协调。插件 key 变化不值得引入第二套同步协议。
- **在 controller 或 Client 中合并逐 key 帧。** 按 microtask 攒批或按序号分组都需要缓冲和时序假设，而注册表本来就知道每个事件的驱动在哪里结束。改为在驱动处分组。
- **把帧内的变化做成 key 到值的对象。** 消费方要从对象成员推断哪些 key 变化，也会丢失注册顺序。改用有序的 `{ key, val }` 数组。
- **使用平行的 `keys` 与 `values` 两个数组。** 这样不必重复每项的字段名，但每个消费方都要按下标保持两个数组对齐，线路类型也无法表达两者等长。改用自带 key 的各项。
- **用事件级变更流取代 `onChanged`。** forge 等 Host 消费方只关心单个 key，分组对它们没有好处。两条变更流都保留。

## 后果

- 缺少投影组合会在激活期间失败，绝不会降级为默认值。
- host 消费方避免重复的全注册表快照和日志扫描。
- 协议负载排除 host 内部字段和逐 key 水位包装；普通基线会传达活跃 key 集。
- 一个已提交事件对每个 Session 至多产生一个 Remote projection 帧，其 `seq` 是该事件的序号。
