# Agent Note: CPython 后端的加载期 pythonBin 校验、binding 快照与回复排空结算

Status: implemented
Archived: 2026-09-04

[English](2026-08-29-code-runtime-python-load-and-dispatch-hardening.md) | 中文

## Problem

对 CPython 子进程后端（packages/experimental/code-runtime-python）的评审浮出四项非阻断发现，在长驻宿主上仍可能表现异常：显式 `pythonBin` 路径绕过加载期配置校验；抛错的 binding 成员访问器可能逃出 fd-3 data 回调并终止宿主；回复排空可能永远等待一个已销毁管道不会再发出的 `drain` 事件；两处泄漏断言对全局 tmpdir 做差集，并行 vitest worker 可能误报。

## Decision

### 显式 pythonBin 在加载期必须是可执行的普通文件

`resolvePythonBin` 对绝对路径或含斜杠的 `pythonBin` 原样返回，因此不存在、不可执行或指向目录的路径能通过构造器的加载期检查（只拒绝空串/NUL 值与无法解析的裸名），直到首次 `run()` 才以误导性的 `worker-exit` 暴露。显式路径分支现在复用 PATH 分支所用的 `accessSync(X_OK)` + `statSync().isFile()` 检查（目录也能通过 `X_OK`，因此普通文件要求是起决定作用的一半），先把相对显式路径解析到宿主 CWD——与 `spawn` 会查找的位置相同。失败的显式路径使 `resolvePythonBin` 返回 `undefined`，加载检查现在在消息中区分两类失败：显式路径报 `is not an executable regular file`，裸名报 `does not resolve on PATH`。

### binding 可调用对象在校验期被快照

`namespace.functions` 由调用方提供，其成员可能通过 getter 或 Proxy 暴露。在 fd-3 `data` 回调中读取其中一个成员——`record[message.name]`——会在分发器 try 之外抛出并终止宿主（即使安装了 `uncaughtException` 处理器，运行也只会退化到墙钟超时）。`validateBindings` 现在在 run() 的同步校验段把每个成员读入一个普通自有属性记录，因此抛错的访问器变成 run() 为畸形 binding 预留的 seam-misuse 拒绝。该快照同时是 boot 帧宣告与分发读取的同一份键集，因此键随读取变化的 getter 无法让子进程被允许的名字与宿主实际调用的名字失步。记录采用无原型构造（`Object.create(null)`）：seam 契约把 `__proto__`、`constructor` 之类的成员名当作普通自有属性，普通 `{}` 对 `__proto__` 的赋值会命中原型 setter 而非创建自有属性，使该名字从 boot 帧消失、对其的调用以 `KeyError` 失败。

### 回复排空在管道已销毁时结算

`drainReplies` 在缓冲区满写入后 `await once(proto, 'drain')`；在等待期间被销毁的管道（子进程退出、close 截止时间拆卸）永远不会再发出 `drain`，而 `events.once` 只在 `error` 时拒绝、不在 `close` 时结算——该 await 可能永远挂起，使 `draining` 保持 true，未消费的队列（及其仍持有的宽 payload）随闭包滞留。等待现在同时监听 `drain`、`close` 与 `error`，任一事件胜出即移除全部三个监听器；排空循环在下一次写入前用 `proto.destroyed` 短路，因此 `finally` 会清空队列并复位 `draining`。

## Testing

- `tests/runtime.spec.ts`——加载拒绝用例覆盖不存在的绝对路径、不可执行的普通文件、目录与含斜杠的相对路径，各自断言 `is not an executable regular file` 消息；一个正向用例让绝对解释器路径通过加载并运行。一个 getter 在读取时抛错的用例断言 `run()` 以 seam misuse 拒绝；一个配套用例用计数 getter 断言访问器恰好被读取一次（快照），证明分发与 boot 帧共享快照。spawn 失败用例现在先暂存一个可执行 wrapper、加载 runtime、删除 wrapper，再断言运行仍 resolve 为 `worker-exit`（加载期合法的路径仍可能在运行期失败；旧 fixture 用的路径现在在加载期就被拒绝）。
- `tests/boot-write-failure.spec.ts`——一个 fake child 让每次 fd-3 写入都背压，并在宿主等待 `drain` 时销毁管道；运行在墙钟上结算，而不是挂在排空等待上。
- 两处暂存泄漏用例断言本测试文件暂存的确切路径（由被 mock 的 `mkdtempSync` 记录）已消失，而不是对可能被同级 worker 扰动的全局 tmpdir 做差集。

## Alternatives considered

**让显式路径分支不做校验，由首次 run() 报告。** 已拒绝：不存在、不可执行或指向目录的解释器路径是调用方无需运行程序即可修复的自包含配置错误，且空串/NUL 与裸名检查已确立这些应在加载期失败的先例。它产生的运行期 `worker-exit` 也与子进程故障无法区分，调用方无法分辨配置错误与环境问题。

**在分发路径内守卫成员访问，而非快照。** 已拒绝：在 `record[message.name]` 周围加 try 仍会在每次调用时读取 getter，重复其副作用，并允许其键集在 boot 帧宣告与分发之间不一致。在校验期快照一次，把抛错转化为 run() 已预留的 seam-misuse 拒绝，并把键集固定为同一份记录。

**给排空等待加超时。** 已拒绝：超时会在管道可能仍存活时结算等待，丢弃一个仍可被存活的管道接收的排队回复。监听 `close`/`error` 恰好在管道消失时结算，这是 `drain` 永远不会到达的唯一情形。

## Consequences

加载期现在更早地拒绝一个自包含配置错误（非可执行普通文件的显式解释器路径），与裸名的处理一致。binding 成员访问器在校验期被读取一次，getter 的副作用不会逐次调用重复。已销毁的 fd-3 管道不再搁浅回复排空。泄漏断言对同级 worker 的并发暂存免疫。
