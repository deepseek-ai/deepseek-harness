# Agent Note: the code-runtime-python fd-3 frame protocol

Status: implemented

CPython 代码运行时现在位于 `packages/experimental/code-runtime-python`（私有，npm 名 `@deepseek-ai/dsh-experimental-code-runtime-python`）；提升为发布包遵循 experimental-packages 决策。

[English](2026-07-31-code-runtime-python-fd3-protocol.md) | 中文

## Problem

`@deepseek-ai/dsh-experimental-code-runtime-python` 负责供 CPython code-runtime 提供方使用的 wire protocol。这样的提供方会在全新的 `python3 -I` 子进程中运行每个模型程序，并通过子进程 fd 3 桥接 binding 调用与完成值。Host 不能信任这条通道：模型代码可以完全访问 fd 3 并伪造任意帧，因此 host 必须把每个入站帧视为敌意输入，先校验并重建后才能读取。协议还必须承载无深度限制的 lossless JSON，因为 seam 的 `CodeJsonValue` 深度无界，而 `JSON.stringify` 和 `json.dumps` 都有递归深度限制。

这个私有实验包同时包含协议与 runtime 实现：`PythonCodeRuntime`（插件的默认导出）、`python3 -I` 子进程路径与 Python 侧 JSON codec 都在 `@deepseek-ai/dsh-experimental-code-runtime-python` 中。协议建立在[可移植标识符 seam](../../archived/architecture/2026-07-31-code-runtime-portable-identifier-seam.md)之上。

## Decision

`src/protocol.ts` 是 wire vocabulary 的 host 侧及其敌意帧编解码：

- **`validateChildFrame`** 对每个入站帧做形状校验并重建。编译期 union 在 fd 3 上毫无意义——伪造帧可携带 `null`、被污染的字段，或省略必需字段——所以每个被接受的帧都逐字段重建：伪造的额外字段绝不随行，非有限的 call id 绝不会被回显进 reply，垃圾返回 `undefined` 被丢弃，而不是在 host 的 message handler 里抛错。
- **`encodeJsonPlain` / `checkDoneValue` / `hasUnsafeIntegerToken` / `hasNonLosslessNumber`** 是 lossless-JSON 编解码器与计量器。它们迭代遍历（显式栈，非递归），使低于字节预算的深层值能完整穿越；`checkDoneValue` 把字节计量和数字无损性折进一次遍历，在新增入栈子节点之前就拒绝超预算 payload；字符串与 key 由非分配的转义尺寸扫描（`jsonStringBytesUpTo`）计量，从不物化转义副本。它不会重新约束帧自身的宽度：`done.value` 在检查运行时已经过 `JSON.parse`，因此消费 runtime 必须在解析前限制 fd-3 字节数。超出安全范围的整数型 double 通过 `BigInt` 数字序列化，穿越的是精确整数而非 `String()` 的舍入形式。
- **`logTruncationMarker`** 产出日志 ledger 耗尽字节预算时发出的带内标记文本。

`py/protocol.py` 用 `TypedDict` 镜像消息形状，并重新声明两侧都会 EXECUTE 的两个面——`PROTOCOL_FD = 3` 与 `log_truncation_marker`——文本逐字节一致。

该包随协议一起交付 runtime，同时保持独立可构建。`check-workspace-constraints` 会无条件读取每个 `packages/<group>/<pkg>/package.json`，coverage 与 invariant-topology 检查则会在包目录存在时立即覆盖该包。

## Wire contract

帧是 fd 3 上的 JSON-lines，每行一个对象，让 stdout/stderr 空出给程序自己的输出。Child → host：`boot-ack`、`call`、`log`、`done`。Host → child：`boot`（首帧）、`run`（在 `boot-ack` 之后）、以及每个 `call` 对应一个 `reply`。`log` 帧的 `truncated` 标志标记那个本身就是子进程 ledger 截断标记的帧，使 host 在与子进程相同的点停止捕获，而不是从自己的预算去推断。`log` 帧的 `open` 标志标记由显式 flush 提交的未结束行：宿主持有它并把下一个帧追加到同一条目，因此显式 flush 后接更多文本读回为一行而不是假换行。唯一例外是截断：当后续超预算帧触发账本时，已计费的前缀作为独立条目先提交，截断 marker 跟在后面（marker 保持末位，无重复计费）。合并条目的线上成本恰好计费一次，在两侧按片段增量分摊（k 个片段 O(k)，绝不对整个持有重走）：首片段付完整 JSON 字符串成本加分隔符，每个续接与闭合帧只付内容；宿主精确成本 cap 是首片段 `logBudget - 1`（账本预留字节，与 `admit` 一致）、续接或闭合帧 `logBudget + 2`（不含两个引号计费），且 `jsonStringCostUpTo` 在低于 2 字节 cap 时返回 `undefined`；子进程按 `_open_started` 单独键控拆分计费，因此闭合帧按合并尾部计费。`done.error.kind` 是 `exception`、`invalid-output`、`output-limit` 之一；wall/CPU 预算、abort、substrate 死亡都在 host 侧观测，不作为帧携带。

## Mirror alignment

`py/protocol.py` 与 `src/protocol.ts` 一致规定：`LogMessage` 携带 `truncated`，`DoneMessage.error` 携带 `kind`，`Namespace` 可以携带 `errorClass`。`tests/protocol-mirror.e2e.ts` 启动真实 `python3`，对照 `src/protocol.ts` 断言 `PROTOCOL_FD`、`log_truncation_marker` 以及每个 `TypedDict` 的必填和可选 wire 字段集。字段改名、删除或必填／可选性不一致都会使测试失败。字段*类型*不跨语言边界比较；这项缺口由评审和 runtime 的真实子进程套件（`runtime.spec.ts`）负责。

## Alternatives considered

**要求未来的 Python JSON codec（`_encode_json_plain` / `_decode_json_plain`）放进 `py/protocol.py`，以便与 `protocol.ts` 跨侧对称。**拒绝。仓库的 “prefer symmetry for parallel values” 规则指向真正平行的值；这两者不是。`protocol.ts` 中的 host 侧 codec 校验敌意输入且自包含。Child 侧 codec 会产出受信任输出，应与 bootstrap 拥有的发出逻辑和成本核算放在一起；只把入口强塞进 `protocol.py` 会让 vocabulary 镜像耦合 runtime 内部实现，或制造 import 环。`protocol.py` 保持纯 wire-vocabulary 镜像；codec（`_encode_json_plain`／`_decode_json_plain`）与它所服务的 runtime 一起位于 `bootstrap.py`。

**在 runtime 交付前把协议文件放在不可构建的包外。**拒绝：workspace-constraint、coverage 与 invariant-topology 检查要求 `packages/<group>/<pkg>` 下的每个目录都是可构建包，而协议本身拥有独立测试与公开 wire vocabulary。

## Consequences

收获：fd-3 协议及其敌意输入 codec 构成自包含、unit 全覆盖的一层，并由执行中的 guard 防止 TypeScript／Python 字段集漂移。基于它构建的 runtime（`bootstrap.py`）消费经过评审的 wire contract。

代价：包名表示 Python runtime 家族，而 `src/index.ts` 导出完整的 `PythonCodeRuntime` 实现，协议 vocabulary 只是包表面的一部分。mirror e2e 会比较两侧字段名与必填／可选状态，但不比较字段类型；跨 TypeScript 与 Python 比较类型声明没有机械等价物，因此评审与 runtime 的真实子进程套件继续负责这项检查。
