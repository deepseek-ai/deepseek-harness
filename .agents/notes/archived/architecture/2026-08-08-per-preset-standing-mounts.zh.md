# Agent Note: 基于作用域父链的逐预设常驻挂载

Status: implemented
Archived: 2026-09-04

[English](2026-08-08-per-preset-standing-mounts.md) | 中文

## 问题

按会话挂载 preset 让面向模型的注册视图变成按 agent 的，而三个独立的宿主读取方仍然假设它是静态的：冷读 `session.history` 找不到 presenter（每张卡都静默退化成通用渲染器——与「工具本无 presenter」无法区分）、投影块丢掉 preset 注册的键（客户端把缺失键当作能力不存在并**清掉**该行）、Typert 网关在宿主根上解析 `goals`（`service-unavailable`）。逐个读取方打补丁只是拿一种静默降级换另一种：为拿到 presenter 而 resume，会把投影折叠从 detached 翻到 live，token 计数随之被抹掉。

## 决策

一个 preset 是**每进程**一份组装，而不是每会话一份。roster 在一个合成常驻 scope 下挂载它一次；每个 agent 通过把自己的 scope key 绑定到挂载的 key（`bindScopeParent(agentKey, standingKey)`）加入。两条 `dsh-scope` 机制承载了一切：注册视图沿父链解析（`agent → preset → global`，近者遮蔽远者），带作用域的分发对标签为载体键祖先的监听器放行——只向上，兄弟 preset 的监听器保持失聪。

## 后果

常驻挂载修的是这一类问题而非其中的个例：读取方需要的注册在进程生命周期内始终存在，按 preset id 索引，不需要任何 agent。让它便宜的原因：

- 有状态的 preset 插件（`plan-mode`、`token-meter`、`compaction-basic`）本就按 `Session`/`Agent` 分键存状态——它们早于 preset 存在。共享一份实例是回归其设计，不是改写。`jobs-local` 同样具备该性质，且此后已完全离开 preset 平面：realm 之外的生产方（`tool-bash`、`tool-terminal`、非 continuable 的 `tool-subagent`）以 `ctx.get` 解析该注册表，而 entry-local realm 对它们不可见，因此它组合在宿主平面，只有面向模型的 `tool-jobs` 行仍留在各 preset 中。
- preset 的 yml 不变：每 preset 挂一次 = 每 preset 一个 Entry，其 entry 本地 realm（`isolate: <name>: true`）让两个 preset 的同名服务互不相干，正如它从前隔开两个会话。
- 共享 realm label **不是**选项：`provide()` 对同一 realm 符号下的第二次注册直接抛错，label 池化的是 REALM 而非实例——按会话挂载的世界里共享 label 会让第二次挂载崩溃。

## 承重细节

- **常驻挂载挂在服务未追踪的 `selfCtx` 上。** 经 traceable 代理调用的方法看到的 `this.ctx` 被重绑到调用方并携带 shadow；从它派生的子树里每个 fiber 的 reflect 解析都从 shadow 的 fiber 起步，entry 会在自己 `inject` 声明的服务上失败（`cannot get property "tools" without inject`，而它的 store 里明明有）。`jobs-local` 的 selfCtx 先例，如今有了第二个消费者。
- **挂载一旦成功即持续供职，直到组装文件的 stamp 变化。** 运行中会话加入的组装必须在其文件被修改或删除后继续存活；每个代际记录文件 stamp（mtime + 大小），会话发现当前代际已陈旧时，会开启下一个代际，因此文件编辑——创作改为仅复制之后唯一的组装编辑器——无需任何创作调用丢弃指针即可达到后续会话。已加入的会话保持其代际，被替代的代际只由整树卸载回收——刻意为之，上限取决于编辑频率，已记入包的 Known Limitations。
- **`peek()` 保持不看链。** 限制与守卫定位的是单个作用域**自己**的贡献；只有注册**视图**沿链继承。链上的限制求交（链上任一作用域都可为嵌套其内的一切遮蔽某个全局注册名称）。
- **重新认父只能经由挂载首绑返回的 `ScopeParentBinding`**——roster 私藏该句柄，空白会话 recompose 因此是唯一的重链路径，其他调用方无法挪动已组合的 agent；其合法性仍以旧父之下产出一概不被保留为前提，由持有方保证，因为该关系看不见会话日志。

## 考虑过的替代方案

冷读时 resume（抹掉 detached 投影）、宿主面 presenter 表加投影块完整性标志（修两个读取方、留下这一类）、每会话模板挂载（为了服务纯函数而复制每一份实例）。留档：面向网关的 `goals` 域无论如何留在宿主平面——Remote 方法的接收者来自生成的 descriptor、在宿主上解析，这正是 `shell-env` 宿主平面判据从消费侧读出的样子。
