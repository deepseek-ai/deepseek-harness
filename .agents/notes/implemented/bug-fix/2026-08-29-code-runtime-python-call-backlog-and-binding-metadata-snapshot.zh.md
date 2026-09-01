# Agent Note: 在 CPython 后端限制在途 binding 调用、快照 binding 元数据、压缩回复队列并用游标计量宽完成值

Status: implemented

[English](2026-08-29-code-runtime-python-call-backlog-and-binding-metadata-snapshot.md) | 中文

## Problem

对 CPython 子进程后端（packages/experimental/code-runtime-python）的又一轮评审在 binding 分发、校验、完成值计量与帧解析路径上浮出七项发现。其一，回复积压上限只计数已解析的调用——`pendingReplies` 在 binding 的 `await` 解析后才增长——因此向 promise 永不结算的 binding 洪泛调用的子进程会每个帧累积一个异步闭包直到墙钟，却始终不触发该上限。其二，`validateBindings` 多次读取 `errorClass.name`、`errorClass.memberNameProperty` 与 `namespace.global`，并把原始 errorClass 对象保留到引导帧，其 `JSON.stringify` 在校验后重读该对象：getter 在校验时返回合法值、在序列化时抛错或返回冲突值，会把 seam 误用拒绝变成 worker-exit，或注入一个未经校验批准的名字。其三，`replyQueue` 在排空进行中从不收缩：排空循环把已消费槽位清成 `undefined`，但 `length`（及其后备存储）继续增长，因此以恰好能让排空持续存活却永不排空的速率读取回复的子进程，会让数组随累计吞吐量线性增长。其四，完成值计量器 `checkDoneValue` 把开放容器的每个成员压入显式工作栈，因此接近帧上限的宽完成值（数百万成员）会把同等数量的引用复制进栈——在已解析值之上再占 O(width) 辅助内存——在解析成功后 OOM 终止宿主。其五，与超过 1024 个调用帧处于同一 data 事件的 done 帧会在批后调用积压检查运行之前结算运行（该检查在 settled 后为空操作），因此子进程可以「成功」完成却留下未结算闭包。其六，子端 `_dump_string` 把拼写出来的代理项对折叠成星面码点，因此两个不同的 Python 字典键——`"\ud83d\ude00"` 与 `"\U0001f600"`——编码成同一个 JSON 成员，宿主的 `JSON.parse` 会静默丢弃其一，违反完成值与 binding 参数的 lossless JSON 承诺。其七，加载门限制的是子端在 `RLIMIT_AS` 下的构建与编码，而非宿主的 `JSON.parse`：合法配置的接近帧上限宽完成值（如 50 MiB 预算下的 300 万键字典）会在宿主属性存储中物化其原始字节的若干倍，因此受限堆宿主（如 `--max-old-space-size=256`）会在解析期间以进程级 OOM 死亡——早于 `checkDoneValue`（它只能看到已解析值）拒绝它。

## Decision

### 在途 binding 调用限制为 1024，每个宏任务在微任务排空后检查一次

`case 'call'` 在分发前对在途 binding 调用计数（`pendingCalls`），并在异步体的 `finally` 中释放槽位，覆盖回复已写入、解析被拒绝与结算后丢弃三种出口。data 处理器经 `setImmediate`（用标志去重）为每个宏任务调度一次批后检查：它在该宏任务的微任务之后运行，因此看到的是真实在途计数——实时计数被本批自身帧抬高（`finally` 尚未运行），而按 `data` 事件刷新的快照在 flowing 模式下同一宏任务内连续发出多个事件（微任务尚未排空）时会过期。计数**严格大于** `MAX_PENDING_REPLIES`（恰好 1024 个在途调用允许）时，运行以带 call-backlog 消息的 `worker-exit` 结算。检查在 `settled` 后为空操作，因此 `done` 或 `log` 帧优先于上限：启动了 binding 调用却未 await 就返回的程序仍以其值正常完成。`done` 处理器在接受帧之前独立复查计数，封住与洪泛同批的 done 会在批后检查触发前结算运行的窗口。这是计数上限而非字节上限。

### binding 元数据在校验与引导帧之前快照为纯值

`validateBindings` 把 `namespace.global`、`errorClass.name` 与 `errorClass.memberNameProperty` 各恰好读取一次到普通局部变量，对副本做校验，并在 bindings 映射中存入普通 `{ name, memberNameProperty }` 对象。引导帧序列化该存储副本，因此无论 getter 处于何种状态，校验与引导帧看到的都是相同的值；有状态的 getter 无法在两个阶段之间改变或抛错。

### 回复队列在排空进行中压缩已消费前缀

`drainReplies` 在 `head` 达到 `MAX_PENDING_REPLIES` 时压缩已消费前缀（`replyQueue.splice(0, head); head = 0`）。该 splice 为 O(head)，每消费一上限的帧执行一次——均摊到每条回复为 O(1)——使永不排空的排空把后备存储限制在 O(积压 + 上限)。

### 完成值计量器每层持一个游标遍历宽值

`checkDoneValue` 现在为每个开放容器持一个游标（根与数组用 values 迭代器，对象用 entries 迭代器——key 的转义字节在该 entry 到达时计量），与 `hasNonLosslessNumber` 及子端 `_check_done_value` 已用的形态一致。字节预算仍然限制遍历：每个成员在游标产出时计量，宽度下界检查会在游标下降之前拒绝超预算容器。辅助状态为 O(depth) 而非 O(width)，因此接近帧上限的宽完成值精确计量，而不是复制数百万引用。`encodeJsonPlain` 保留其每容器任务栈——该栈为 O(width) 但只持有引用，而编码输出本身即 O(total bytes)，与结果同量级，豁免已在注释中说明。

### 帧解析上限受宿主堆约束

原始字节帧上限并不保护宿主进程：`JSON.parse` 一个宽对象帧会在属性存储中物化其原始字节的若干倍。**最坏形态是大量短唯一键的字典**——迫使 V8 进入字典模式属性存储并为每个键内化一个字符串——1 GiB 堆上 3,000,000 键帧（约 31 MB 原始）实测 6.4 倍且随键数上升（平铺唯一键数组约 4 倍、重复键字典约 3 倍）；256 MiB 堆直接在该帧上 OOM。每个实例执行的有效上限为 `min(协议上限, floor((heap_size_limit - HOST_PARSE_BASELINE_BYTES) / HOST_PARSE_WORST_CASE_MULTIPLE))`，系数为 16——实测最坏形态的约 2.5 倍安全余量——由宿主配置的堆上限推导（`--max-old-space-size` 经 `v8.getHeapStatistics().heap_size_limit` 生效）。默认 Node 堆（约 4 GiB）永不收紧；受限宿主会降低上限，加载门拒绝任何帧无法被安全解析的预算，在加载期响亮失败而非在解析中途 OOM 宿主。子端的 `RLIMIT_AS` 门是另一资源，保持不变。

### 折叠为同一 JSON 成员的字典键按非 lossless 拒绝

子端 `_dump_string` 把拼写出来的代理项对折叠成星面码点，使宿主的 UTF-16 字符串（两个码元与单个字符是同一字符串）按相同成本计量。Python 可以把两种拼写作为不同键持有，因此包含 `"\ud83d\ude00"` 与 `"\U0001f600"` 的字典会发出两个同键成员，宿主的 `JSON.parse` 会静默丢弃其一。两条 lossless-JSON 遍历（binding 参数的 `_lossless_json_violation` 与完成值的 `_check_done_value`）现在用每字典 seen 集跟踪合并后的键——O(keys)，与字典本身同量级——在编码前把冲突判为非 lossless。

## Testing

- `tests/runtime.spec.ts`——敌意子进程向永不结算的 binding（`await new Promise(() => {})`）洪泛 5000 个连续调用；运行在远早于 `maxWallMs` 时以带 call-backlog 消息的 `worker-exit` 结算。已实测失败前置：没有该上限时运行在墙钟处超时。
- `tests/runtime.spec.ts`——合法的 `asyncio.gather` 并发 1025 个即时调用并全部完成：批后检查看到的是 `finally` 排空后的计数，而逐帧检查可能被单次 64 KiB 读取中的第 1025 帧误触发。
- `tests/runtime.spec.ts`——程序调度 1024 个慢 binding（仍未结算）并返回 `"done"` 时以其值正常完成：done 帧结算运行后检查为空操作，且严格阈值允许恰好 1024 个在途调用。已实测失败前置：无条件的事件边界检查恰好在该用例上失败。
- `tests/runtime.spec.ts`——单次 62 KiB 写入的 1025 个紧凑调用对抗永不结算的 binding，在远早于 `maxWallMs` 时以 `worker-exit` 结算，即使之后不再有帧到达：每宏任务检查在该批之后触发。已实测失败前置：按事件刷新的接纳快照在没有后续帧时永不复查，运行等到墙钟。
- `tests/runtime.spec.ts`——单次写入的 1025 个紧凑调用**外加同批 done 帧**以 `worker-exit` 结算：done 处理器在接受帧之前复查计数，而批后检查会在 done 结算运行后空操作。已实测失败前置：没有 done 复查时运行成功完成并留下未结算闭包。
- `tests/runtime.spec.ts`——1300 个即时调用的突发（帧跨管道读取拆分）全部完成：检查在该宏任务的所有 `finally` 之后运行，而按事件快照在 flowing 模式同宏任务内多个事件、微任务未排空时会看到过期的在途计数。
- `tests/runtime.spec.ts`——字典同时含 `"\ud83d\ude00"` 与 `"\U0001f600"` 两个键的完成值与 binding 参数按非 lossless 拒绝（invalid-output / lossless-JSON 调用拒绝）：两种拼写折叠为一个 JSON 成员，宿主的 JSON.parse 会静默折叠。已实测失败前置：没有碰撞检查时两者都以丢键 round-trip。
- `tests/protocol.spec.ts`——`hostFrameParseCeiling` 从模拟堆推导有效解析上限：默认堆上协议上限约束，约 304 MiB 宿主上限得出 15 MiB 上限，极小堆几乎不留下解析空间。
- `tests/runtime.spec.ts`——128 MiB old space 的子 node 在加载期拒绝 50 MiB 完成值预算（`maxValueBytes must not exceed`），而地址空间门单独会放行。已实测失败前置：忽略堆上限时该预算正常加载。
- `tests/runtime.spec.ts`——128 MiB old space 的子 node 构造帧恰在推导上限处的宽唯一键字典并解析，存活。已实测失败前置：解析系数回退到 8 时推导上限翻倍，同一子进程在解析中 OOM。
- 套件的临时 fixture（`dsh-bad-bin-`、`dsh-fake-bin-`、`dsh-rlimit-*`、`dsh-staging-`、heartbeat 目录、wrapper 脚本）现登记并在每个测试后移除，重复运行不再在共享 tmpdir 累积 `dsh-*` 工件。
- 两个 namespace 形态测试——`errorClass.name`/`errorClass.memberNameProperty` 与 `namespace.global` 经由第二次读取即抛错或改变的 getter 暴露；运行正常引导并完成，且每个字段恰好读取一次（已断言）。已实测失败前置：没有快照时，errorClass getter 在校验内抛错，global getter 注入不同名字，程序以 `NameError` 失败。
- `tests/runtime.spec.ts`——子进程洪泛回复超过可写高水位线的调用，阻塞第一次排空写入；恢复的排空在第二波调用仍待发时消费超过压缩上限的积压，子进程直接读取 fd 3（阻塞回复泵）验证全部 1524 条回复送达。无固定睡眠：子进程的读取以排空的投递速率节流，宿主在毫秒内完成一波推送，因此压缩点队列必然已满；换行按块计数（每条回复恰好一个），绝不重扫累计总量——那会是 O(n²)。已实测失败前置：移除待发帧的 splice 会丢掉第二波回复，运行挂到墙钟。
- `tests/protocol.spec.ts`——2,000,000 元素数组与 100,000 键对象以精确序列化大小计量、少一个字节即拒绝，并仍能发现尾部的 `-0`，钉住游标遍历的广度行为。

## Alternatives considered

**暂停 fd-3 读侧而非计数在途调用。** 拒绝：暂停读取也会让子进程在最后一个调用后可能发送的 `done` 与 `log` 帧处理停滞，改变结算时机；计数上限是确定性的，且与既有帧上限模式一致。

**逐帧检查在途计数。** 拒绝：`finally` 在微任务队列上运行，微任务只在宏任务结束时排空，因此单个事件携带超过 `MAX_PENDING_REPLIES` 个合法调用帧时，即使每个 binding 都立即结算，逐帧检查也会误触发。

**在调用接纳处对照按事件刷新的快照检查。** 两次拒绝：无条件的事件边界检查会把程序返回未 await 调用时的 `done` 帧改判为 worker-exit；按 `data` 事件刷新的快照在 flowing 模式同一宏任务内多个事件时过期（第二块携带超过上限的在途调用的合法突发会被误杀）。每宏任务在微任务排空后检查真实计数，在两个轴上都不依赖分块；严格阈值让恰好 `MAX_PENDING_REPLIES` 个在途调用正常完成。

**只读取一次元数据但保留原始 errorClass 对象。** 拒绝：引导帧的 `JSON.stringify` 会重新调用 getter；只有存入普通副本才能保证两个阶段读到相同的值。

**依赖排空的 `finally` 重置来回收队列内存。** 拒绝：重置只在排空结束时运行；永不排空的排空会持续增长。排空进行中的压缩在排空存活期间限制后备存储。

**保留完成值计量器的显式成员栈。** 拒绝：字节预算限制遍历本身，但不限制栈的引用数——那是 O(width)——接近帧上限的宽值会复制数百万引用，在解析成功后 OOM 宿主；每层游标形态保持 O(depth) 状态。

## Consequences

在途 binding 闭包与回复积压一样受限，向永不结算的 binding 洪泛调用的子进程会让运行提前失败，而不是把闭包累积到墙钟；合法的并发大 gather 不受影响（上限在微任务队列排空后检查）。引导帧序列化校验批准的元数据，与 getter 状态无关。回复队列的后备存储在持续的部分排空期间保持有界；压缩是内部内存卫生，无可观察的行为变化。完成值计量器以 O(depth) 辅助状态保持精确的字节核算，宽完成值不再因计量本身 OOM 宿主。
