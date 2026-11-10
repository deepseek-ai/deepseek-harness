# Agent Note: 保留状态 PTC 的 scoped REPL 求值器

Status: implemented

[English](2026-11-09-retained-ptc-scoped-repl.md) | 中文

## 问题

`persistent-in-memory` 用 node:repl 在同一个全局作用域里执行同一个 Agent 的每次 `run_code`（[尽力保留 PTC 状态](../../implemented/architecture/2026-09-23-best-effort-persistent-ptc.zh.md)）。模型在后面的调用里再次声明前面用过的 `const`、`let`、`class` 名字时，V8 在执行前就报 `SyntaxError: Identifier 'x' has already been declared`，整段代码一行都不执行。模型说明只能要求"不要重复声明"，但模型在多轮调用里很难记住每个名字。

把声明改成 `var` 能消除报错，但所有调用共用同一个绑定，后面的声明会改掉前面的函数、闭包和后台任务读到的值：

```js
// call 1
var value = 1
var read = () => value
// call 2
var value = 2 // no error
// call 3
read() // 2: call 2 changed the read written by call 1
```

需要同时满足五条要求：

1. 后面的调用可以用任意关键字再次声明前面的名字，不报错。
2. 再次声明只对这次和之后的调用生效；前面的函数、闭包和仍在运行的代码继续使用它们原来的值。
3. 写法与现有 REPL 一致：支持顶层 `await`，最后一个表达式的值是结果，不支持顶层 `return`。
4. 异步回调里的错误与现有 REPL 一样处理：进程不退出，变量保留。
5. 不做作用域分析，不改写模型代码里的声明和引用；acorn 只用来列出顶层声明、找到最后一条语句。

## 决策

scoped REPL 求值器分成内核和求值器两个文件：

| 文件 | 内容 |
|---|---|
| `packages/ptc-runtime/ptc-runtime-node/src/evaluators/scoped-repl.ts` | 内核：作用域链 `ScopedReplScopes`，负责状态表、拷贝与退回旧值、重复声明、编译成 Script；以及 acorn 扫描、顶层声明与关键字、顶层 `return` 检查、最后一条表达式、保留名检查、语法错误格式化、拼源码 |
| `packages/ptc-runtime/ptc-runtime-node/src/evaluators/scoped-repl-evaluator.ts` | 求值器：导出 `createScopedReplEvaluator(options)`，实现现有的 `ProgramEvaluator` 接口，把内核接入现有模式：执行环境和开关、动态 import 与 import 处理器、由微任务启动程序并取完成值、domain、注入 `reportRedeclarations` |
| `packages/ptc-runtime/ptc-runtime-node/tests/scoped-repl.spec.ts` | 只测内核，可以单独运行：扫描、拼源码，以及在普通 vm context 里连续执行多段程序的作用域分层 |
| `packages/ptc-runtime/ptc-runtime-node/tests/scoped-repl-evaluator.spec.ts` | 测接入层：完成值、执行环境、模块与 import、报错、异步错误；三个开关打开、关闭两种状态都测 |

求值器以 `scoped-repl` 格式接入现有执行模式，见"接入"。

### 精确行为

#### 写法与结果

- 程序是一组语句，支持顶层 `await`。
- 最后一条非空的顶层语句是表达式语句时，它的值就是结果。值是 Promise 时不等待，Promise 本身就是结果，宿主会报 `program completion must be lossless JSON`，和现有 REPL 一样。这一项由 `finalExpression` 开关控制，默认开；关闭后末尾表达式的值被丢弃，结果只能靠打印，模型说明要随之调整。`run_code` 对 TypeScript 运行时传 `discardCompletion: true`，宿主丢弃完成值，模型用 `inspect(...)` 输出；不丢弃完成值的调用方（例如 workflow-ptc）仍以末尾表达式的值为结果。
- 最后一条是声明、`if`、`for`、块等其他语句时，没有结果。
- 顶层 `return`，包括写在顶层 `if`、循环和块里的，报 `SyntaxError: Illegal return statement`，这次一行都不执行。经 `run_code` 执行时，宿主的 TypeScript 擦除会先拒绝它，报 `Return statement is not allowed here`，和现有 REPL 相同。
- 静态 `import`、`export` 报 acorn 的 `SyntaxError: 'import' and 'export' may appear only with 'sourceType: module'`；顶层 `using`、`await using` 同样被 acorn 拒绝，块里和函数里可以用。
- 以 `#!` 开头的程序报 `SyntaxError: Hashbang lines are not supported`，这次不执行：`#!` 只能出现在 Script 的最开头，而生成的前缀排在程序前面。
- 输出是 `inspect(...)` 等打印的内容；调用方不丢弃完成值时，再加上末尾表达式的值。

#### 跨次调用

- 每次调用开始时，把前面留下的每个顶层名字拷贝成本次的同名声明；对象按引用共享，修改对象内部两边都看得到。
- 可以用任意关键字再次声明前面的名字，包括 `var`→`let`→`const`→`class`→`function` 依次换。本次用 `let`、`const`、`class`、`function` 声明的名字不再拷贝，以本次为准；只用 `var` 重新声明的名字照样拷贝，这次的 `var` 从旧值开始。
- 不声明、直接给前面的名字赋值，改的是本次的拷贝：之后的调用看到新值，前面定义的函数仍看到旧值。前面用 `const` 声明的名字也一样，它只在声明它的那次调用里不能赋值。
- 重定义函数后，前面定义的调用方仍然调用旧函数。
- 本次开始以后，前面的代码（定时器、回调）再给顶层变量赋值，之后的调用看不到；需要共享的可变状态放进对象。
- 前面定义的函数看不到后面才声明的名字，引用时报 `ReferenceError`。
- 一次调用用 `let`、`const`、`class` 重新声明了某个名字，这次调用里的所有引用都指向新声明，包括写在声明之前的，拿不到旧值：在声明执行前读取报原生的 `ReferenceError: Cannot access 'x' before initialization`。这类写法是代码本身的问题，不做处理。用 `var` 重新声明时，这次的 `var` 从旧值开始，直到被赋上新值，例如 `var count = count + 1` 在旧值上加 1；`function` 从调用开始就是新函数。
- 一次调用中途出错时：抛错前已经执行完的声明保留；重新声明了已有名字、但没来得及赋值的，之后的调用退回旧值；没来得及赋值的新名字直接丢掉。
- 块里（包括 `try`/`catch`/`finally`、`if`/`else`、循环体、`switch`、标签语句）声明的 `var` 会提升到这次调用的顶层，和顶层 `var` 一样算这次的声明：带到之后的调用，也可以和前面任何关键字声明的名字同名。嵌套的函数和类里的 `var` 不算。
- 没执行到的 `var` 再次声明，不论在抛错之后还是在没走到的分支里，都保留旧值；不带初始值的 `var x;` 也保留旧值。

#### 执行环境

下面是默认行为，前两项各由一个开关控制，见"执行环境与开关"。

- strict 模式：给未声明的名字赋值报 `ReferenceError`；有意的全局变量写 `globalThis.x`。开关关闭时不强制：程序以 `"use strict"` 开头，这次就按严格执行，否则按宽松执行。
- 禁止从字符串生成代码：执行环境自己的 `eval`、`new Function` 报 `EvalError`，从字节编译 WebAssembly 报 `CompileError`。这不构成隔离：从主环境复制进来的函数（例如 `setTimeout.constructor`）仍能在主环境里生成代码。
- 只能用动态 `import()` 加载模块，相对路径按这个环境第一次调用时的 working directory 解析，之后的调用换了目录也不变；不提供 `require`、`module` 和 `fs`、`path` 这类内置模块全局。读写文件的相对路径仍跟随当前目录。
- 顶层 `this` 是 `undefined`，按宽松执行时是 `globalThis`；顶层 `arguments` 是一个空的 arguments 对象，长度为 0。
- 顶层 `var` 和 `function` 不会成为 `globalThis` 的属性。
- `setTimeout`、`Buffer`、`fetch`、`URL`、`structuredClone` 等 Node 全局对象可用。

#### 报错

- 运行时报错的行号、列号是模型代码里的原生位置，跨次调用定义的函数显示它自己那次的文件名，例如 `<目录>/.ptc-repl-1.js:2:9`。最后一条表达式所在的那一行，插入点之后的列号右移 17，这次不处理。
- acorn 发现的语法错误直接报 acorn 的消息和位置，按 V8 的样式排版：文件名加行号、源码行、箭头。有两处消息改用 V8 的说法：顶层 `return` 报 `Illegal return statement`；报错位置在代码末尾时报 `Unexpected end of input`。
- acorn 放行、V8 编译时才发现的错误，报 V8 原生的消息；strict 开关打开时，严格模式的语法违规（例如 `with`）也在这一步报出。
- 以上是求值器自己的行为。经 `run_code` 执行时，宿主的 TypeScript 擦除先解析整段代码，多数语法错误由它报告，和现有 REPL 相同；只有擦除接受、扫描拒绝的代码（例如保留名、静态 `import`、顶层 `using`）才会看到上面的版式。
- 运行时错误报错误名加堆栈，没有 `Uncaught ` 前缀，堆栈里没有求值器自己的帧。

#### 异步错误与生命周期

- 程序启动的定时器、回调、Promise 后续步骤和 EventEmitter 抛出的错误，以及未处理的 rejection，不让进程退出，变量保留。例外：回调里 `throw` 的是冻结或不可扩展的对象时，Node 的 domain 在通知监听器之前给它加属性失败，进程结束，和 node:repl 相同；以这样的对象 reject 不受影响。
- 当时有执行在运行，就让那次执行以 `Uncaught ` 加错误文本失败；否则丢弃。错误文本取错误的 `stack`，`stack` 不是字符串时用"名字: 消息"；不是 Error 的值，先去掉 domain 加上的 `domain`、`domainThrown` 再用 `util.inspect`；转换出错时报 `program threw an unrenderable value`。错误按创建回调时所属的执行归属，前一次留下的定时器在后一次运行时抛错，不会算到后一次头上。
- 执行结束后才打印的输出被丢弃；超时、取消和重置沿用现有的宿主逻辑（[保留状态的 PTC 中断](../../implemented/architecture/2026-10-29-retained-ptc-interruption.zh.md)）。

### 与 node:repl、vm-script 的对比

✓ 表示支持，✗ 表示不支持，"—" 表示不适用：不开持久化的 `vm-script` 每次调用都是新进程，没有跨次状态。"持久化 vm-script"指设置 `scriptPersistence: true` 的 vm-script（#7992），"两种 vm-script"指它和不开持久化的 vm-script。"我们"一列是默认行为，括号里写和哪几列一致；执行环境一组把"我们"分成 strict 开启（默认）和关闭两列。跨次调用一组多列一项"预期支持跨次调用能力的一种实现"，括号和备注里简称"预期实现"。

**写法与结果**

| 能力 | node:repl（现有 REPL 求值器） | 我们 | vm-script（不开持久化） | vm-script（开持久化，#7992） | 备注 |
|---|---|---|---|---|---|
| 顶层 `return`，包括写在 `if` 块里的 | ✗ | ✗（与 node:repl、vm-script、持久化 vm-script 一致） | ✗ | ✗ | 都报 `Illegal return statement` |
| 末尾表达式作为结果 | ✓ | ✓（默认；与 node:repl、vm-script、持久化 vm-script 一致） | ✓ | ✓ | 可以用 `finalExpression` 开关关闭 |
| 末尾是 Promise 时等它完成 | ✗ | ✗（与 node:repl 一致） | ✓ | ✓ | 不等时宿主报"不是 JSON" |
| 以 `if`、`for`、块结尾时有结果 | ✓ | ✗（与 node:repl、vm-script、持久化 vm-script 含 `await` 时一致） | ✓ | ✓ | node:repl 和两种 vm-script 只在代码不含 `await` 时有结果 |
| 顶层 `await` | ✓ | ✓（与 node:repl、vm-script、持久化 vm-script 一致） | ✓ | ✓ | node:repl 和两种 vm-script 靠改写整段代码；我们只改写最后一条表达式 |
| 静态 `import` | ✗ | ✗（与 node:repl、vm-script、持久化 vm-script 一致） | ✗ | ✗ | 我们报 acorn 的消息 |
| 顶层 `using` | ✗ | ✗（与 node:repl、vm-script、持久化 vm-script 一致） | ✗ | ✗ | 块里和函数里可以用 |
| 以 `#!` 开头的程序 | ✓ | ✗（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✓ | ✓ | 我们报 `Hashbang lines are not supported` |
| 同一次里两个同名 `function`，或同名的 `var` 和 `function` | ✓ | ✓（与 node:repl、vm-script、持久化 vm-script 一致） | ✓ | ✓ | |
| 动态 `import()` | ✓ | ✓（与 node:repl、vm-script、持久化 vm-script 一致） | ✓ | ✓ | |

**跨次调用**

| 能力 | node:repl | 预期支持跨次调用能力的一种实现 | 我们 | vm-script | 持久化 vm-script | 备注 |
|---|---|---|---|---|---|---|
| 跨次保留变量 | ✓ | ✓ | ✓（与 node:repl、预期实现、持久化 vm-script 一致） | ✗ | ✓ | node:repl 和持久化 vm-script 共用一个作用域；我们靠拷贝；预期实现也靠拷贝 |
| 用任意关键字再次声明 | ✗ | ✓ | ✓（与预期实现一致） | — | ✗ | node:repl 和持久化 vm-script 的 25 种关键字组合里 21 种报 `already declared`，只有 `var`、`function` 之间可以；我们预留重复声明提示，暂不输出；预期实现对 `const` 再次声明为 `const` 多输出一行警告 |
| 后面不声明直接赋值，前面定义的函数不受影响 | ✗ | ✓ | ✓（与预期实现一致） | — | ✗ | |
| 不重新声明，直接给前面的 `const` 赋值 | ✗ | ✓ | ✓（与预期实现一致） | — | ✗ | node:repl 和持久化 vm-script 报 `TypeError`；我们不提示；预期实现先打印警告 |
| 用 `var` 重新声明时读到同名旧值（`var n = n + 1`） | ✓ | ✗ | ✓（与 node:repl、持久化 vm-script 一致） | — | ✓ | node:repl 和持久化 vm-script 只在前面也是 `var` 时成立，前面是 `let` 时报 `already declared`；我们前面是 `let`、`const` 时也成立；预期实现得到 `NaN` |
| 重定义函数后，旧的调用方仍调旧函数 | ✗ | ✓ | ✓（与预期实现一致） | — | ✗ | |
| 前面的代码之后改的值，后面的调用能看到 | ✓ | ✗ | ✗（与预期实现一致） | — | ✓ | 定时器自增的变量，间隔 30 ms 读两次：node:repl 23、50；持久化 vm-script 22、44；我们 0、0；预期实现 15、15 |
| 前面定义的函数能看到后面才声明的名字 | ✓ | ✗ | ✗（与预期实现一致） | — | ✓ | 我们报 `ReferenceError` |
| 修改对象内部，两边都看得到 | ✓ | ✓ | ✓（与 node:repl、预期实现、持久化 vm-script 一致） | — | ✓ | |
| 初始化抛错后，这个名字还能继续用 | ✗ | ✓ | ✓（与预期实现一致） | — | ✗ | node:repl 和持久化 vm-script 里新名字永久不可用，再次声明报 `already declared`；我们已有名字退回旧值，新名字丢掉 |
| 抛错前已经执行完的声明会保留 | ✓ | ✓ | ✓（与 node:repl、预期实现、持久化 vm-script 一致） | — | ✓ | |
| 抛错前没执行到的 `var` 再次声明，保留旧值 | ✓ | ✓ | ✓（与 node:repl、预期实现、持久化 vm-script 一致） | — | ✓ | 我们把旧值拷进这次的 `var`，没走到的分支里的 `var` 也保留旧值；预期实现靠插入标记代码做到 |
| 块里新声明的 `var` 带到下一次 | ✓ | ✗ | ✓（与 node:repl、持久化 vm-script 一致） | — | ✓ | 我们收集块里的 `var` |
| 块里的 `var` 和已有的 `let` 同名时不报错 | ✗ | ✗ | ✓（与 node:repl、预期实现、持久化 vm-script 都不一致） | — | ✗ | node:repl 和持久化 vm-script 报 `already declared`；我们把它算作这次的新声明；预期实现也报 `already declared` |

**执行环境**

| 能力 | node:repl | 我们（strict，默认） | 我们（非 strict） | vm-script | 持久化 vm-script | 备注 |
|---|---|---|---|---|---|---|
| strict 模式 | ✗ | ✓（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✗（与 node:repl、vm-script、持久化 vm-script 一致） | ✗ | ✗ | strict 关闭时，程序自己开头的 `"use strict"` 仍然生效 |
| 给未声明的名字赋值会创建全局变量 | ✓ | ✗（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✓（与 node:repl、vm-script、持久化 vm-script 一致） | ✓ | ✓ | 非 strict 时创建的全局变量由所有调用和前面的函数共用，不走拷贝 |
| 顶层 `var`、`function` 挂到 `globalThis` | ✓ | ✗（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✗（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✓ | ✓ | |
| 顶层 `this` 是 `globalThis` | ✓ | ✗（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✓（与 node:repl、vm-script、持久化 vm-script 一致） | ✓ | ✓ | 我们 strict 时是 `undefined` |
| 顶层 `arguments` | ✗ | ✓（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✓（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✗ | ✗ | 我们的是空的 arguments 对象 |
| `eval`、`new Function` | ✓ | ✗（默认；与 node:repl、vm-script、持久化 vm-script 都不一致） | ✗（默认；与 node:repl、vm-script、持久化 vm-script 都不一致） | ✓ | ✓ | 可打开；只限执行环境自己的，复制进来的主环境函数仍能生成代码 |
| 编译 WebAssembly | ✓ | ✗（默认；与 node:repl、vm-script、持久化 vm-script 都不一致） | ✗（默认；与 node:repl、vm-script、持久化 vm-script 都不一致） | ✓ | ✓ | 与 `eval` 同一个开关 |
| Node 全局对象（`setTimeout`、`Buffer`、`fetch`、`URL`、`structuredClone`） | ✓ | ✓（与 node:repl、vm-script、持久化 vm-script 一致） | ✓（与 node:repl、vm-script、持久化 vm-script 一致） | ✓ | ✓ | |
| `require`、`module`、`fs` 等内置模块全局 | ✓ | ✗（与 vm-script、持久化 vm-script 一致） | ✗（与 vm-script、持久化 vm-script 一致） | ✗ | ✗ | 只能用 `import()` |
| 相对路径的 `import()` 跟随之后的目录变化 | ✓ | ✗（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✗（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✓ | ✓ | 我们固定用这个环境第一次调用时的目录 |
| `_`、`_error` | ✓ | ✗（与 vm-script、持久化 vm-script 一致） | ✗（与 vm-script、持久化 vm-script 一致） | ✗ | ✗ | |
| 以 `{ a: 1 }` 开头的代码当对象字面量 | ✗ | ✗（与 node:repl、vm-script、持久化 vm-script 一致） | ✗（与 node:repl、vm-script、持久化 vm-script 一致） | ✗ | ✗ | node:repl 原本当对象，现有 REPL 求值器强制改成语句块 |

**报错**

| 能力 | node:repl | 我们 | vm-script | 持久化 vm-script | 备注 |
|---|---|---|---|---|---|
| 报错行列号准确（代码不含 `await`） | ✓ | ✓（与 node:repl、vm-script、持久化 vm-script 一致） | ✓ | ✓ | 我们的例外是最后一条表达式所在行 |
| 报错行列号准确（代码含 `await` 时的第 1 行） | ✗ | ✓（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✗ | ✗ | node:repl 和两种 vm-script 把第 22 列报成第 54 列 |
| 语法错误带源码行和箭头 | ✓ | ✓（与 node:repl、vm-script、持久化 vm-script 一致） | ✓ | ✓ | 我们按 acorn 给出的位置自己排版；这是求值器层的行为，经 `run_code` 时多数语法错误先由宿主的 TypeScript 擦除报告，与 node:repl 列相同 |
| 语法错误消息是 V8 的原文 | ✓ | ✗（与 node:repl、vm-script、持久化 vm-script 都不一致） | ✓ | ✓ | 我们用 acorn 的消息，acorn 放行、V8 拒绝的错误用 V8 原文 |
| 代码不完整时有明确提示 | ✗ | ✓（与 vm-script、持久化 vm-script 一致） | ✓ | ✓ | node:repl 的报错消息为空；经 `run_code` 时同样先由宿主擦除报告 |
| 报错带错误名和堆栈 | ✓ | ✓（与 node:repl、vm-script、持久化 vm-script 一致） | ✓ | ✓ | |
| 同步错误和 `await` 失败带 `Uncaught ` 前缀 | ✓ | ✗（与 vm-script、持久化 vm-script 一致） | ✗ | ✗ | |
| 异步回调错误带 `Uncaught ` 前缀 | ✓ | ✓（与 node:repl 一致） | — | — | 两种 vm-script 的进程直接退出，没有这类报告 |

**异步错误与生命周期**

| 能力 | node:repl | 我们 | vm-script | 持久化 vm-script | 备注 |
|---|---|---|---|---|---|
| 执行结束后回调里出错，进程不崩、变量保留 | ✓ | ✓（与 node:repl 一致） | — | ✗ | 持久化 vm-script 的进程退出，下一次调用报 `worker-exit`，变量全部丢失；不开持久化时执行结束后进程已关闭；回调里 `throw` 冻结的对象时，node:repl 和我们的进程都会结束 |
| 执行中回调里出错，只让这次失败、变量保留 | ✓ | ✓（与 node:repl 一致） | ✗ | ✗ | 两种 vm-script 的进程都退出，报 `worker-exit`，持久化 vm-script 的变量丢失 |
| 执行结束后才打印的输出被丢弃 | ✓ | ✓（与 node:repl、持久化 vm-script 一致） | — | ✓ | |
| 超时或取消后变量可以保留 | ✓ | ✓（与 node:repl、持久化 vm-script 一致） | — | ✓ | 前提是程序确认已经停住 |
数据来源：node:repl、vm-script 和持久化 vm-script 三列直接调用 master 的求值器实测（Node v24.18.0）。持久化 vm-script 用同一个求值器连续执行；一次调用内的各行与 vm-script 相同，跨次调用各行和两行异步错误单独实测，异步错误经真实子进程。"我们"一列的跨次调用各项由 `scoped-repl.spec.ts` 测试，其余各项由 `scoped-repl-evaluator.spec.ts` 测试。不开持久化的 vm-script 两行异步错误按现有实现推断；node:repl、持久化 vm-script 和我们的超时、取消、重置沿用同一套宿主逻辑。预期实现一列在该实现上实测，每个用例新开一个环境。

### 执行环境与开关

一个求值器只有一个执行环境。`codeGeneration` 开关关闭（默认）时这样创建：

```ts ignore-check
const runtimeContext = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
```

- Node 全局对象按 `vm-script` 的 `createScriptContext` 同样的规则复制进来：主环境 `globalThis` 上、新环境没有的自有属性逐个复制，`global` 指向新环境自身。这几行在求值器文件里单独写一份，不改 [vm-script.ts](../../../../packages/ptc-runtime/ptc-runtime-node/src/evaluators/vm-script.ts)。
- `tools`、绑定错误类、`console`、`process` 仍由子进程在每次执行前写到 `evaluator.globals`，也就是 `runtimeContext`。
- 沙箱对象没有原型，和 vm-script、AsyncFunction 两个求值器一样，全局查找因此不会经原型链走到主环境的 `Function`，例如 `constructor.constructor("…")()`。但复制进来的主环境值（`setTimeout`、`console`、`process`、工具命名空间等）的 `constructor` 仍是主环境的 `Function`，主环境没有 `codeGeneration` 限制，所以这个开关只限制执行环境自己的 `eval`、`Function` 和 WebAssembly，不构成隔离；隔离靠进程级沙箱。
- 只提供动态 `import()`，没有开关：每个 Script 都配 `importModuleDynamically`。不提供 `require`、`module` 和内置模块全局；宿主以这些名字注入的绑定原样可用。静态 `import` 不支持。
- 生成的文件名是 `<目录>/.ptc-repl-<序号>.js`，这个路径上没有真实文件，文件名用点开头的隐藏名。目录是求值器创建时的 working directory，也就是这个环境第一次调用时的目录，之后不再改变；默认加载器把文件名当作 `import()` 的引用方，所以相对路径的 import 固定按这个目录解析，目录部分不能省。以后需要跟随目录变化时，另加显式操作（例如 `js_switch_cwd`）。
- 绑定和 import 返回的值属于主环境，`instanceof Array` 这类跨环境判断可能为 false，和 REPL、`vm-script` 相同。

三个开关是求值器的创建参数，不是 Config 字段：

```ts ignore-check
interface ScopedReplEvaluatorOptions extends ProgramEvaluatorOptions {
  /** Force strict mode for every program; when off, a program's own leading "use strict" decides. Defaults to true. */
  strict?: boolean
  /** Allow eval, new Function and WebAssembly compilation inside the program context; defaults to false. */
  codeGeneration?: boolean
  /** Use the last top-level expression statement as the completion value; defaults to true. */
  finalExpression?: boolean
}
```

| 开关 | 打开时 | 关闭时 | 需要注意 |
|---|---|---|---|
| `strict`（默认开） | 整个 Script 以 `"use strict";` 开头，每次调用都按严格执行 | 不强制：程序以 `"use strict"` 指令开头时，在内层函数体最前面补一个 `"use strict";`，拷贝语句不会让它失效；否则按宽松执行 | 两种状态下 acorn 都按 script 规则扫描，严格模式的语法违规由 V8 编译时报出。关闭后，按宽松执行的调用里：给未声明的名字赋值会创建所有调用共用的全局变量，不走拷贝；顶层 `this` 是 `globalThis`；用严格模式保留字（如 `package`）声明的名字会让之后严格的调用编译失败，见"风险" |
| `codeGeneration`（默认关） | 创建执行环境时不加 `codeGeneration` 限制 | 按上面的代码创建 | 打开后，`eval` 里新声明的 `var` 不在扫描出的名单里，不会带到下一次；关闭时也只限制执行环境自己的代码生成，不构成隔离 |
| `finalExpression`（默认开） | 最后一条表达式改写成 `return { value: (…) }` | 不改写，末尾表达式的值被丢弃，结果为空 | 关闭后输出只能靠打印，模型说明和使用完成值的地方（例如 workflow-ptc）都要相应调整；顶层 `return` 在两种状态下都报错 |

接入时三个开关都取默认值；非默认值是设计上预留的用法，各自都有测试。

### 包装

每次调用编译成一个独立的 `vm.Script`。例如前面留下了 `a`（`const`）、`b`（`let`）、`v`（`var`），这次模型写了：

```js
let c = a + b
c * 2
```

实际编译的源码是：

```js
"use strict";(function (__$binding_vals, __$binding_getters) { return async function () { let a = __$binding_vals[0]; let b = __$binding_vals[1]; var v = __$binding_vals[2]; __$binding_getters.push(() => a, () => b, () => v, () => c);
let c = a + b
return { value: (c * 2) }
} })
```

| 部分 | 内容 | 原因 |
|---|---|---|
| `"use strict";` | `strict` 开关打开时，整个 Script 是 strict 模式；关闭时省略，程序以 `"use strict"` 开头时改为在内层函数体最前面补一个 | 打开时强制严格；关闭时保证前缀里的拷贝语句不会让模型写的指令失效 |
| 外层 `function (__$binding_vals, __$binding_getters)` | 接收拷贝进来的值和一个空数组，返回内层函数；由求值器同步调用 | 内部值通过闭包交给程序，不出现在程序的 `arguments` 里；外层在程序运行前就已返回，它的帧不会出现在程序的堆栈里 |
| 内层 `async function ()` | 模型程序就是它的函数体 | 支持顶层 `await`；顶层声明是函数的局部变量，每次调用互不冲突；不带接收者、零参数调用，所以 `this` 是 `undefined`（按宽松执行时是 `globalThis`），`arguments` 是一个空的 arguments 对象 |
| 拷贝声明 | 只给"前面有、本次没声明或只用 `var` 重新声明"的名字生成，值按下标从 `__$binding_vals` 取 | 下标访问不受 `__proto__` 这类名字影响 |
| `__$binding_getters.push(...)` | 在模型代码之前，按求值器生成前缀时的名字顺序，给每个名字（拷贝来的和本次声明的）推入一个读取函数 | 求值器知道第 i 个读取函数对应第 i 个名字，前缀里不用写名字字符串；读取函数可以先建好、以后再读，声明还没初始化完时读取会抛错 |
| 最后一条表达式 | 语句前插入 `return `，表达式前插入 `{ value: (`，表达式后插入 `) }` | 和 Node 的 `processTopLevelAwait` 处理最后一条语句的方式相同；外包一层对象，返回的 Promise 不会被 async 函数自动等待 |
| 前缀单独占第 0 行 | 编译时 `lineOffset: -1` | 模型代码第 N 行就报告为第 N 行 |
| 收尾另起一行 | `} })` | 模型代码最后一行可能以 `//` 注释结尾 |

拷贝语句在本次没有声明这个名字、或者只用 `var` 重新声明它时生成；本次用 `let`、`const`、`class`、`function`（包括 `const`）声明了它，就没有这行，以本次的声明为准。生成时的关键字：

| 情况 | 前缀里生成 |
|---|---|
| 本次没有声明，前面是 `let`、`const`、`function`、`class` | `let` |
| 本次没有声明，前面是 `var` | `var` |
| 本次只用 `var` 重新声明 | `var` |

拷贝语句只负责把旧值带进来，写成 `const` 唯一的效果是禁止之后的调用赋值，所以前面的 `const` 也拷成 `let`：之后的调用可以直接给它赋值，改的只是拷贝；声明它的那次调用里它仍是 `const`。不判断这次调用是否真的赋值，所以不需要遍历语法树，也不打印警告。

只用 `var` 重新声明时也生成拷贝：同一个函数里重复的 `var` 声明是同一个变量，所以这次的 `var` 从旧值开始，没执行到的声明不会把旧值换成 `undefined`，和 node:repl 里全局 `var` 的行为一致。同一次里同名的 `function` 在函数开头就初始化，优先于 `var`，这时不生成拷贝。

编译与运行：

```ts ignore-check
// Kernel: ScopedReplScopes.compile
const factory = new Script(source, { filename, lineOffset: -1, ...importOption }).runInContext(context) as ScopedReplFactory
const getters: (() => unknown)[] = []
const program = factory(values, getters)
this.compiled = { bindings, getters, replaced }
return program

// Evaluator: evaluate
const filename = resolve(baseDirectory, `.ptc-repl-${++submissions}.js`) // baseDirectory: process.cwd() at creation
const program = scopes.compile(code, { filename, context, finalExpression, ...importOption })
const start = Reflect.apply.bind(undefined, program, undefined, []) as ScopedReplProgram
void programDomain.run(() => Promise.resolve().then(start)).then(
  (completion) => { finish({ ok: true, value: completion?.value }) },
  (error: unknown) => { finish({ ok: false, error }) },
)
```

- 内核编译时固定给出 `filename` 和 `lineOffset: -1`；求值器总是传 `importModuleDynamically`：有 import 处理器时用 `VmModuleImportLoader.forFile(filename)`，没有时用 `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`。
- 程序由微任务直接调用，同步抛错时堆栈里没有求值器的帧。宿主用 `.then` 接结果、不用 `await`，否则 V8 会在堆栈末尾补一帧宿主的 async 帧。
- 已实测：`this` 是 `undefined`，`arguments.length` 是 0，同步抛错的堆栈只有程序自己的帧；domain 能接住这样启动的程序里定时器抛出的错误；外包对象里的 Promise 原样返回，不被等待。
- 代码里任何位置出现 `__$binding_`（包括字符串和注释），都报 `SyntaxError: Names starting with '__$binding_' are reserved`，位置指向第一次出现的地方，这次不执行。

### 内核：作用域链、acorn 扫描与编译

内核文件只依赖 acorn 和 `node:vm`，不依赖子进程和求值器，可以在普通 vm context 里连续编译、执行多段程序，单独测试作用域分层。接口：

```ts ignore-check
class ScopedReplScopes {
  constructor(options: { strict: boolean; onRedeclaration?: (redeclarations: readonly ScopedReplRedeclaration[]) => void })
  /** Scan and compile one program against the current bindings; throws SyntaxError and leaves the chain unchanged. */
  compile(code: string, options: { filename: string; context: Context; finalExpression: boolean; importModuleDynamically?: ScriptOptions['importModuleDynamically'] }): ScopedReplProgram
}
type ScopedReplProgram = () => Promise<{ value: unknown } | undefined>
interface ScopedReplRedeclaration { name: string; previous: ScopedReplBindingKind; current: ScopedReplBindingKind }
type ScopedReplBindingKind = 'var' | 'let' | 'const' | 'function' | 'class'
interface ScopedReplBinding { name: string; kind: ScopedReplBindingKind }
interface ScopedReplScan {
  /** Top-level bindings declared by the program, in source order. */
  declarations: ReadonlyMap<string, ScopedReplBindingKind>
  /** Whether the program starts with a "use strict" directive. */
  useStrict: boolean
  /** Last top-level statement when it is an expression statement. */
  finalExpression?: { statementStart: number; expressionStart: number; expressionEnd: number }
}
/** Parse once; throws a SyntaxError laid out like V8's for every error acorn reports. */
function scanProgram(code: string, options: { filename: string }): ScopedReplScan
/** Build the Script source and every binding in the order of the read functions it pushes. */
function buildProgramSource(
  code: string, scan: ScopedReplScan, carried: readonly ScopedReplBinding[], options: { strict: boolean; finalExpression: boolean },
): { source: string; bindings: ScopedReplBinding[] }
```

**解析方式**：不论 `strict` 开关，都调用 `parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true })`。这和 async 函数体的规则基本一致：顶层 `await` 合法，顶层 `return` 是语法错误，同一次里两个同名 `function`、同名的 `var` 和 `function` 都合法。不同的是顶层 `using`、`await using` 和静态 `import`、`export` 会被拒绝。扫描时不判断严格与否：开关打开时由 Script 开头的 `"use strict";` 决定，严格模式的语法违规由 V8 编译时报出。

解析之前先查两件事：程序以 `#!` 开头，或者代码里任何位置出现 `__$binding_`，就报错，不再解析。

**一次解析得到四样东西**：

1. 本次的顶层声明，只看顶层语句：

   | 顶层语句 | 收集的名字 | 记录的关键字 |
   |---|---|---|
   | `const`、`let`、`var` 声明，含解构（对象、数组、默认值、剩余元素） | 每个绑定名 | 原关键字 |
   | `function` 声明，含 async 和 generator | 函数名 | `function`；同一次里同名的 `var` 也记为 `function` |
   | `class` 声明 | 类名 | `class` |
   | `for (var …; …; …)`、`for (var … in/of …)` 括号里的 `var` | 每个绑定名 | `var` |
   | 块、`try`/`catch`/`finally`、`if`/`else`、循环体、`switch`、标签语句、`with` 里的 `var`，包括其中 `for` 括号里的 `var`；不进入函数和类 | 每个绑定名 | `var` |

2. 有没有顶层 `return`：acorn 直接报 `'return' outside of function`，并给出位置。
3. 最后一条语句：从后往前跳过空语句 `;`，找到的第一条如果是表达式语句，记下语句和表达式的起止位置。
4. 开头的指令里有没有 `"use strict"`：acorn 在指令语句上标出 `directive`，有就记下 `useStrict`。

不做的事：不进入嵌套的函数和类；块里只找 `var`，`let`、`const`、`class`、`function` 留在块里；不分析引用，不找赋值；除了最后一条表达式的三处插入，不改写代码。

**语法错误**：acorn 报错时直接抛 `SyntaxError`，不再交给 V8 编译。`stack` 按 V8 的样式排版：

```text
/work/.ptc-repl-3.js:1
const x = ;
          ^

SyntaxError: Unexpected token
```

- 消息取 acorn 的原文，去掉末尾的 `(行:列)`。
- 两处改用 V8 的说法：`'return' outside of function` 报 `Illegal return statement`；报错位置在代码末尾时报 `Unexpected end of input`。
- 代码里出现 `__$binding_` 时，按同样的样式报错，位置指向第一次出现的地方。

### 作用域链状态与每次调用的步骤

`ScopedReplScopes` 持有：

- `bindings: Map<string, { kind: ScopedReplBindingKind; read(): unknown }>`：当前可拷贝的名字和它们的读取函数。`kind` 是名字最近一次声明用的关键字；只是被拷贝的名字沿用之前记下的关键字，例如 `function` 拷贝成 `let` 后仍记为 `function`。
- `replaced: ReadonlyMap<string, { kind: ScopedReplBindingKind; value: unknown }>`：最近采用的那次程序重新声明的名字，在它编译时的旧值。
- `compiled`：最近一次编译的程序的绑定顺序、读取函数数组和它的 `replaced`。

每次 `compile(code, options)`：

1. 采用 `compiled`：读取函数数组的长度不少于名字个数，说明那次的前缀已经执行过，`bindings` 换成"第 i 个名字对应第 i 个读取函数"，`replaced` 换成它的值。子进程不允许两次执行重叠（`overlapping PTC evaluation`），上一次的前缀总在下一次编译之前的微任务里执行完；只有在一段同步代码里连续编译两次时，前一次才会因前缀还没执行而不被采用。
2. 扫描，得到本次声明和最后一条表达式的位置；语法错误直接抛出，状态不再变化。
3. 逐个调用 `bindings` 里的读取函数取当前值。读取抛错（声明没初始化完）就用 `replaced` 里的值；两边都没有，就丢掉这个名字。
4. 本次没声明、或只用 `var` 重新声明的名字作为拷贝，值放进 `values`；本次声明了的已有名字，把值记进新的 `replaced`，同时记一条重复声明 `{ name, previous, current }`。
5. 拼源码，然后编译。`strict` 关闭且 `useStrict` 为 true 时，内层函数体最前面加 `"use strict";`。V8 编译失败时抛出原生的 `SyntaxError`，裁掉错误标题之后的编译器内部帧（和 `vm-script` 做法相同，代码单独写一份），状态不再变化。
6. 有重复声明时调用 `onRedeclaration(redeclarations)`。
7. 调用外层函数拿到程序，记下 `compiled`，返回程序。

求值器每次 `evaluate(code, finish)`：

1. 提交序号加 1（包括有语法错误的提交），文件名是 `<创建时的目录>/.ptc-repl-<序号>.js`。
2. 调用 `scopes.compile`；抛错就用这个错误结束本次执行。
3. 在 domain 里由微任务启动程序；Promise 完成后调用 `finish`，结果取 `completion?.value`，不再等待。

读取发生在内核第 3 步，也就是新一次编译的时刻。之后前面的代码再给顶层变量赋值，改的只是它自己那次的变量。

### 失败的调用

| 第几次 | 代码 | 结果 |
|---|---|---|
| 1 | `const data = 1` | `data` 是 1 |
| 2 | `const data = await tools.fetch()`，`fetch` 抛错 | 失败；第 2 次的 `data` 声明了，但没赋上值 |
| 3 | `data` | 1：内核第 3 步读第 2 次的 `data` 时抛错，改用第 2 次编译时记下的旧值 |
| 4 | `let fresh = await tools.fetch()`，抛错 | 失败；`fresh` 是新名字 |
| 5 | `typeof fresh` | `"undefined"`：没有旧值，名字被丢掉 |

- 抛错之前已经执行完的声明保留。例如先执行了 `let y = 5` 再抛错，之后的调用里 `y` 仍是 5。
- `var` 重新声明从拷贝进来的旧值开始，读取不会抛错，也不需要退回：没执行到的 `var` 保留旧值。例如第 2 次在 `var v = 6` 之前就抛错，或者 `var config = await tools.loadConfig({})` 的工具调用失败，之后的调用读到的仍是之前的值。`function` 在函数开头就是新函数。

### 异步错误：对齐 REPL

REPL 用 Node 的 `domain` 接住程序启动的异步工作里抛出的错误。求值器照同样的做法：

- 创建求值器时调用 `domain.create()` 得到 `programDomain`，每个程序都在 `programDomain.run(...)` 里启动。程序创建的定时器、回调、Promise 后续步骤和 EventEmitter 都归属这个 domain。
- `programDomain.on('error', ...)` 把错误写成 `Uncaught ` 加错误文本，交给 `options.reportError`。错误文本取错误的 `stack`，`stack` 不是字符串时用"名字: 消息"；不用 `util.inspect` 格式化 Error，是因为 domain 会往错误对象上加 `domain`、`domainThrown`，inspect 会把它们一起打印出来。不是 Error 的值，先删掉这两个属性再用 `util.inspect`，和 node:repl 一样。
- 程序能让转换文字这一步抛错（`stack` 访问器、`toString`、自定义 inspect）。监听器里抛错会让 Node 结束进程，所以这一步包在 `try`/`catch` 里，出错时报 `program threw an unrenderable value`，和同步失败时 `prepareException` 的兜底文字相同。`reportError` 放在 `try` 外面，它是子进程自己的代码，出错应该照常暴露。
- 回调里 `throw` 冻结或不可扩展的对象时，Node 的 domain 在调用监听器之前给它加属性就失败了，进程结束，和 node:repl 相同。
- 子进程处理 `reportError` 的方式不变：当时有执行在运行，就让那次执行以这个错误失败；否则丢弃。错误按创建回调时所属的执行归属（AsyncLocalStorage）。
- 不在整个进程上注册 `uncaughtException` 或 `unhandledRejection`，子进程自身代码的错误仍然暴露。
- 程序调用工具时，子进程为这次调用创建的异步回调（例如 RPC 回调）也在程序的 domain 里：子进程自身代码在这些回调里的异步错误会被当成程序的 `Uncaught …` 报告，子进程继续运行、不退出。现有 REPL 求值器也是这样。

已验证的情况：

- REPL：定时器里抛错、未处理的 Promise rejection，在执行结束后和执行中都被接住；EventEmitter 的 `error` 事件在执行结束后被接住。
- 单独的 domain：在主环境里接住了定时器抛错、定时器里产生的 rejection、未被等待的 async 函数失败和 EventEmitter 的 `error` 事件；在带默认 `codeGeneration` 限制的执行环境里，接住了定时器抛错和定时器里产生的 rejection；由微任务启动的程序里，定时器抛错同样被接住。

### 动态 import

- 程序里的 `import()` 经过每个 Script 的 `importModuleDynamically`：没有 import 处理器时用 `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`，有处理器时用现有的 `VmModuleImportLoader.forFile(filename)`，和 `vm-script` 相同。
- 相对路径按求值器创建时的目录解析，也就是这个环境第一次调用时的 working directory；之后的调用换了目录也不变。node:repl 和 `vm-script` 跟随每次调用的目录；Agent 用 `working_directory` 换目录后，需要按新目录 import 时用绝对路径。
- 不提供 `require`：node:repl 的 `require` 解析规则不一致（相对路径跟随当前目录，但第一次解析后被缓存；包名固定按启动目录），只保留动态 `import()` 这一种加载方式。

### 重复声明提示（预留）

内核在第 6 步调用 `onRedeclaration`；求值器把自己的 `reportRedeclarations(redeclarations: readonly ScopedReplRedeclaration[])` 注入进去，函数体先留空，只加一行 `TODO` 注释，不输出任何内容。以后要提示时，在这里写入程序的 `console`，内容会进入模型可见的输出。

### 范围外

- 内存回收：不处理，每次拷贝全部名字。没有闭包存活的旧调用会被回收；某次调用留下了存活的函数时，这个函数会留住这次开始时拷贝进来的所有值。
- 跟随 working directory 变化解析 `import()`：以后需要时另加显式操作，例如 `js_switch_cwd`。
- `let`、`const`、`class` 重新声明的初始化表达式里读同名旧值（例如 `let count = count + 1`）：属于代码问题。
- `strict` 关闭时严格和宽松调用混用造成的问题，见"风险"：交给以后的重置工具。
- 最后一条表达式所在行的列号偏移。

### 接入

以 `scoped-repl` 格式接入时只做必需的改动，不顺手重构或复用现有代码，方便和其他进行中的 PTC 改动 rebase、合并。程序格式名是 `scoped-repl`，配置字段名是 `replScoped`。

| 位置 | 改动 |
|---|---|
| `ptc-runtime` 的 `PtcProgramFormat` | 包含 `'scoped-repl'` |
| `ptc-runtime-node` 的 `config.ts` | 布尔字段 `replScoped`，默认 false，只能和 `persistent-in-memory` 一起用，否则加载时报错 |
| `ptc-runtime-node` 的 `execution.ts` | `persistent-in-memory` 分支里 `replScoped` 为 true 时：格式 `scoped-repl`，`retainsState` 为 true，TypeScript 按 REPL 语句擦除，配一段新的模型说明 |
| `ptc-runtime-node` 的 `evaluators/index.ts` | 求值器表含 `scoped-repl`，三个开关取默认值 |
| `ptc-runtime-node` 的 `protocol.ts` | 协议版本是 3，旧 bootstrap 在就绪阶段报错；升级指南 `docs/upgrade-guide/v0.2.2-rc.1/ptc-bootstrap-protocol/` 同时说明 `PtcProgramFormat` 新增的成员 |
| workflow-ptc 的 `host.ts` | `scoped-repl` 用和 `repl` 一样的包装 `await (async () => {…})()` |
| `ptc-runtime-node` 的 `configuration.ts`（CUA 用它合并配置） | `resolvePersistentExecution` 返回 `executionMode`、`scriptPersistence`、`replScoped` 三个字段，一起合并：`scoped-repl` 对应 `replScoped: true`，其余格式为 `false`，覆盖 profile 里残留的值 |
| 文档、快照和测试 | 包 README 的配置项、行为说明和"已知限制"、config catalog、快照场景 `ptc-scoped-repl`；构建产物的 e2e 含 `replScoped: true` 用例 |

tool-executor-ptc 没有改动：格式不是 `function-body` 时，它自动使用"打印输出"那套说明。模型说明写明上面的精确行为，尤其是：输出用 `inspect(...)`，这句和其他模式共用；不支持顶层 `return`；每次调用开始时拷贝、旧代码不受影响；需要共享的可变状态放进对象；不声明直接赋值只改拷贝，前面的 `const` 也可以这样赋值；`let`、`const`、`class` 重新声明的初始化表达式读不到同名旧值，要在旧值上计算就直接赋值或换个名字；`var` 重新声明从旧值开始；调用中途失败时，没执行完的 `let`、`const`、`class`、`var` 重新声明保留旧值；块里的 `var` 也算这次调用的顶层名字，其他块里的声明只属于它的块；只能用 `import()`，相对路径按这个环境第一次调用的目录解析。测试整段逐字比对模型说明。

## 考虑过的替代方案

**用直接 eval 把每次调用嵌进上一次的作用域。** 前后调用能共享活的绑定，但旧作用域永远无法回收，行列号要靠 source map 或改写堆栈才能对上；在禁止从字符串生成代码的执行环境里，直接 eval 也不可用。

**把声明改写成 `var` 或全局赋值。** 所有调用共用同一个绑定，违反要求 2，而且要改写模型代码。

**每次调用编译成一个 ES 模块。** 靠合成一个代表上一次调用的模块和追加的 `export` 传值。模块里既不能 `return`，也没有末尾表达式的值，前置代码还会让报错行号整体偏移；函数参数已经能传值，不需要模块。

**作用域分析加改写引用。** 能做更精细的内存回收，但需要作用域分析并改写代码，违反要求 5。

**只用打印输出、不支持末尾表达式。** workflow-ptc 和 `repl` 格式的约定都依赖完成值，也偏离现有 REPL 的写法。

**用顶层 `return` 给出结果。** 与要求 3 冲突，需要换成函数体格式，run_code 的说明也会随之变化。

**末尾的 Promise 等它完成。** 和 `vm-script` 一致，但和现有 REPL 不一致；按 Node 的写法外包一层对象，保持 REPL 的行为。

**以 `if`、`for`、块结尾时也给出结果。** 只有在 Script 顶层执行时才有 V8 的完成值，函数体里拿不到；要支持就得改写更多语句。node:repl 在代码含 `await` 时同样没有结果。

**包装直接写成 `async function (__$binding_vals, __$binding_getters)`。** `this` 同样是 `undefined`，但程序的 `arguments` 里能看到这两个内部值，长度是 3。

**包装用 async 箭头函数。** `this` 是 `globalThis`、没有 `arguments`，和 REPL 一致；我们选择 strict 模式下不带接收者调用函数时的 `undefined`。

**用回调交出读取函数。** 前缀里要写名字字符串，还要防止程序重复调用；推入数组、由求值器按下标对应名字更简单。

**语法错误交给 V8 再编译一次。** 能拿到 V8 原文的消息，但要多编译一次；acorn 已经给出位置和消息，直接报。

**strict 开启时按 module 规则扫描。** module 规则比 async 函数体严：同一次里两个同名 `function`、同名的 `var` 和 `function`、嵌套的普通函数里把 `await` 当变量名都会被拒绝，HTML 注释的处理也和 V8 编译 Script 时不一致。strict 关闭时也用不了，因为 module 规则一律是 strict 的。

**套上和运行时一样的函数外壳再扫描。** 和运行时的语法完全一致，顶层 `using` 也能用，Node 的 `processTopLevelAwait` 就是这样做的。但要自己遍历语句查找顶层 `return`，换算外壳带来的位置偏移，还要防止代码里多出的 `}` 提前关闭外壳；我们不需要顶层 `using`，script 规则更简单。

**只把被赋值的 `const` 拷成 `let`，并打印警告。** 要遍历新调用的语法树并判断遮蔽，属于作用域分析，违反要求 5。我们一律拷成 `let`，不提示。

**`var` 重新声明不拷贝旧值，从 `undefined` 开始。** `var count = count + 1` 得到 `NaN`；但抛错前没执行到、或在没走到的分支里的 `var` 会把旧值换成 `undefined`，例如工具调用失败的 `var config = await tools.loadConfig({})` 让之后的调用拿不到原来的 `config`。拷贝旧值后，`var count = count + 1` 在旧值上加 1，和 node:repl 一致，暂时接受。

**只在调用失败、且读到 `undefined` 时退回旧值。** 不用拷贝，但分不出"没执行到"和"执行了、值就是 `undefined`"：赋上 `undefined` 之后同一次又失败时，会误退回旧值；成功调用里没走到的分支和不带初始值的 `var x;` 也覆盖不到。

**在代码里插标记，记录 `var` 是否执行到。** 能准确区分，但要在声明处、声明前的赋值和循环头改写模型代码，违反要求 5。

**严格的调用里跳过严格模式保留字的拷贝。** 能避免宽松调用里声明的 `package` 这类名字让之后严格的调用编译失败；但这是模型混用两种模式造成的，不处理，交给以后的重置工具。

**在整个进程上监听未捕获的错误。** 会把子进程自身代码的错误一起吞掉；REPL 用 domain，只接程序启动的异步工作。

**不收集块里的 `var`。** 块里的 `var` 会和拷贝语句撞名，整段程序报 `already declared`，这个名字也带不到之后的调用；收集它只需约 15 行语句遍历，不分析引用，所以采用收集。

**堆栈里只显示 `.ptc-repl-<序号>.js`，不带目录。** 文件名去掉目录后，默认加载器按导入那一刻的 cwd 解析相对 `import()`，和有 import 处理器时不一致；用 `//# sourceURL` 只显示短名时，V8 不再应用 `lineOffset`，每个行号多 1；把 import 交给回调函数可以解决：子进程两种启动方式都带 `--experimental-vm-modules`，回调可以在第一次调用的目录下发起 `import()`；但这要求 scoped-repl 总是走回调形式的 import，默认路径现在没有走，所以文件名暂时保留第一次调用的目录。

**提供 `require`、`module` 和内置模块全局（node:repl 做法）。** node:repl 的 `require` 解析规则不一致，跟随目录又要定义何时换基准；只保留 `import()`。

## 影响

得到的：

- 后面的调用可以用任意关键字再次声明前面的名字，前面的函数、闭包和仍在运行的代码继续使用原来的值。
- 写法、结果、报错和异步错误处理与现有 REPL 一致，程序的异步错误不让进程退出。
- 不做作用域分析；除了最后一条表达式的三处插入，不改写模型代码。

付出的：

- "开始时拷贝"和 REPL 不同：前面的代码（定时器、回调）之后再给顶层变量赋值，后面的调用看不到；模型说明写明了这一点。
- 不声明直接赋值只影响之后的调用，前面定义的函数看不到；REPL 里两边会一起变。
- strict 模式和 REPL 不同：REPL 里给未声明的名字赋值会创建全局变量，这里会报错。
- 调用方不丢弃完成值时，末尾是没写 `await` 的 Promise，宿主报"不是 JSON"，和现有 REPL 一样；`run_code` 丢弃完成值，不受影响。
- 以 `if`、`for`、块结尾的程序没有结果，node:repl 在代码不含 `await` 时有。
- 最后一条表达式所在行，插入点之后的列号右移 17。
- 语法错误消息是 acorn 的文字，和 V8 原文不同，例如 `Unexpected token` 而不是 `Unexpected token ';'`。
- 扫描统一按 script 规则：顶层 `using`、`await using` 会被拒绝，node:repl 也不支持。
- 顶层 `arguments` 是一个空的 arguments 对象，node:repl 里它不存在。
- 执行环境默认禁止从字符串生成代码：依赖 `eval` 或 `new Function` 的代码会失败，包括经 import 处理器加载到这个执行环境的库。这个限制不构成隔离，复制进来的主环境函数（例如 `setTimeout.constructor`）仍能生成代码。
- 不提供 `require`：依赖 `require` 的代码要改用 `await import()`。
- 相对路径的 `import()` 固定按这个环境第一次调用时的目录解析，Agent 换目录后仍按旧目录。
- Node 文档把 `domain` 标为已弃用；node:repl 仍建立在它上面，如果 Node 移除它，REPL 也会一起变。
- 子进程自身代码在工具调用的异步回调里出错时，会被当成程序的 `Uncaught …` 报告，子进程继续运行，和现有 REPL 相同。
- 以 `#!` 开头的程序被拒绝。
- 代码里任何位置出现 `__$binding_`（包括字符串、注释）都会被拒绝；用 `\u005f` 这类转义写出的内部名不在检查范围内。
- acorn 必须跟上 V8 支持的语法，否则较新的语法会被拒绝执行。
- `var` 重新声明从旧值开始：`var count = count + 1` 在旧值上加 1，和 node:repl 一致；即使前面是 `let`、`const` 也是这样，node:repl 在这种情况下报 `already declared`。
- `let`、`const`、`class` 重新声明的初始化表达式读不到同名旧值，会报错，例如 `let count = count + 1`。属于代码问题，不处理。
- 前面的 `const` 在之后的调用里一律拷成 `let`，可以被赋值，而且没有提示。
- `strict` 关闭时，严格和宽松的调用可以混用：宽松调用里给未声明的名字赋值，会创建所有调用和旧函数共用的全局变量；宽松调用里用严格模式保留字（`package`、`public`、`private`、`protected`、`interface`、`implements`、`static`、`let`、`yield`、`eval`、`arguments`）声明的名字，会让之后严格的调用编译失败。不处理，交给以后的重置工具。
- 回调里 `throw` 冻结或不可扩展的对象时，Node 的 domain 处理本身出错，进程结束，保留的变量丢失，和 node:repl 相同。
- 每次调用都要为前面所有名字生成拷贝声明和读取函数：原型实测 1000 个名字时约 10 ms/次。
- 某次调用留下存活的函数时，这次拷贝进来的所有值都会一直留在内存里。

## 测试

- 内核测试单独运行即可通过，覆盖：script 规则解析和开头 `"use strict"` 的检测、声明表里的每种语句、顶层 `return`（包括块里的）、最后一条表达式的定位与插入、以 `#!` 开头的程序、代码里出现 `__$binding_`、语法错误的排版和两处消息替换、拼出的源码；`strict` 关闭时，程序开头的 `"use strict"` 在有拷贝和没有拷贝时都生效；并在普通 vm context 里连续执行多段程序，覆盖"跨次调用"里的每一条，包括各种关键字组合、失败的调用、定时器、函数重定义和重复声明通知。
- 求值器测试直接使用求值器和真实的 vm 执行环境，覆盖"写法与结果""执行环境""报错""异步错误与生命周期"里的每一条，以及经求值器的跨次调用；包括经全局对象的原型链拿不到主环境的 `Function`、复制进来的主环境函数（例如 `setTimeout.constructor`）仍能生成代码，以及宿主以 `module`、`require` 为名的绑定原样保留。
- 三个开关各自在打开和关闭时都有测试。
- 顶层 `this` 是 `undefined`、`arguments.length` 是 0，同步抛错的堆栈只有程序自己的帧。
- 异步错误：上面列出的每种情况在执行结束后和执行中各测一次，交给 `reportError` 的文本以 `Uncaught ` 开头；进程不退出，变量保留。`stack` 为空、读取 `stack` 抛错、自定义 inspect 抛错时，分别报"名字: 消息"和固定文本，进程不退出；抛出普通对象时报错里没有 `domainThrown`。
- import：默认加载器和 import 处理器两条路径，相对路径按创建时的目录解析，之后换了目录也不变。
- 构建产物的 e2e 覆盖 `replScoped: true`。
- 新文件覆盖率 100%；现有求值器及其测试不变。
