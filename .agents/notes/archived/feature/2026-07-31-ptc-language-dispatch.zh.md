# Agent Note: PTC mode 语言分发与 Python SDK 渲染器

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-ptc-language-dispatch.md) | 中文

## 问题

PTC mode 只生成一种 SDK 形态：TypeScript。`ToolRuntime` 为 `tools:sdk` 段硬编码了 `renderToolsSdk`，且 `requireCodeRuntime` 会拒绝任何 `ctx.codeRuntime.language !== 'typescript'`。引入 CPython 后端后，程序的源语言不再固定：同一个可见工具注册表在加载 Python 运行时时必须投射出 Python SDK，而面向模型的 `run_code` schema 字符串（"Execute a Python program …"）也必须与 SDK 段的语言一致，模型才不会在 Python 运行时下看到 TypeScript 指令。

这是多语言 PTC mode 拆分中面向工具的那一半；[代码运行时 seam](../../../../packages/code-runtime/code-runtime/README.zh.md) 已经携带 `CodeRuntime.language`。本 Note 只负责 `dsh-tools` 如何在该字段上分发。实现 `language: 'python'` 的后端由它自己的 Note 负责，单独交付。

## 决策

语言选择就是对 `ctx.codeRuntime.language` 的查表，在提示词装配时惰性解析，查 `dsh-tools` 里两张平行的表：

- `SDK_RENDERERS`（index.ts）把语言映射到它的 `tools:sdk` 渲染器——`typescript → renderToolsSdk`、`python → renderToolsSdkPy`。`tools:sdk` 段读取所加载运行时的语言并选出渲染器；`requireCodeRuntime` 拒绝其语言不在表中的 `mode: ptc`/`both` 运行时，并列出已知语言。
- `RUN_CODE_FLAVORS`（ptc.ts）把语言映射到它那两条面向模型的 `run_code` 字符串（工具 `description` 与 `code` 参数描述），使一种语言的 SDK 段与它的传输 schema 始终一致。

两张表在使用前都以 `Object.hasOwn` 读取，这样名为 `toString`/`constructor` 的语言不会把继承自 `Object.prototype` 的成员解析成渲染器。两个守卫的可达性不同：`SDK_RENDERERS` 的回调内守卫不可达，因为 `requireCodeRuntime` 已在同一回调更早处校验过同一张 `const` 表（它带 `/* v8 ignore */`）；而 `RUN_CODE_FLAVORS` 的守卫是主要的、可公开到达的拒绝路径——任何缺席 flavor 表的语言都经 `run_code` 的语言感知 getter 到达它，而公共 `schemas()` 抵达那些 getter 时并未先过 `requireCodeRuntime`；测试直读 definition 上的其中一个 getter，用的是对两张表都缺席的语言。「在 `SDK_RENDERERS` 里却不在 `RUN_CODE_FLAVORS` 里」这种漂移已由共享的 `CodeSdkLanguage` `satisfies` 在 `typecheck` 处拒绝，两个守卫都看不到这种输入；它们如今负责的是所挂载运行时报告了一门两张表都缺席的语言。schema 发射通过 `peekRuntime()` 而非 `requireRuntime()` 读取运行时：`undefined`（无运行时，由直读 definition 的读者与 `schemas()` 到达，其中 doc-catalog 采集是唯一已交付的一个，而它们都不会喂给模型，因为组装路径先过 `requireCodeRuntime`）降级到 TypeScript flavor，而挂载了未知语言则 fail loud——这不是下方被否决的静默回退，那指的是为真实运行时发出错误语言的 SDK。新增一门后端语言是三处并列编辑——一个 `CodeSdkLanguage` 成员加两条表项——再加它的渲染器，以及点名已知值而非从中派生的散文（seam 侧的 `dsh-code-runtime` README 双语对、它的 `CodeRuntime.language` JSDoc 与 `docs/subsystems/code-runtime.md` 双语对；本包自己的 README 双语对与它的 `Config.mode` JSDoc，无任何 gate 检查其中任何一处），不动 `agent-loop`，也不动注册表结构。

`ptc.ts` 只依赖运行时 Service Definition（`@deepseek-ai/dsh-code-runtime`），绝不依赖具体后端；分发在运行时按 `runtime.language` 进行。因此工具层独立于 Python 协议和后端——它只需要服务的 `language` 字段。

### Python SDK 渲染器

`py-types.ts` 渲染 `jsonSchemaToTs` 所覆盖的同一套统一工具 schema 词汇，目标为 Python：`jsonSchemaToPy` 为每个 JSON-schema 节点发出一个类型表达式，`renderToolsSdkPy` 为每个可见工具的参数与规范输出装配具名 `TypedDict`，再加一个带用法说明的 `tools` 对象，与 TypeScript 形态等价。不支持的原始构造在装配时降级而非抛错，与 TypeScript 渲染器的约定一致。输出是确定性的——工具按字典序排列，工具集不变时文本逐字节相同——因此提示词保持 prefix-cache 友好。字典序意味着单一有序的成员流：名字不是合法属性的工具以 `tools[name]` 注释出现在它排序后的位置上，而不是被分拣到末尾，与 TypeScript 形态就地为异常键加引号的做法一致。这个成员流直接决定了一件事：注释行不是语句，所以一个不发出任何方法的工具集仍需显式 `pass`。另有三条规则并非源自排序，而是 Python 特有。其一，用法约定声明这些声明只是静态存根、参数为普通 `dict`/`list` 值：`TypedDict` 读起来像一个可构造的类，模型若写 `FooArgs(field=1)` 会得到 `NameError`——TypeScript 的 `interface` 一眼就是类型，且 TS 形态的「runs type-stripped」一句已经覆盖了它。其二，描述会成为方法的 docstring，且必须作为方法体的**第一条语句**发出：放在 `async def` 之上，第一条会变成 `Tools` 的类文档、其余都是无效果表达式，导致每个方法都没有文档。其三，`list[…]` 链超过 `MAX_LIST_NESTING` 后降级为 `Any`，因为 CPython 的 tokenizer 拒绝一行中超过 200 个同时未闭合的括号，而这个块必须是可解析的 Python——与 `docLines` 转义引号和反斜杠是同一个理由。`ts-types` 两者都不需要：TypeScript 会把前置的 `/** … */` 附着到其后的成员上，其语法也不对嵌套设限。

该上限服务的标准是**语法合法性**，这条边界是有意划定的：长的 `A | B | …` union 在任何长度下都是合法 Python，故不设上限——尽管 CPython 的 `compile()` 在沿左嵌套 `BinOp` 脊柱下降时会耗尽 C 递归（在 3.9 上实测：1,000 个分支可编译，5,000 个抛 `RecursionError`）。没有任何东西会编译这个块——它是提示词文本——所以那条限制在这里没有代价；而给 union 长度封顶会作废那几个钉住 walk 线性时间与类名传播上限的深链测试。将来若有渲染器确实需要可编译的输出，应当把 union 拍平，而不是截断。

`renderType` 先用 `assertSupportedJsonSchema` 整树校验一次、随后信任它，用单个 `try/catch` 把整个遍历兜住并降级为 `Any`——与姊妹渲染器 `ts-types` 在这个 typed 同进程边界上采取的「校验后信任」姿态一致（[Trust TypeScript at typed same-process boundaries](../../../../AGENTS.md)）。它有意不设任何针对「访问器在多次读取间变值」的防御（校验后成环、`const`/`enum` 的 TOCTOU、自引用函数）：输入是第一方注册（`defineTool` 字面量或 raw 注册）或从 wire 桥接而来的纯 JSON schema——前者按 AGENTS.md 受信任，后者是 `JSON.parse` 产物、物理上不可能携带访问器，且每次调用 `renderType` 都会整树重新校验——这类输入不可达，而在此加逐形态守卫会为静态接口所禁止的值破坏与 `ts-types`（没有这类守卫）的对称。`jsonSchemaToPy(schema: unknown)` 接受 `unknown` 并对畸形 schema 返回 `Any`——TypeScript 形态 `unknown` 的对应物——但它的约定是「降级不支持的 schema」，而非「扛住对抗性的可变 schema」。

## 考虑过的替代方案

- **在 `ToolRuntime` 上加一个 `language` 配置字段。** 那样部署方就会有两处命名语言（所加载的运行时与 tools 配置）且可能相互矛盾；所加载的运行时是唯一真源，故注册表读取它而不复制它。
- **把 Python 后端 import 进 `ptc.ts` 来检测它。** 那会把工具层耦合到具体后端，并迫使协议/后端 PR（Pull Request）先落地。按 `language` 运行时分发使该层保持后端无关、可独立发布。
- **为未知语言提供默认渲染器。** 静默回退会在比如 Ruby 运行时上发出 TypeScript SDK——模型会看到错误语言的指令。在装配处 fail loud 是本仓库对错误配置的立场。

## 后果

新增一门后端语言是三处并列编辑——一个 `CodeSdkLanguage` 成员、一个 `SDK_RENDERERS` 表项、一个 `RUN_CODE_FLAVORS` 表项——再加第二处所指向的渲染器函数，不动 `agent-loop`，也不动注册表结构。两张表（`SDK_RENDERERS`、`RUN_CODE_FLAVORS`）必须同步，且这条不变式由静态检查把关，而非交给 review：两张表都以 `satisfies` 对上述同一个 union 校验，因此只加其一而漏掉另一会在 `typecheck` 处失败。这正是该漂移风险应有的机械形式——运行时的 `Object.hasOwn` 守卫同样能捕获，但要等到有后端报告该语言之后：触发点在消费方的集成处而非漂移引入处——而只要不存在第二个后端，就永远不会触发。两张表的声明类型仍是 `Record<string, …>`，因为 `CodeRuntime.language` 是不受约束的 `string`：union 钉住 harness 交付了什么，守卫拒绝运行时报告了什么。落在这条检查之外的是点名已知值而非从中派生的散文：seam 侧的 `dsh-code-runtime` README 双语对、它的 `CodeRuntime.language` JSDoc 与 `docs/subsystems/code-runtime.md` 双语对，再加本包自己的 README 双语对与它的 `Config.mode` JSDoc。更早的 note 点名这些值时记的是当时的状态，不在此列。让它无 gate 的是两条独立理由。其一，散文根本不受类型检查，union 放在哪里都一样。其二，类型级替代在这里也不可用：Service Definition 包不得 import 其消费方的表，而 `CodeRuntime.language` 按设计保持不受约束的 `string`，即便把 union 迁进 Service Definition 也不会作用到它。用一个断言两张表键集相等的 unit test 的方案被否决：它买到的是同一条检查，代价却是把两张私有表做测试专用导出，且运行时机晚于编译器。对两张表都缺席的语言，两种运行时失败中报出哪一条随入口而异：组装路径报缺渲染器，因为 `wireSchemas` 在投影前先调 `requireCodeRuntime`；而公共 `schemas()` 先经过 `run_code` 的语言感知 getter，报的是缺 flavor 表项。工具层不依赖任何具体后端，因此它能先于 Python 协议和后端交付并可测。

代价是两张表的 Python 分支在已交付的代码树中不可达：`CodeRuntime.language` 由所加载的后端设定，已发布的后端只有 `dsh-code-runtime-worker-thread`（`'typescript'`），而注册表读取的是所加载的运行时而非某个配置字段，因此没有任何一份组装好的应用能选中 `renderToolsSdkPy` 或 `PYTHON_FLAVOR`。也就是说，在报告 `'python'` 的后端发布之前，本 note 的工作不改变模型可见表面，本变更的覆盖因此是 unit 级——渲染器输出加分发与拒绝路径。Python 模型界面的 keyless 快照归属于发布该后端的那个变更，因为只有在那里，一份基于已发布插件的真实 `cordis.yml` 才会产出 Python 组装；在此处挂载 fixture（测试前置数据）运行时的快照示例断言的是测试替身，而 [docs/testing.md](../../../../docs/testing.zh.md) 明确拒绝以此替代组装好的应用 transcript（文本记录）。

Python SDK 文本断言的两条运行时约定同样归属那个后端 PR。其一，说明文字告诉模型运行时恰好绑定 `tools` 与 `ToolCallError` 两个名字、所声明的 `TypedDict` 类不绑定，因此后端必须注入这两个名字（并按 seam 的 `errorClass` 约定填充 `ToolCallError.toolName`），且**不得**把所声明的类名绑进程序全局——「好心」注入会使这段 SDK 文本变成假话。其二，语言必须绑定到请求上：`requireCodeRuntime` 在组装时与 `run_code` 执行时分别解析 `ctx.codeRuntime`，若在这两点之间发生重载并换掉运行时，就会把针对一种形态写成的程序交给另一种形态执行。分裂比这两点更细——`run_code` 的 `description` 与 `parameters` 两个 getter 各自调用 `resolveFlavor(peekRuntime())`，而 `schemaOf` 会解构这两个字段，因此一次投影读两次运行时；两次都属于 `run_code` 自己的 schema，因为这两个 getter 只装在那一个 definition 上，其余 definition 携带的都是普通数据属性。在这两次读取之间重载会产出单个 schema 的两半分属不同语言。两者在此处都不可达——只有一个已发布后端意味着两次读取返回同一形态，且没有任何程序会针对本渲染器的输出运行——而跨语言拒绝在第二门语言存在之前也无法测试。

其三，那个 PR 拥有 CPython 版本下限，连带拥有本渲染器的 Unicode 表偏斜。有四处表达式读所运行引擎的表（Node 22.23.1：Unicode 17.0），而解释器用它自己的表（CPython 3.9.6：13.0.0）：`isBareIdentifier` 的 `IDENTIFIER`，以及 `camelCase` 的切分集、头部测试与 `toUpperCase()`。解释器旧于引擎是会失败的那个方向——引擎发出的字符被其 tokenizer 拒收，整个块随之不可解析——而它经三条独立路径抵达。经判据抵达的是不加引号发出的方法名或字段名，其中带有一个在两个版本之间新增的字符——首位加进 `XID_Start`，或尾部任意位置（含名字中部）加进 `XID_Continue`。经 `camelCase` 的 XID 读取抵达的是类名：只要工具 schema 中有任一对象形态声明 `TypedDict`，该类名就进入发出的文本，且判据对工具名的裁决并不对它设闸——工具名 `zz-` 加 U+1E4D0 因 `-` 被判据直接拒绝、从不触及那里的偏斜，却照样声明 `class Zz𞓐xArgs`。经大写映射抵达的是由判据已接受的工具派生出的类名——这是另一张表，窗口也比 XID 归属更宽：U+019B 既是 XID_Start 又 NFKC 稳定，故 `async def ƛ` 在 3.9.6 上可编译，但 Node 将其大写为 U+A7DC（在那里未分配；CPython 自己的 `.upper()` 在此是恒等），于是 `class ꟜArgs` 以 `invalid non-printable character U+A7DC` 失败。暴露窗口是两个版本之间发生变化的那些字符与映射，所以宣布支持某个 CPython 范围的那个 PR 必须在「接受该暴露」与「按该下限的表钉住全部四个读取点」之间显式作出决定——只钉判据会同时留下两条类名路径。此处无法决定：下限尚不存在，而按猜测钉死一张表会成为一个随部署而变、却没有可配置性支撑的常量。还有第二条轴随该下限一同确定，且不属于那四个读取点：本块在定义期会被求值的那些名字与语法。`TypedDict` 需要 3.8，PEP 585 的内建泛型 `dict[str, Any]` 与 `list[…]` 需要 3.9，`A | B` 形式的注解需要 3.10，`NotRequired` 需要 3.11。这些不是解析失败——本块在任何版本上都能解析，这正是 `MAX_LIST_NESTING` 上限所服务的标准——而是定义期求值失败，且产品中没有任何东西会求值这段文本。把它们与那四个读取点记在一起，可避免把「在所支持范围上可解析」读成「在其上可执行」。
