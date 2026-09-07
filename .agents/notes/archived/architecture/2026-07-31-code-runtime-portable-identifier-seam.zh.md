# Agent Note: code-runtime seam 拥有可移植标识符排除集

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-code-runtime-portable-identifier-seam.md) | 中文

## Problem

code-runtime seam 承诺：在一个后端上有效的绑定命名空间列表，在每个后端上都有效，因此 PTC mode 消费方可以把同一组绑定交给任何已注册的运行时，而不必知道它的语言。首个后端 `dsh-code-runtime-worker-thread` 私自拥有了执行这项承诺一部分的标识符规则：一个允许 JS 专有 `$` 的 `IDENTIFIER` 正则、一个只含 ECMAScript 关键字的 `RESERVED_WORDS` 集合，以及一个含三个 JS `Error` 槽位的 `RESERVED_ERROR_PROPERTIES` 集合。这些规则描述的是 worker 自身的语言，而非 seam 的可移植性约定。

一个针对不同语言（CPython）编写的第二后端，要么重新声明自己的规则——让 `lambda` 通过 worker 却在 Python 上失败，或让 `$tools` 通过 worker 却在每个非 JS 后端上失败——要么导入 worker 的规则，从而反转依赖，使一个 Service Provider 伸手进入另一个兄弟 Service Provider。二者都无法让可移植承诺成真：它只对调用方恰好测试过的那个后端成立。

## Decision

Service Definition 包（`@deepseek-ai/dsh-code-runtime`）以四个具名常量导出可移植标识符排除约定，每个 Service Provider 导入它们而非重新声明：

- `PORTABLE_RESERVED_WORDS`——ECMAScript 与 Python 保留字的联集。任何命名空间 global 或 error-class 名称匹配其中之一，都在所有后端上被拒绝，因此 `lambda` 即便是合法的 JS 参数名也被拒绝。新增一门语言即扩宽此联集，这是对现有绑定名称的一次有意的破坏性复审。
- `RESERVED_BINDING_GLOBALS`——某个后端在程序命名空间中拥有的 global：`console`（worker 的日志捕获）、`__dsh_main__`/`__builtins__`/`__name__`（Python bootstrap 的包装器与预置模块 global），以及 `__debug__`（不是 seed 的槽位，而是 CPython 编译期常量，赋值会被拒，故以该名注入的 global 不可达——同一种可移植性分裂，只是机制不同）。在所有后端上被拒绝，使命名空间列表无法选到一个在某后端能用、在另一后端冲突的名称。
- `RESERVED_ERROR_MEMBERS`——每个后端都拒绝的 error-member 名称：JS `Error` 槽位（`name`、`message`、`stack`）与 Python 异常协议成员（`args`、`with_traceback`、`add_note`）。
- `DUNDER_MEMBER`——dunder 形式正则（`__x__`，非空中缀），作为 error member 被整体拒绝，因为其中若干是受约束的 CPython 描述符，其确切集合是解释器版本细节。

Service Definition 同时把可移植标识符子集收窄为 `[A-Za-z_][A-Za-z0-9_]*`（记录在 `CodeBindingNamespace.global` 与 `CodeBindingErrorClass` 上），去掉 JS 专有的 `$`。worker 直接以这些常量的导出名称消费它们——binding-global 与 error-class 名称用 `PORTABLE_RESERVED_WORDS`、后端拥有槽位用 `RESERVED_BINDING_GLOBALS`、error member 用 `RESERVED_ERROR_MEMBERS` 加 `DUNDER_MEMBER`——不再本地起别名；其 `IDENTIFIER` 正则去掉 `$`。

尽管 worker 是唯一已交付的后端，这些常量仍置于 Service Definition：要点正是该约定与语言无关，且由高于任何单一语言的层级拥有。违反它的 Service Provider 才是 bug，而共享集合正是复审者查看「可移植」含义的地方。

## Scope

本决策交付 Service Definition 扩展与 worker-thread 后端对它的采用。`py-types` 渲染器与 PTC mode 的语言分发归[语言分发 note](../feature/2026-07-31-ptc-language-dispatch.zh.md)所有。私有的实验性 CPython 子进程后端（`dsh-experimental-code-runtime-python`）采用同一 portable-identifier 契约。

`RESERVED_BINDING_GLOBALS` 先于后端本身编码了 Python bootstrap 的具体设计：它恰好 seed `__builtins__`/`__name__`，并把程序包装在 `__dsh_main__` 之下。任何 seed 额外模块 global（`__doc__`、`__loader__`、`__spec__`、`__file__`、`__package__` 等）的 Python 后端必须在同一改动中扩宽此集合，正如新增一门语言即扩宽 `PORTABLE_RESERVED_WORDS`——bootstrap 会 seed 却不在集合中的名称，正是本约定要防止的可移植性分裂。

## Alternatives considered

**每个后端声明自己的排除集。** 拒绝：这让可移植承诺变成逐后端成立。调用方在 worker 上测过的绑定列表可能被 Python 拒绝，而这正是 seam 存在要防止的分裂。

**Python 后端导入 worker 的常量。** 拒绝：这反转依赖——seam 的 Service Provider 会为一个二者都不拥有的约定伸手进入兄弟实现。约定属于二者之上，即 seam。

**在可移植标识符子集中保留 `$`。** 拒绝：`$` 是 JS 专有拼写。允许它会让 `$tools` 通过 worker 却在每个非 JS 后端上失败，为纯粹表面的好处破坏可移植性。

## Consequences

获得：一个地方——Service Definition 包——定义什么是可移植绑定名称，每个后端通过导入执行同一约定。在一个后端上有效的命名空间列表在所有后端上都有效，这是可验证的，而非取决于调用方测试了哪个后端的巧合。

代价：现有使用含 `$` global 的 worker 调用方现在会在标识符校验时失败。在预发布立场下这是对基础设计的一次纠正，而非需要 shim 的兼容性破坏。worker 的 Service Definition misuse 测试新增了 `$tools`、Python 异常成员（`args`）、dunder（`__dict__`）与一个 Python 拥有的 global（`__dsh_main__`）等用例，从 worker 侧证明共享集合被执行。
