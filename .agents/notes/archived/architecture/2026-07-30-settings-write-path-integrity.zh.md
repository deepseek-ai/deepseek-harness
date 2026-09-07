# Agent Note: settings 写路径完整性与观察者生命周期

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-settings-write-path-integrity.md) | 中文

> 范围：`dsh-settings-file` 的写路径数据完整性（操作链、读-改-写、跨进程写锁、diff 形态的 YAML 编辑）与 `dsh-settings` 的观察者生命周期（watch 的 dispose（资源释放）、异步监听器收容、JSON 形态写入边界）。本 note 推翻了[用户设置 seam note](2026-07-28-user-settings-seam.zh.md)所记录的一项延后决定：跨进程锁文件现已交付。

## 问题

提供方的写路径可能销毁它从未观察到的状态，而 Service Definition 的观察者生命周期会泄漏到 dispose 之后。具体而言：watcher 重载与文档写入跑在两条相互独立的 promise 链上，而每次写入都从缓存文本渲染出完整的下一份文档，于是仍处于防抖窗口内的外部编辑会被覆盖——随后的重载又因 rename 后的内容与缓存一致而成为空操作，这次编辑就被无痕抹去。初始 `load()` 与 watcher 自身的建立过程存在竞态，留下一个启动窗口：落在这个窗口内的变更永远不会触发事件。共享同一 harness home 的两个进程各自从独立的缓存渲染，后写者以整个 namespace 为单位胜出。

在 Service Definition 一侧，`watch()` 的释放器只把观察者从集合中移除——已经接到 watcher 链尾的调用在 dispose 之后照常运行，服务 dispose 时也没有任何环节排空已启动的调用；`settings/updated` 的手动扇出只捕获同步抛错，异步监听器的 rejection 会以 unhandled rejection 的形式逃逸；`structuredClone` 则放行 Date、Map、BigInt 与循环引用，而 YAML/JSON 存储会在重载往返中悄悄扭曲这些值（Date 会变成时间戳字符串，BigInt 会变成普通数字）。

YAML 写入则整体替换 namespace 节点，把分节内的每条注释都删掉——而这个保注释的提供方承诺过要保住它们。

## 决策

**单一操作链，且每次写入都是读-改-写。**watcher 的刷新与来自各 namespace 队列的持久化共享同一条结算链；`persistSection` 会先把磁盘上的文本对账进 seam——任何未被观察到的差异都先发布出去——然后才对照这份新鲜文本渲染。写入不再可能复活一份陈旧文档；磁盘上已变非法的文档会让写入响亮失败，而不是被覆盖（重载路径保持其「告警并保留最后可用值」策略；共享的 `reconcileFromDisk` 抛错，各调用方自选策略）。watcher 的 `ready` 信号会额外排入一次对账，弥合初始加载与 watcher 生效之间的启动缺口。

**写入持有以 `wx` 创建的同目录 `<file>.lock`。**读-渲染-rename 循环在一把跨进程写锁下运行，采用指数退避与 2 s 获取期限。`EEXIST` 直接表示竞争；只有 `lstat` 确认锁路径存在时，`EPERM` 才表示竞争，因为 Windows 可能把针对该现有路径的独占创建报告为权限拒绝。无关的权限故障仍会响亮失败。竞争者会超时，但不会移除现有锁，因为锁龄无法区分已经崩溃的所有者与被暂停但仍存活的写入方；遗留锁恢复须由操作者执行。读方从不加锁——rename 提交是原子的——因此竞争只发生在写方之间。重试与期限常量是协议不变式，而非部署配置。

**观察者 dispose 达到完全停稳。**watcher 携带一个 `active` 标志，排队的调用即将启动时先检查它，因此在调用等待期间已经运行过的释放器能让这次启动彻底不发生；已启动的调用会登记进服务级的 `pendingTails` 集合，dispose 排空除了等待各写队列，还会等待该集合。`settings/updated` 扇出会把监听器返回的 thenable 的 rejection 收容进与同步抛错相同的监听器诊断；事件约定现已写明 `INVARIANT` 重抛只服务同步监听器——不变式配套插件必须保持同步，而已交付的那个配套插件本就是同步的。

**写入边界只放行 JSON 数据。**调用时刻的快照就是一次 `cloneJsonShaped` 遍历：它把 patch 从调用方分离出来，并在任何内容持久化之前拒绝一切非 JSON 值——Date、Map、BigInt、非有限数值、函数、symbol、类实例、值为 `undefined` 的数组元素、循环引用——拒绝时附带该值以 `$` 为根的路径。显式为 `undefined` 的对象条目仍会跳过（稀疏 patch 约定），这一约定如今在边界处强制执行，而不再放在 `mergeLayers` 内部。

**YAML 编辑是叶子级 diff。**`renderYaml` 对比已存储分节与下一份分节，只对变化的值应用 `setIn`、对移除的键应用 `deleteIn`，并沿 map 递归。注释、锚点与格式在每个未触碰节点上以及每个被改键值对的键节点上全部保留；数组等非 map 值在不相等时整体替换（`deepEqualJson` 是共享的判定谓词），其内部注释随之一并被带走。

## 曾考虑的替代方案

- **用 `proper-lockfile` 取代手写锁**——按「依赖优先于手写」政策做过权衡：该库几乎无人维护，其所有权与重试策略比这个单文件协议所需的更宽泛，而已交付的锁只是一个小型独占创建循环，带确定性的竞争测试。该政策偏向能删除自有代码的依赖；这个依赖只会把一个窄协议换成不透明的等价物。
- **用修订号/CAS 取代锁**——rename 表达不了 compare-and-swap，因此 CAS 需要一个版本伴随文件或内容重哈希，外加每个写方里的一个重试循环；锁用一个原语实现同样的串行化，还让读方完全免锁。
- **把外部编辑合并进正在进行的写入自身的分节**——seam 是在调用时刻可见的状态之上合并 patch 的，因此与写入竞态的同 namespace 外部编辑仍按后写胜出解决；要把外部编辑并进来，需要三方合并语义，而没有任何消费方提出过这种需求。写入会先发布外部状态，落败一方至少在被取代之前被观察到。
- **宣布不支持异步 `settings/updated` 监听器**——类型签名是 `void`，lint 也会标记误用的 promise，但未经 lint 的 JS 插件仍能注册异步监听器；约定里的一句说明无法收回已经抛出的 unhandled rejection，收容是唯一在运行时守得住的防线。
- **保留 `structuredClone`、在提供方里做校验**——Service Definition 才是持久化边界的所有者（每个提供方存储的都是 JSON 形态文档），而且在调用时刻拒绝能把违规值的路径给到调用方；提供方侧的检查要到合并之后才拒绝，归咎的是合并后的分节，而不是调用方传入的值。

## 后果

`update()` 对锁获取期限与磁盘文档非法都有成文的失败模式，rejection 消息携带以 `$` 为根的路径。持有者崩溃后可能留下锁，需要操作者核实后移除；若按锁龄自动接管，则会允许多个写入方重叠。仍然存在、且已记录在提供方 README 中的有：同 namespace 并发编辑仍是后写胜出（没有逐值合并，也没有修订号检查）；OS 从未投递的 watcher 事件会让缓存保持陈旧，直到下一个信号或下一次写入；被替换数组内部的注释、以及行内附着在被改标量值上的注释，会随其描述的值一起消失。

[用户设置 seam note](2026-07-28-user-settings-seam.zh.md)里「延后锁文件」那条替代方案已被本 note 取代。同类缺陷曾存在于 `dsh-credentials-local`（两条链共用一个 `.env`、按缓存整文件写回、持久化之后才发事件）与 `llm/adapters-updated` 扇出；[credential-boundaries note](2026-07-30-credential-boundaries-and-atomic-registration.zh.md) 在那里套用了本模板。
