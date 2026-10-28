# 防御性模式

[English](general.md) | 中文

来之不易的缺陷类别规则：下面每条模式都是本项目实际发布或差点发布的一类缺陷，以防止其复发的规则形式陈述。在编写生命周期、并发、子进程或清理代码之前请先阅读本文。测试层面的对应规则（真实入口路径、验证实际结果、资源归属）见 [testing.zh.md](../testing.zh.md)；这些规则引用的类型定义正家见 [subsystems/](../subsystems/README.zh.md)。

<a id="report-orthogonal-outcomes-independently"></a>

## 正交结果独立上报

一个结果可以同时具有多种性质：进程可能已经超时，却仍以退出码 0 结束，因为它捕获了终止信号。每个独立事实（`timedOut`、`signal`、`exitCode`）都应单独上报；切勿把一个标志的上报嵌套在另一个标志的分支中，否则调用方可能把提前终止的运行误判为正常成功。

评审看的是**上报形态**而不是终止机制：每个事实能否独立为真，以及能否不进入另一个条件分支就读到它？边界就是这个上报本身——如何发信号、给多长时间是另一个决定。

<a id="honor-public-contracts-on-both-sides"></a>

## 公共约定两侧都要遵守

当一个实现收到同一结果的多种表示时，应在通过公共 API 返回前将其规范化。`LlmAdapter.stream()` 的实现可以抛出异常或发出 `finish {kind:'error'|'aborted'}`，但 `LlmRuntime.stream()` 只会通过终止型 finish 分片暴露模型请求失败；middleware 缺陷与消费方缺陷仍会以异常形式抛出。这使消费方不必猜测捕获的异常究竟来自提供方、包装层、分片日志记录还是自身组装逻辑。请在类型定义处记录规范化后的约定；通过真实消费方覆盖每种来源形式。

判定条件是：消费方能否仅凭公共 API 说出故障的来源。内部 helper 仍可自由抛错：这条要求约束的是消费方跨越的那个边界，而不是它背后的每个函数。

<a id="async-state-is-not-synchronous-state"></a>

## 异步状态不是同步状态

`agent.followup()` 没有逐消息的完成状态或结果；后台任务的完成与轮次边界存在竞争；`reader.close()` 在 EOF 和 dispose（资源释放）两种情况下都会触发。切勿把 `agent/status` 或 `whenIdle()` 当作某次 `followup()` 的结果：多条已排队的后续消息、steering（中途引导）和注入工作可能共用同一个 `running` 区间，而取消或资源释放可能丢弃尚未启动的项。真正拥有一次运行的自动化调用方必须显式定义其区间——例如从消息的持久 inbox 回执到整个 agent（智能体）下一次进入 `idle`——并将选取的任何输出描述为整个区间的输出，而不是把因果关系归于该消息。这条守则是双向的：如果等待的转换永远不会发生，等待就会挂起，因此应显式处理「无需等待」的分支。

判定条件是：调用方是否观察到一个 API 并未定义的逐单元完成态。区间确实属于调用方时，就由调用方声明区间与输出范围；共享的 `running` 标志永远不是这份声明。

<a id="timing-does-not-carry-correctness"></a>

## 时序不承载正确性

正确性来自显式调用点与显式状态，而不是回调落在事件循环的哪个位置。用 `microtask`、`setTimeout` 或 `queueMicrotask` 决定某项工作是否正确，是在与程序其余部分竞争：轻负载下成立，重负载或合批行为一变就静默失效。React 代码同理——effect 绝不提供那种本应由设计显式给出的「渲染之后」次序。

判定条件是：正确性是否依赖「那个回调已经跑过」，而不是具名调用点或状态机。两条边界：测试的 timeout 预算是在等失败，不属于靠时序保正确性；纯粹为可见工作 pacing 的延迟也不属本条。开发者一侧没有例外通道，确需时序技巧须经对应领域专家确认。

```ts
// The order is written into the code: dispose the old store, then build its successor.
declare let store: { dispose(): void }
declare function createStore(scopeKey: string): { dispose(): void }
declare const scopeKey: string

store.dispose()
store = createStore(scopeKey)
```

```ts ignore-check
queueMicrotask(() => { if (!ready) refresh() })   // assumes the microtask runs before the next frame
setTimeout(() => setMounted(true), 0)             // waits for a render that was never sequenced
```

反例的失效是间歇性的：偶发丢刷新，或状态永远没同步，只在压力大时复现。

<a id="optional-inputs-state-both-behaviors"></a>

## 可选输入要写明两种行为

可选参数要写明被调用方在**传入**与**不传入**两种情况下各自的行为，调用方从契约里读到两种行为，而不是靠防御性运算符去猜其中一种。堆积 `?.` 就是这个信号：每一个都在替代「这个字段到底应不应该存在」的判断。

判定条件是：`?.` 是否被用来替代「该字段存在」的判定，而不是在处理一个已知值上真正可选的一跳。这条要求约束接口契约：两个分支都要写明返回值与副作用，并由调用方从契约处读到。没有例外通道——无法说清两种行为的调用点属于评审打回项，不是风格偏好。

```ts
// Both behaviors are in the contract: no options object means "unknown", not "skip".
interface ResolveInput { options?: readonly string[] }
type Resolution = { kind: 'unknown' } | { kind: 'value'; value: string }

function resolve(input: ResolveInput): Resolution {
  if (input.options === undefined) return { kind: 'unknown' }
  return { kind: 'value', value: input.options.join(',') }
}
```

```ts ignore-check
const value = a?.b?.c?.d ?? fallback   // four layers of fallback hide whether d should exist
```

反例让契约持续含糊、错误被静默吞掉，于是下一个调用方又叠一层兜底。

<a id="one-value-states-one-fact"></a>

## 一个值只表达一个事实

未知值、空集合或空字符串、以及字段真的不存在，是三件不同的事实，用三种不同的表示。一个 `undefined` 或 `null` 绝不代表其中多个；需要在三者上分别处理的消费方显式判别，而不是在边界处把它们压平。

判定条件是：同一个「无值」是否承载了多种语义——**未查询**、**查到为空**、**无法判定**。通常的实现是可辨识联合或显式枚举值，并在类型定义处记录（见 [core.zh.md](../subsystems/core.zh.md#repo-wide-type-patterns)）。

```ts
type ValueState<T> = { kind: 'unknown' } | { kind: 'empty' } | { kind: 'value'; value: T }
```

```ts ignore-check
return null   // means "not queried", "queried, nothing there", and "cannot tell", all at once
```

反例让调用方无法区分这些情况，UI 状态、缓存策略与重试判断都会跟着做错。

<a id="a-new-active-current-singleton-is-refused"></a>

## 新增 active/current 单例一律禁止

不得新增全局的 `active` 或 `current` 单例，存量逐步迁出。全局唯一选中态是本仓库不做出的设计声明：同一份数据的多个视图各自持有自己的引用或键。

判定条件是：该改动是否引入了全局唯一的选中态字段。替代形态是**一份数据、多份视图**，每个视图带自己的引用。没有默认例外；确实每个服务只有一份的概念由服务或实例的字段承载并经 `inject` 取得，绝不落成模块级字段。

```ts ignore-check
// Each view holds the key it renders; nothing global decides what is "current".
function ConversationView({ sessionKey }: { sessionKey: SessionKey }) { /* … */ }
```

```ts ignore-check
let activeTabId: TabId | undefined   // module-level; every component reads the same one
```

反例让彼此独立的实例互相串台，也没有人能审计焦点与状态归谁。

<a id="shared-state-has-one-owner"></a>

## 共享状态只有一个所有者

共享状态挂在服务或实例上，因此它的所有者是一个有生命周期的具名对象。模块级缓存、单例、全局 `WeakMap`，以及 `Symbol.for` / `globalThis` / `window.__X__` 旁路都会把这个所有者藏起来，并活得比任何一次清理都久。

判定条件：说出拥有该值的服务或实例；说不出所有者时，先定所有者再实现。边界是：服务或实例上的字段可以被任意多个注入方读取，跨域传递走既有接口而不是全局命名空间。没有默认例外；确需全局检索键时须经对应领域专家确认，并一并给出回收策略。

```ts
// The shared value hangs on the session service instance; consumers inject it.
interface Sessions { readonly current: string }
declare const ctx: { get(name: 'sessions'): Sessions }

const sessions = ctx.get('sessions')   // one owner, lifetime tied to the service
```

```ts ignore-check
globalThis.__dshCache = new Map()   // shared across instances, reclaimed never
```

反例让实例之间互相覆盖、回收时机不可控，并让状态在测试之间泄漏。

<a id="a-business-capability-owns-itself"></a>

## 业务能力自己拥有自己

业务能力住在自己的包里，经注册面接入——registry、`slots.inject`、waterfall 或事件订阅。runtime、controller、manager、gateway 承载通用编排：它可以持有注册表结构与 disposal 生命周期，但条目由拥有它们的包写入，且绝不硬编码一张业务中心表。

先确定新增的区分、字段或适配器是否必要，再选择其所有者；移动不必要的概念并不能消除维护成本。对于必需的行为，如果局部实现只增加少量复杂度，就优先使用靠近生产者或消费方的现有扩展点。生产者可以在自己的包内通过[声明合并](../subsystems/core.zh.md#the-map--derived-union-pattern)声明功能专属变体，无需修改声明该共享类型的包。所有消费方共同依赖的义务由共享所有者负责。

判定条件是：该能力是否由业务包自己声明并注册，中心层只做转发与生命周期管理、不做业务判定。边界是：中心层持有注册表结构与 disposal 生命周期，条目来自拥有它们的包。一条例外：纯基础设施能力——日志、传输、存储——不经业务注册面接入。中心层新增分支必须说明它为何无法下沉到业务包。

```ts
// The business package registers its own slot and handlers in its apply.
interface Slots {
  inject(name: string, register: () => void): void
  register(name: string): void
}
interface Context { readonly slots: Slots }

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.footer', () => ctx.slots.register('conversation.footer'))
}
```

```ts ignore-check
if (pluginName === 'ui-attachment') { /* business branch inside the manager */ }
```

反例让每个新能力都要改中心层，中心层随即成为变更瓶颈与冲突热点。

<a id="changes-carry-performance-evidence"></a>

## 改动要附带性能证据

可能改变热点路径成本的改动，要测量它所触及的代码在改动前后的表现，并把数字与测量条件一并给出。三项指标是运行耗时、内存峰值与稳态内存，在同一环境、同一输入下测量；粒度是**被改动的那条路径**，不是整机跑分。只报「整体没变慢」不算证据，别处变快也不能抵消这里的倒退——优化了首屏，仍然要回答 `append` 是否倒退。

判定条件：同一环境、同一输入下，改动后那条路径的三项指标中任一项显著变差。

基线是被测路径**不带本次改动**的形态——通常是不挂测量 hook 的原生实现，而不是旧实现。新旧两侧挂着同一个 hook、共同开销把真实差值稀释掉，测量就会报告「没变化」，而实际上两边一起慢。

测量的正家是 [benchmarks/](../../benchmarks/AGENTS.md)，按被测用户路径分目录，它的场景就是入口：

```sh
# Run the owning scenario before and after the change; the numbers go into the PR.
pnpm run test:bench
```

包内诊断留在包旁边、用 `.perf.ts` 后缀，不进 `test:bench`。CI 门禁是 `pnpm run check:ci:bench`（作业 `node 24 / benchmarks`），产出 scaled report——该门禁只是**报警**，不是通过依据：出现退化时重跑对应场景并本地分段 profile，定位是哪一段变慢、哪次变更引入。内存留存类结论用 `pnpm run test:bench:memory 4g|8g`，它会在无 swap 的 cgroup 里以不变预算重跑其列出的文件。

边界：不触碰运行路径的改动——注释、文档、仅测试代码——不需要测量；生产性能代码不是可以顺手删掉的 benchmark instrumentation（`performance.now()`、`scheduler.yield()` 属于生产 decode/encode 分片调度的一部分）。架构调整确实要付出性能代价时，写明实测代价与理由，并由对应领域专家确认；「分层需要」不是自助理由。命令、数字、环境与输入规模都要落账，以便返工时重建同一基线。

```text
CI benchmark reported green, so the change is accepted as performance-neutral.
```

这种写法会把 benchmark 未建模路径上的真实退化直接放行。

<a id="migrations-preserve-behavior"></a>

## 迁移保持行为

迁移或拆包保持对外可观测行为全等：错误码、诊断信息、数据流顺序与 UI 时机逐项比对。优先搬运代码而不是删了重写；重写适用于本来就要改语义的代码，且此时要在改动里列出差异。包或导出路径变化属于载体变化而非行为变化，行为变化则是独立的一刀。

判定条件是改动前后可观测行为的逐项比对。无法做到完全全等时，改动要写明差异项与各自的验收方式，并由对应领域专家确认。迁移过程中发现的缺陷按其自身另开一刀，不并入这次搬运。

```sh
# The move keeps paths and error codes; the reference updates are the whole diff.
git mv packages/old/src/endpoint.ts packages/new/src/endpoint.ts
```

```ts ignore-check
// The migration silently upgrades the error handling it was only supposed to move.
throw new EndpointError('not found')   // was: return { ok: false, code: 'not_found' }
```

反例把行为变化埋进搬运里，评审无法把位置移动与语义变化分开，回归也就无法定位。

<a id="dispose-must-reach-quiescence-not-just-request-it"></a>

## dispose 必须达到完全停稳，而不仅仅是请求停止

发出终止或中止信号后，应等待子进程退出。可选通知可以提前停止；完成清理或最终持久化所需的资源和监听器必须保留到消费方结束。参见 [Cordis 所有权检查](../../.agents/skills/cordis-styling-nitpicking/SKILL.md#p0-cleanup-dependency-released-before-consumer-completion)。

判定条件是清理是否等待到真正停稳，而不只是发出请求。边界是没有可等待归属的工作——无人观察的游离任务——清理逻辑没有义务追踪它；但组件自己启动、且仍能观察到的工作，必须在它报告完成之前等待完毕。

<a id="contain-callback-exceptions-in-the-dispatcher"></a>

## 在分发器中隔离回调异常

逐个捕获并报告监听器的异常，不让分发 promise 被 reject，也不让后续监听器失去执行机会。监听器的所有者必须按[错误处理规范](../../.agents/skills/dsh-error-handling/SKILL.md#catch-recover-or-stop)处置其修改的状态；仅捕获异常不会恢复状态。

判定条件是：抛异常的监听器是否能让分发 promise 被 reject，或让其后的监听器不再运行。边界是调用方自己的 await——分发器有意抛给发起该操作的那条路径的错误，不属于隔离失败。

```ts
async function dispatch(listeners: ((event: string) => Promise<void>)[], event: string): Promise<void> {
  for (const listener of listeners) {
    try { await listener(event) } catch (error) { console.warn('listener failed', error) }
  }
}
```

<a id="never-hand-untrusted-output-the-ambient-environment-or-predictable-paths"></a>

## 绝不将环境变量或可预测路径暴露给不可信输出

启动的命令应使用经过清理的环境变量，移除名称匹配 `*KEY*`、`*SECRET*`、`*TOKEN*` 或 `*PASSWORD*` 的项，防止 harness 凭证通过命令输出、`env` 或 spill 文件泄漏。临时文件和 spill 文件应放在权限为 0700 的私有目录中，使用随机文件名，并以独占且仅所有者可访问的方式打开（`'wx'`、`0o600`）；可预测且全局可读的路径会引发符号链接竞态和信息泄露。

判定条件是：启动的进程是否继承环境变量，或是否写入别人可以预测并替换的位置。边界是不接受外部输入的受信进程内代码，本条不约束它。

<a id="unlink-link-shaped-paths"></a>

## 用 unlink 删除链接形态的路径

可能是符号链接或 Windows junction 的路径，应先用 `lstatSync().isSymbolicLink()` 判断，再用 `unlinkSync` 删除：unlink 只删除链接本身并拒绝真实目录，因此绝不会跟随链接进入其目标。Windows 上对 junction 调用 `rmSync(link)` 会抛 `ERR_FS_EISDIR`；递归删除可能穿过 junction 进入其目标。真实目录才使用带 `recursive` 的 `rmSync`。

判定条件是：所用的删除原语是否可能跟随链接进入其目标。边界是代码在自己拥有的目录里自行创建的路径，那里已知普通递归删除是安全的。
