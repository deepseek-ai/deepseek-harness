# Agent Note: 配置热重载不得杀死或降级正在运行的应用

Status: implemented
Archived: 2026-09-04

[English](2026-07-20-config-hot-reload-resilience.md) | 中文

## Problem

无效的 `cordis.yml` 编辑不得杀死运行中的 agent（智能体）；但若一次看似有效的更新先部分替换 Loader 树，后续配置项才失败，仅仅保住进程仍不够。调用方还需要能观察到被拒绝的实时更新，同时不能让同一个错误被当作未处理的启动失败。个人配置还带来第二项要求：HMR（热模块替换）必须观察其模块根目录之外的一个确切文件，即使该文件或其父目录在启动后才创建也不例外。

## Decision

vendor 中的 Cordis 生命周期和 Loader 插件提供可等待、带补偿的配置事务，并在 [vendor/README.md](../../../../vendor/README.md) 中记录为本地修改第 6、8、9 条。

`Fiber.update()` 返回其 `internal/update` waterfall（瀑布式事件）的结果。配置校验保持同步，而默认 continuation 返回重启 promise。因此，Loader 配置项更新可以区分校验、导入、应用和回滚失败，以及生命周期成功完成。`EntryTree.await()` 会在 Loader 任务排空后重新检查受服务门控的 fiber，并在 fiber 已结算为失败时 reject；等待缺失服务的 fiber 仍是有效的 pending 配置项，不会让结算挂起。

Loader 会先导入变化后的模块名，再 dispose（资源释放）活动 fiber。它会 await 候选项的应用；若失败，则 dispose 候选项的 effect，并恢复先前的插件或配置。组内对账会并发启动各候选项，等待每项结果，并会在拒绝前恢复已变更的配置项、添加项、移除项和移动项。只有程序化变更成功后才会持久化。这是一种补偿事务：生命周期 effect 可能短暂可见；回滚失败会报告为 `AggregateError`，而不会被误称为树已保留。

Include 读取并校验尚未提交的候选内容，把补丁应用到其副本，对账 Loader 树，然后才提交缓存内容和解析数据。解析、校验、应用或回滚失败后，`refresh()` 会向调用方 reject。初始加载仍会明确报错；只有文件不存在时才可以使用 `initial`。YAML/JSON 结果若不是数组即为无效；文件刷新和 Include 配置更新都会重新应用补丁，且不修改缓存的解析结果。

HMR 收容实时刷新 rejection。其 `registerConfig(filename, refresh)` 方法从最近的现有祖先目录开始监听一个确切路径，串行化并合并刷新，并返回一个异步 disposer；该 disposer 会关闭 watcher 并排空活跃工作。确切路径和普通配置文件的刷新都使用此队列。失败会被规范化为 `Error`、记入日志，并通过并行事件 `hmr/config-update-failed(filename, error)` 广播；发生 rejection 的观察者会被记录，但不会阻止后续刷新。创建、变更和移除均会被观察。

## Alternatives considered

**在 `Include.refresh()` 内收容失败。** 已否决，因为这会使 HMR 宿主无法广播失败，却仍允许 Loader 对账掩盖部分应用。Include 负责候选内容的解析与提交；HMR 负责收容和观察。

**每次编辑配置都重启进程。** 已否决，因为 Cordis effect 已经提供可逆的插件生命周期，而语法错误或可选插件失败不应只为恢复先前的组合就丢弃正在进行的会话。

**承诺不可见的原子替换。** 已否决，因为任意插件 effect 无法制作快照。等待应用完成并显式补偿可以得到稳定的最终结果，同时不会声称观察者看不到中间生命周期转换。

## Consequences

- 实时刷新失败会在内部 reject；补偿成功时会保留或恢复上一份完好的树，并广播一次类型化失败，而不会成为未处理的 rejection。
- 回滚失败可见，并可能使一个配置项不可用；事件和日志不会误称其已恢复。
- 等待已声明依赖的 fiber 仍是有效的 pending 配置项：生命周期完成只表示当前工作均未失败，而不表示每项依赖都存在。
- 确切配置 watcher 只为已注册路径增加文件系统资源，并随其所属 HMR fiber 一起释放。
- vendor 中的 Loader、Include、HMR 与核心事件类型定义进一步偏离上游；全部分叉均维护在 vendor manifest（元数据清单）中。

## Testing

`packages/boot/app-boot/tests/config-reload.spec.ts` 启动真实的临时 Loader/Include 树，并覆盖对解析和形状错误的拒绝、先导入再 dispose、插件/配置恢复、多配置项回滚、祖先禁用、overlay 收敛、option 对象身份、失败的直接更新不持久化以及失败的程序化移动。`packages/boot/app-boot/tests/hmr-config.spec.ts` 覆盖现有和缺失的确切路径、添加/变更/移除、串行化合并、dispose 排空、非 `Error` 值的规范化、失败广播以及对发生 rejection 的观察者的收容。`packages/host/webserver/tests/webserver.spec.ts` 证明受服务门控的启动失败会让 Loader 组合以其 bind 诊断 reject；`packages/typert/loader/tests/loader.spec.ts` 则通过真实 Loader 消费方演练可等待的程序化移除。
